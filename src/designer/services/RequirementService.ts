/**
 * Ansible Content Designer - Requirement Service
 * 
 * CRUD operations for requirements with validation and cascading invalidation.
 * 
 * Note: Simplified to remove priority and implied artifacts.
 * The agent determines what to build based on the requirement description.
 */

import type { 
    Requirement, 
    RequirementStatus,
    EnrichedRequirement,
    DesignDecision
} from '../types/designer';
import { DesignerDatabase } from '../database/DesignerDatabase';
import { ProgressService } from './ProgressService';

/**
 * Input for creating a new requirement
 */
export interface CreateRequirementInput {
    description: string;
    tags?: string[];
    createdBy?: string;
}

/**
 * Input for updating a requirement
 */
export interface UpdateRequirementInput {
    description?: string;
    tags?: string[];
}

/**
 * Filter options for listing requirements
 */
export interface RequirementFilter {
    status?: RequirementStatus;
    tag?: string;
    search?: string;
}

/**
 * RequirementService - Manages requirement lifecycle
 */
export class RequirementService {
    private _db: DesignerDatabase;
    private _progressService: ProgressService;

    constructor(db: DesignerDatabase) {
        this._db = db;
        this._progressService = new ProgressService(db);
    }

    // ========================================================================
    // Create
    // ========================================================================

    /**
     * Create a new requirement
     * 
     * @param input - Requirement data
     * @returns The created requirement with generated ID
     * @throws Error if validation fails
     */
    public create(input: CreateRequirementInput): Requirement {
        // Validate description length
        if (!input.description || input.description.length < 20) {
            throw new Error('Description must be at least 20 characters');
        }

        // Generate next ID
        const id = this._generateNextId();

        return this._db.transaction(() => {
            // Insert requirement
            this._db.run(`
                INSERT INTO requirements (id, description, created_by)
                VALUES (?, ?, ?)
            `, id, input.description, input.createdBy);

            // Insert tags (deduplicated, ignore duplicates)
            if (input.tags && input.tags.length > 0) {
                const uniqueTags = [...new Set(input.tags.map(t => t.toLowerCase()))];
                for (const tag of uniqueTags) {
                    if (tag.length >= 2) {
                        this._db.run(`
                            INSERT OR IGNORE INTO requirement_tags (requirement_id, tag)
                            VALUES (?, ?)
                        `, id, tag);
                    }
                }
            }

            // Update phase counts
            this._updateIntakeCounts();

            // Log to history
            this._db.logHistory('requirement_created', 'requirement', id, input.createdBy, {
                description: input.description.substring(0, 100),
                tags: input.tags
            });

            // Invalidate downstream phases if we're past intake
            const currentPhase = this._progressService.getCurrentPhase();
            if (currentPhase && currentPhase !== 'intake') {
                this._progressService.invalidateFromPhase(
                    'intake', 
                    input.createdBy || 'user', 
                    `New requirement ${id} added - downstream phases need re-assessment`
                );
            }

            return this.getById(id)!;
        });
    }

    /**
     * Generate the next requirement ID (REQ-001, REQ-002, etc.)
     * 
     * Note: Only counts REQ-XXX requirements, not SYS-XXX system requirements.
     * Each prefix has its own numbering scheme.
     */
    private _generateNextId(): string {
        const result = this._db.get<{ max_num: number }>(`
            SELECT COALESCE(MAX(CAST(SUBSTR(id, 5) AS INTEGER)), 0) as max_num
            FROM requirements
            WHERE id LIKE 'REQ-%'
        `);

        const nextNum = (result?.max_num || 0) + 1;
        return `REQ-${nextNum.toString().padStart(3, '0')}`;
    }

    // ========================================================================
    // Read
    // ========================================================================

    /**
     * Get a requirement by ID with all related data
     */
    public getById(id: string): EnrichedRequirement | undefined {
        const req = this._db.get<Requirement>(`
            SELECT * FROM requirements WHERE id = ?
        `, id);

        if (!req) {
            return undefined;
        }

        return this._enrichRequirement(req);
    }

    /**
     * List all requirements with optional filtering
     */
    public list(filter?: RequirementFilter): EnrichedRequirement[] {
        let sql = 'SELECT * FROM requirements WHERE 1=1';
        const params: unknown[] = [];

        if (filter?.status) {
            sql += ' AND status = ?';
            params.push(filter.status);
        }

        if (filter?.search) {
            sql += ' AND description LIKE ?';
            params.push(`%${filter.search}%`);
        }

        sql += ' ORDER BY created_at DESC';

        const requirements = this._db.all<Requirement>(sql, ...params);

        // Filter by tag if specified (requires join)
        let filtered = requirements;
        if (filter?.tag) {
            const taggedIds = new Set(
                this._db.all<{ requirement_id: string }>(`
                    SELECT requirement_id FROM requirement_tags WHERE tag = ?
                `, filter.tag.toLowerCase()).map(r => r.requirement_id)
            );
            filtered = requirements.filter(r => taggedIds.has(r.id));
        }

        return filtered.map(r => this._enrichRequirement(r));
    }

    /**
     * Get requirements by status
     */
    public getByStatus(status: RequirementStatus): EnrichedRequirement[] {
        return this.list({ status });
    }

    /**
     * Enrich a requirement with related data
     */
    private _enrichRequirement(req: Requirement): EnrichedRequirement {
        // Get tags
        const tags = this._db.all<{ tag: string }>(`
            SELECT tag FROM requirement_tags WHERE requirement_id = ?
        `, req.id).map(t => t.tag);

        // Get design decisions
        const decisions = this._db.all<DesignDecision>(`
            SELECT * FROM design_decisions WHERE requirement_id = ?
        `, req.id);

        return {
            ...req,
            tags,
            decisions
        };
    }

    // ========================================================================
    // Update
    // ========================================================================

    /**
     * Update a requirement
     * 
     * If the requirement has been signed off (past intake phase),
     * this will trigger cascading invalidation.
     * 
     * @param id - Requirement ID
     * @param input - Fields to update
     * @param actor - Who is making the change
     * @param reason - Why the change is being made (for audit)
     * @returns Updated requirement
     */
    public update(
        id: string, 
        input: UpdateRequirementInput, 
        actor?: string,
        reason?: string
    ): EnrichedRequirement {
        const existing = this.getById(id);
        if (!existing) {
            throw new Error(`Requirement not found: ${id}`);
        }

        // Validate description if provided
        if (input.description !== undefined && input.description.length < 20) {
            throw new Error('Description must be at least 20 characters');
        }

        // Check if we need to cascade invalidation
        const needsInvalidation = existing.status !== 'draft';

        return this._db.transaction(() => {
            // Build update query
            const updates: string[] = [];
            const params: unknown[] = [];

            if (input.description !== undefined) {
                updates.push('description = ?');
                params.push(input.description);
            }

            if (updates.length > 0) {
                params.push(id);
                this._db.run(`
                    UPDATE requirements SET ${updates.join(', ')} WHERE id = ?
                `, ...params);
            }

            // Update tags (deduplicated)
            if (input.tags !== undefined) {
                // Remove existing
                this._db.run(`
                    DELETE FROM requirement_tags WHERE requirement_id = ?
                `, id);

                // Add new (deduplicated, ignore duplicates)
                const uniqueTags = [...new Set(input.tags.map(t => t.toLowerCase()))];
                for (const tag of uniqueTags) {
                    if (tag.length >= 2) {
                        this._db.run(`
                            INSERT OR IGNORE INTO requirement_tags (requirement_id, tag)
                            VALUES (?, ?)
                        `, id, tag);
                    }
                }
            }

            // Trigger cascading invalidation if needed
            if (needsInvalidation) {
                const invalidationReason = reason || `Requirement ${id} was modified`;
                this._progressService.invalidateFromPhase('intake', actor || 'system', invalidationReason);
            }

            // Log to history
            this._db.logHistory('requirement_updated', 'requirement', id, actor, {
                changes: input,
                reason,
                cascaded: needsInvalidation
            });

            return this.getById(id)!;
        });
    }

    /**
     * Update requirement status
     */
    public updateStatus(id: string, status: RequirementStatus, actor?: string): void {
        this._db.run(`
            UPDATE requirements SET status = ? WHERE id = ?
        `, status, id);

        this._db.logHistory('requirement_status_changed', 'requirement', id, actor, {
            new_status: status
        });

        this._updateIntakeCounts();
    }

    // ========================================================================
    // Delete
    // ========================================================================

    /**
     * Delete a requirement
     * 
     * @param id - Requirement ID
     * @param actor - Who is deleting
     * @throws Error if requirement is past draft status
     */
    public delete(id: string, actor?: string): void {
        const existing = this.getById(id);
        if (!existing) {
            throw new Error(`Requirement not found: ${id}`);
        }

        // Only allow deletion of draft requirements
        if (existing.status !== 'draft') {
            throw new Error(`Cannot delete requirement in ${existing.status} status. Mark as cancelled instead.`);
        }

        this._db.transaction(() => {
            // Delete related data (cascades via FK)
            this._db.run('DELETE FROM requirements WHERE id = ?', id);

            // Log to history
            this._db.logHistory('requirement_deleted', 'requirement', id, actor, {
                description: existing.description.substring(0, 100)
            });

            this._updateIntakeCounts();
        });
    }

    // ========================================================================
    // Helpers
    // ========================================================================

    /**
     * Update intake phase counts
     */
    private _updateIntakeCounts(): void {
        const counts = this._db.get<{ total: number; completed: number; pending: number }>(`
            SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN status != 'draft' THEN 1 ELSE 0 END) as completed,
                SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) as pending
            FROM requirements
        `);

        if (counts) {
            this._progressService.updatePhaseCounts(
                'intake',
                counts.total,
                counts.completed,
                counts.pending
            );
        }
    }

    /**
     * Get all unique tags
     */
    public getAllTags(): string[] {
        // Only return tags from user requirements (REQ-*), not system guidance (SYS-*)
        return this._db.all<{ tag: string }>(`
            SELECT DISTINCT rt.tag 
            FROM requirement_tags rt
            JOIN requirements r ON rt.requirement_id = r.id
            WHERE r.id LIKE 'REQ-%'
            ORDER BY rt.tag
        `).map(t => t.tag);
    }

    /**
     * Get requirement count
     */
    public getCount(): number {
        const result = this._db.get<{ count: number }>(`
            SELECT COUNT(*) as count FROM requirements
        `);
        return result?.count || 0;
    }

    /**
     * Check if all requirements are assessed
     */
    public areAllAssessed(): boolean {
        const result = this._db.get<{ count: number }>(`
            SELECT COUNT(*) as count FROM requirements WHERE status = 'draft'
        `);
        return (result?.count || 0) === 0;
    }
}
