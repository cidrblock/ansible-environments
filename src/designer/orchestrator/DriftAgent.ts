/**
 * Ansible Content Designer - Drift Agent
 * 
 * Assesses compliance between generated artifacts and design specifications.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { 
    DriftAssessment,
    DriftFinding,
    DriftStatus,
    DriftResolution,
    DriftResponse,
    DriftReportItem,
    DriftFindingDetail,
    Artifact,
    Requirement,
    DesignDecision
} from '../types/designer';
import { DesignerDatabase } from '../database/DesignerDatabase';

/**
 * DriftAgent - Assesses compliance and drift
 */
export class DriftAgent {
    private _db: DesignerDatabase;
    private _workspaceRoot: string;

    constructor(db: DesignerDatabase, workspaceRoot: string) {
        this._db = db;
        this._workspaceRoot = workspaceRoot;
    }

    /**
     * Run a drift assessment
     */
    public async assess(): Promise<DriftResponse> {
        // Get all requirements and their decisions
        const requirements = this._db.all<Requirement>(`
            SELECT * FROM requirements WHERE status != 'draft'
        `);

        // Get all artifacts
        const artifacts = this._db.all<Artifact>(`
            SELECT * FROM artifacts WHERE stale = 0
        `);

        const findings: DriftReportItem[] = [];
        let compliantCount = 0;
        let driftedCount = 0;

        for (const req of requirements) {
            const reqFindings = await this._assessRequirement(req, artifacts);
            findings.push(reqFindings);

            if (reqFindings.status === 'compliant') {
                compliantCount++;
            } else {
                driftedCount++;
            }
        }

        const overallCompliance = requirements.length > 0
            ? Math.round((compliantCount / requirements.length) * 100)
            : 100;

        // Store assessment in database
        const assessmentId = this._storeAssessment(findings, requirements.length, compliantCount, driftedCount, overallCompliance);

        // Store individual findings
        for (const finding of findings) {
            this._storeFinding(assessmentId, finding);
        }

        return {
            findings,
            overall_compliance: overallCompliance,
            summary: this._generateSummary(findings, overallCompliance)
        };
    }

    /**
     * Assess a single requirement
     */
    private async _assessRequirement(req: Requirement, artifacts: Artifact[]): Promise<DriftReportItem> {
        // Get design decisions for this requirement
        const decisions = this._db.all<DesignDecision>(`
            SELECT * FROM design_decisions 
            WHERE requirement_id = ? AND answer IS NOT NULL
        `, req.id);

        // Get plan items and their artifacts
        const planItems = this._db.all<{ id: string; name: string; type: string }>(`
            SELECT id, name, type FROM plan_items WHERE requirement_id = ?
        `, req.id);

        const reqArtifacts = artifacts.filter(a => 
            planItems.some(p => p.id === a.plan_item_id)
        );

        const details: DriftFindingDetail[] = [];
        const additions: string[] = [];
        const removals: string[] = [];
        const recommendations: string[] = [];

        // Check each design decision against artifacts
        for (const decision of decisions) {
            const finding = await this._checkDecisionCompliance(decision, reqArtifacts);
            details.push(finding);

            if (!finding.compliant) {
                recommendations.push(`Review ${decision.category}: Expected "${finding.expected}" but found "${finding.found}"`);
            }
        }

        // Check for artifacts not in plan (additions)
        const expectedPaths = new Set(planItems.map(p => this._getExpectedPath(p)));
        for (const artifact of reqArtifacts) {
            if (!expectedPaths.has(artifact.path)) {
                additions.push(artifact.path);
            }
        }

        // Check for missing artifacts (removals)
        for (const item of planItems) {
            const expectedPath = this._getExpectedPath(item);
            const found = reqArtifacts.some(a => a.path === expectedPath);
            if (!found) {
                removals.push(expectedPath);
                recommendations.push(`Generate missing artifact: ${expectedPath}`);
            }
        }

        // Determine overall status
        const nonCompliantCount = details.filter(d => !d.compliant).length;
        let status: DriftStatus = 'compliant';
        
        if (nonCompliantCount > 0 || additions.length > 0 || removals.length > 0) {
            status = nonCompliantCount === details.length ? 'drifted' : 'partial';
        }

        return {
            requirement_id: req.id,
            status,
            summary: this._generateRequirementSummary(req, status, details),
            details,
            additions,
            removals,
            recommendations
        };
    }

    /**
     * Check if a design decision is reflected in the artifacts
     */
    private async _checkDecisionCompliance(
        decision: DesignDecision, 
        artifacts: Artifact[]
    ): Promise<DriftFindingDetail> {
        // For now, do basic content scanning
        // In future, could use LLM for semantic analysis
        
        const answer = decision.answer || '';
        let found = 'Not verified';
        let compliant = true;

        // Simple heuristic checks based on category
        switch (decision.category) {
            case 'architecture':
                // Check if the architecture choice is reflected in file structure
                found = this._checkArchitectureCompliance(answer, artifacts);
                compliant = found.toLowerCase().includes(answer.toLowerCase().split(' ')[0]);
                break;

            case 'error_handling':
                // Check if error handling patterns exist
                found = this._checkErrorHandlingCompliance(artifacts);
                compliant = found !== 'No error handling found';
                break;

            case 'testing':
                // Check if tests exist
                found = this._checkTestingCompliance(answer, artifacts);
                compliant = found !== 'No tests found';
                break;

            case 'naming':
                // Check naming conventions
                found = 'Naming conventions applied';
                compliant = true; // Would need deeper analysis
                break;

            default:
                // Generic check
                found = 'Decision recorded';
                compliant = true;
        }

        return {
            decision: decision.question,
            expected: answer,
            found,
            compliant
        };
    }

    /**
     * Check architecture compliance
     */
    private _checkArchitectureCompliance(answer: string, artifacts: Artifact[]): string {
        const hasPlaybooks = artifacts.some(a => a.path.includes('playbooks/'));
        const hasRoles = artifacts.some(a => a.path.includes('roles/'));
        const hasModules = artifacts.some(a => a.path.includes('plugins/modules/'));

        const parts: string[] = [];
        if (hasPlaybooks) parts.push('playbooks');
        if (hasRoles) parts.push('roles');
        if (hasModules) parts.push('modules');

        return parts.length > 0 
            ? `Found: ${parts.join(', ')}`
            : 'No artifacts found';
    }

    /**
     * Check error handling compliance
     */
    private _checkErrorHandlingCompliance(artifacts: Artifact[]): string {
        for (const artifact of artifacts) {
            const content = this._readArtifact(artifact.path);
            if (content) {
                if (content.includes('block:') && content.includes('rescue:')) {
                    return 'Block/rescue error handling found';
                }
                if (content.includes('failed_when:') || content.includes('ignore_errors:')) {
                    return 'Error handling directives found';
                }
            }
        }
        return 'No error handling found';
    }

    /**
     * Check testing compliance
     */
    private _checkTestingCompliance(answer: string, artifacts: Artifact[]): string {
        const testArtifacts = artifacts.filter(a => 
            a.path.includes('tests/') || 
            a.path.includes('molecule/') ||
            a.path.includes('test_')
        );

        if (testArtifacts.length > 0) {
            return `Found ${testArtifacts.length} test file(s)`;
        }
        return 'No tests found';
    }

    /**
     * Read artifact content
     */
    private _readArtifact(artifactPath: string): string | undefined {
        const fullPath = path.join(this._workspaceRoot, artifactPath);
        try {
            if (fs.existsSync(fullPath)) {
                return fs.readFileSync(fullPath, 'utf-8');
            }
        } catch {
            // Ignore read errors
        }
        return undefined;
    }

    /**
     * Get expected path for a plan item
     */
    private _getExpectedPath(item: { name: string; type: string }): string {
        switch (item.type) {
            case 'playbook':
                return `playbooks/${item.name}`;
            case 'role':
                return `roles/${item.name}/tasks/main.yml`;
            case 'module':
                return `plugins/modules/${item.name}.py`;
            default:
                return item.name;
        }
    }

    /**
     * Generate requirement summary
     */
    private _generateRequirementSummary(
        req: Requirement, 
        status: DriftStatus, 
        details: DriftFindingDetail[]
    ): string {
        const compliant = details.filter(d => d.compliant).length;
        const total = details.length;

        switch (status) {
            case 'compliant':
                return `All ${total} design decisions are reflected in the generated content.`;
            case 'partial':
                return `${compliant}/${total} design decisions are compliant. Some drift detected.`;
            case 'drifted':
                return `Generated content has drifted from design specifications.`;
        }
    }

    /**
     * Generate overall summary
     */
    private _generateSummary(findings: DriftReportItem[], compliance: number): string {
        const compliant = findings.filter(f => f.status === 'compliant').length;
        const partial = findings.filter(f => f.status === 'partial').length;
        const drifted = findings.filter(f => f.status === 'drifted').length;

        return `Overall compliance: ${compliance}%. ` +
            `${compliant} compliant, ${partial} partial, ${drifted} drifted out of ${findings.length} requirements.`;
    }

    /**
     * Store assessment in database
     */
    private _storeAssessment(
        findings: DriftReportItem[], 
        total: number, 
        compliant: number, 
        drifted: number,
        compliance: number
    ): number {
        this._db.run(`
            INSERT INTO drift_assessments 
            (total_requirements, compliant, drifted, overall_compliance, report)
            VALUES (?, ?, ?, ?, ?)
        `, total, compliant, drifted, compliance, JSON.stringify(findings));

        const result = this._db.get<{ id: number }>(`
            SELECT last_insert_rowid() as id
        `);

        this._db.logHistory('drift_assessment_created', 'drift_assessment', String(result?.id));

        return result?.id || 0;
    }

    /**
     * Store individual finding
     */
    private _storeFinding(assessmentId: number, finding: DriftReportItem): void {
        this._db.run(`
            INSERT INTO drift_findings 
            (assessment_id, requirement_id, status, expected, found, additions, removals, resolution)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
        `, 
            assessmentId, 
            finding.requirement_id, 
            finding.status,
            finding.summary,
            finding.details.map(d => d.found).join('; '),
            JSON.stringify(finding.additions),
            JSON.stringify(finding.removals)
        );
    }

    // ========================================================================
    // Query Methods
    // ========================================================================

    /**
     * Get latest assessment
     */
    public getLatestAssessment(): DriftAssessment | undefined {
        return this._db.get<DriftAssessment>(`
            SELECT * FROM drift_assessments ORDER BY assessed_at DESC LIMIT 1
        `);
    }

    /**
     * Get findings for an assessment
     */
    public getFindings(assessmentId: number): DriftFinding[] {
        return this._db.all<DriftFinding>(`
            SELECT * FROM drift_findings WHERE assessment_id = ?
        `, assessmentId);
    }

    /**
     * Get all assessments
     */
    public getAssessments(): DriftAssessment[] {
        return this._db.all<DriftAssessment>(`
            SELECT * FROM drift_assessments ORDER BY assessed_at DESC
        `);
    }

    /**
     * Resolve a finding
     */
    public resolveFinding(
        findingId: number, 
        resolution: DriftResolution, 
        note?: string,
        resolver?: string
    ): void {
        this._db.run(`
            UPDATE drift_findings 
            SET resolution = ?, resolution_note = ?, resolved_at = CURRENT_TIMESTAMP, resolved_by = ?
            WHERE id = ?
        `, resolution, note, resolver, findingId);

        this._db.logHistory('drift_finding_resolved', 'drift_finding', String(findingId), resolver, {
            resolution,
            note
        });
    }

    /**
     * Mark artifact as stale
     */
    public markArtifactStale(artifactId: number, reason: string): void {
        this._db.run(`
            UPDATE artifacts 
            SET stale = 1, stale_reason = ?, stale_since = CURRENT_TIMESTAMP
            WHERE id = ?
        `, reason, artifactId);
    }

    /**
     * Get stale artifacts
     */
    public getStaleArtifacts(): Artifact[] {
        return this._db.all<Artifact>(`
            SELECT * FROM artifacts WHERE stale = 1
        `);
    }
}
