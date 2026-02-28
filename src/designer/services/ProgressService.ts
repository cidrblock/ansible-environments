/**
 * Ansible Content Designer - Progress Service
 * 
 * Manages phase progress, sign-offs, and cascading invalidation.
 */

import type { 
    Phase, 
    PhaseStatus, 
    PhaseProgress,
    SignOff,
    InvalidationResult,
    ProjectProgress,
    PhaseProgressWithSignOff
} from '../types/designer';
import { DesignerDatabase } from '../database/DesignerDatabase';

/**
 * Phase order for determining next/previous phases
 */
const PHASE_ORDER: Phase[] = ['intake', 'assessment', 'planning', 'building', 'complete'];

/**
 * ProgressService - Manages workflow progress and phase transitions
 */
export class ProgressService {
    private _db: DesignerDatabase;

    constructor(db: DesignerDatabase) {
        this._db = db;
    }

    // ========================================================================
    // Progress Retrieval
    // ========================================================================

    /**
     * Get overall project progress
     */
    public getProjectProgress(): ProjectProgress {
        // Get current phase from project table
        const project = this._db.get<{ phase: Phase }>(`
            SELECT phase FROM project WHERE id = 1
        `);
        
        const currentPhase = project?.phase || 'intake';

        // Get all phase progress
        const phases = this.getAllPhaseProgress();

        // Calculate overall progress (0-100)
        const completedPhases = phases.filter(p => p.status === 'complete').length;
        const overallProgress = Math.round((completedPhases / PHASE_ORDER.length) * 100);

        // Determine if we can proceed
        const currentPhaseProgress = phases.find(p => p.phase === currentPhase);
        const canProceed = currentPhaseProgress?.blocker_count === 0 && 
                          currentPhaseProgress?.status !== 'blocked';

        // Determine next action
        let nextAction = 'Continue with current phase';
        if (currentPhaseProgress?.status === 'blocked') {
            nextAction = `Resolve ${currentPhaseProgress.blocker_count} blocker(s)`;
        } else if (currentPhaseProgress?.status === 'complete') {
            const nextPhase = this.getNextPhase(currentPhase);
            if (nextPhase) {
                nextAction = `Proceed to ${nextPhase}`;
            } else {
                nextAction = 'Project complete!';
            }
        }

        return {
            currentPhase,
            phases,
            overallProgress,
            canProceed,
            nextAction
        };
    }

    /**
     * Get progress for all phases with sign-off info
     */
    public getAllPhaseProgress(): PhaseProgressWithSignOff[] {
        const progress = this._db.all<PhaseProgress>(`
            SELECT * FROM phase_progress ORDER BY 
                CASE phase 
                    WHEN 'intake' THEN 0 
                    WHEN 'assessment' THEN 1 
                    WHEN 'planning' THEN 2 
                    WHEN 'building' THEN 3 
                    WHEN 'complete' THEN 4 
                END
        `);

        return progress.map(p => this._enrichPhaseProgress(p));
    }

    /**
     * Get progress for a single phase
     */
    public getPhaseProgress(phase: Phase): PhaseProgressWithSignOff | undefined {
        const progress = this._db.get<PhaseProgress>(`
            SELECT * FROM phase_progress WHERE phase = ?
        `, phase);

        return progress ? this._enrichPhaseProgress(progress) : undefined;
    }

    /**
     * Enrich phase progress with sign-off info and blockers
     */
    private _enrichPhaseProgress(progress: PhaseProgress): PhaseProgressWithSignOff {
        // Get latest valid sign-off for this phase
        const signOff = this._db.get<SignOff>(`
            SELECT * FROM sign_offs 
            WHERE phase = ? AND revoked_at IS NULL
            ORDER BY signed_off_at DESC 
            LIMIT 1
        `, progress.phase);

        // Parse blocker summary
        let blockers: string[] = [];
        if (progress.blocker_summary) {
            try {
                blockers = JSON.parse(progress.blocker_summary);
            } catch {
                blockers = [progress.blocker_summary];
            }
        }

        return {
            ...progress,
            blockers,
            signedOff: !!signOff,
            signedOffAt: signOff?.signed_off_at,
            signedOffBy: signOff?.signed_off_by
        };
    }

    // ========================================================================
    // Phase Transitions
    // ========================================================================

    /**
     * Advance to the next phase
     * 
     * @param currentPhase - The phase to complete
     * @param actor - Who is signing off
     * @throws Error if blockers remain or phase not completable
     */
    public advancePhase(currentPhase: Phase, actor: string): void {
        const progress = this.getPhaseProgress(currentPhase);
        
        if (!progress) {
            throw new Error(`Phase not found: ${currentPhase}`);
        }

        if (progress.blocker_count > 0) {
            throw new Error(`Cannot advance: ${progress.blocker_count} blocker(s) remaining`);
        }

        if (progress.status === 'locked') {
            throw new Error(`Cannot advance: phase is locked`);
        }

        this._db.transaction(() => {
            // Create sign-off
            this._db.run(`
                INSERT INTO sign_offs (phase, signed_off_by)
                VALUES (?, ?)
            `, currentPhase, actor);

            // Mark current phase complete
            this._db.run(`
                UPDATE phase_progress 
                SET status = 'complete', completed_at = CURRENT_TIMESTAMP
                WHERE phase = ?
            `, currentPhase);

            // Unlock next phase
            const nextPhase = this.getNextPhase(currentPhase);
            if (nextPhase) {
                this._db.run(`
                    UPDATE phase_progress 
                    SET status = 'in_progress', started_at = CURRENT_TIMESTAMP
                    WHERE phase = ?
                `, nextPhase);

                // Update project's current phase
                this._db.run(`
                    UPDATE project SET phase = ? WHERE id = 1
                `, nextPhase);
            }

            // Log to history
            this._db.logHistory('phase_advance', 'phase', currentPhase, actor, {
                from: currentPhase,
                to: nextPhase
            });
        });
    }

    /**
     * Get the current project phase
     */
    public getCurrentPhase(): Phase {
        const project = this._db.get<{ phase: Phase }>(`
            SELECT phase FROM project WHERE id = 1
        `);
        return project?.phase || 'intake';
    }

    /**
     * Get the next phase in sequence
     */
    public getNextPhase(phase: Phase): Phase | undefined {
        const idx = PHASE_ORDER.indexOf(phase);
        return idx >= 0 && idx < PHASE_ORDER.length - 1 
            ? PHASE_ORDER[idx + 1] 
            : undefined;
    }

    /**
     * Get the previous phase in sequence
     */
    public getPreviousPhase(phase: Phase): Phase | undefined {
        const idx = PHASE_ORDER.indexOf(phase);
        return idx > 0 ? PHASE_ORDER[idx - 1] : undefined;
    }

    // ========================================================================
    // Cascading Invalidation
    // ========================================================================

    /**
     * Invalidate all phases from a given phase onwards
     * 
     * This is called when a significant change is made to a phase
     * (e.g., requirement edited after assessment sign-off)
     * 
     * @param fromPhase - The phase where the change occurred
     * @param actor - Who triggered the invalidation
     * @param reason - Why invalidation was triggered
     * @returns Which phases were invalidated
     */
    public invalidateFromPhase(
        fromPhase: Phase, 
        actor: string, 
        reason: string
    ): InvalidationResult {
        const fromIdx = PHASE_ORDER.indexOf(fromPhase);
        const phasesToInvalidate = PHASE_ORDER.slice(fromIdx + 1);
        const invalidated: Phase[] = [];
        let artifactsMarkedStale = false;

        this._db.transaction(() => {
            for (const phase of phasesToInvalidate) {
                const progress = this.getPhaseProgress(phase);
                
                // Only invalidate if phase was in_progress or complete
                if (progress && ['in_progress', 'complete'].includes(progress.status)) {
                    // Revoke any sign-offs
                    this._db.run(`
                        UPDATE sign_offs 
                        SET revoked_at = CURRENT_TIMESTAMP,
                            revoked_by = ?,
                            revoke_reason = ?
                        WHERE phase = ? AND revoked_at IS NULL
                    `, actor, reason, phase);

                    // Reset phase status
                    this._db.run(`
                        UPDATE phase_progress 
                        SET status = 'locked',
                            completed_at = NULL
                        WHERE phase = ?
                    `, phase);

                    invalidated.push(phase);
                }
            }

            // If building phase was invalidated, mark artifacts as stale
            if (invalidated.includes('building')) {
                this._db.run(`
                    UPDATE artifacts 
                    SET stale = TRUE,
                        stale_reason = ?,
                        stale_since = CURRENT_TIMESTAMP
                    WHERE stale = FALSE
                `, reason);
                
                artifactsMarkedStale = true;
            }

            // Log the invalidation
            this._db.logHistory('cascade_invalidation', 'phases', undefined, actor, {
                trigger_phase: fromPhase,
                invalidated_phases: invalidated,
                reason,
                artifacts_staled: artifactsMarkedStale
            });
        });

        return { invalidated, artifactsMarkedStale };
    }

    // ========================================================================
    // Progress Updates
    // ========================================================================

    /**
     * Update item counts for a phase
     */
    public updatePhaseCounts(
        phase: Phase, 
        total: number, 
        completed: number, 
        pending: number
    ): void {
        this._db.run(`
            UPDATE phase_progress 
            SET total_items = ?, completed_items = ?, pending_items = ?
            WHERE phase = ?
        `, total, completed, pending, phase);
    }

    /**
     * Set blockers for a phase
     */
    public setBlockers(phase: Phase, blockers: string[]): void {
        const blockerCount = blockers.length;
        const blockerSummary = blockers.length > 0 ? JSON.stringify(blockers) : null;
        const status: PhaseStatus = blockerCount > 0 ? 'blocked' : 'in_progress';

        this._db.run(`
            UPDATE phase_progress 
            SET blocker_count = ?,
                blocker_summary = ?,
                status = CASE 
                    WHEN status = 'complete' THEN status 
                    WHEN status = 'locked' THEN status
                    ELSE ?
                END
            WHERE phase = ?
        `, blockerCount, blockerSummary, status, phase);
    }

    /**
     * Mark a phase as in progress
     */
    public startPhase(phase: Phase): void {
        this._db.run(`
            UPDATE phase_progress 
            SET status = 'in_progress',
                started_at = COALESCE(started_at, CURRENT_TIMESTAMP)
            WHERE phase = ? AND status IN ('available', 'locked')
        `, phase);
    }

    /**
     * Check if a phase can be started
     */
    public canStartPhase(phase: Phase): { allowed: boolean; reason?: string } {
        // First phase is always available
        if (phase === 'intake') {
            return { allowed: true };
        }

        // Check if previous phase is complete and signed off
        const prevPhase = this.getPreviousPhase(phase);
        if (!prevPhase) {
            return { allowed: true };
        }

        const prevProgress = this.getPhaseProgress(prevPhase);
        if (!prevProgress) {
            return { allowed: false, reason: 'Previous phase not found' };
        }

        if (prevProgress.status !== 'complete') {
            return { 
                allowed: false, 
                reason: `Previous phase (${prevPhase}) must be completed first` 
            };
        }

        if (!prevProgress.signedOff) {
            return { 
                allowed: false, 
                reason: `Previous phase (${prevPhase}) requires sign-off` 
            };
        }

        return { allowed: true };
    }
}
