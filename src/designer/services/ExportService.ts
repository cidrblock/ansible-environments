/**
 * Ansible Content Designer - Export Service
 * 
 * Generates human-readable YAML exports of the design database.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { 
    Project,
    Requirement,
    DesignDecision,
    PlanItem,
    Artifact,
    DriftAssessment,
    HistoryEntry
} from '../types/designer';
import { DesignerDatabase } from '../database/DesignerDatabase';

/**
 * Export format for project
 */
interface ProjectExport {
    metadata: {
        exported_at: string;
        version: string;
        tool: string;
    };
    project: {
        name: string;
        namespace: string;
        full_name: string;
        type: string;
        description?: string;
        phase: string;
        created_at: string;
    };
    statistics: {
        requirements: number;
        plan_items: number;
        artifacts: number;
        compliance?: number;
    };
}

/**
 * Export format for requirement
 */
interface RequirementExport {
    id: string;
    description: string;
    status: string;
    tags: string[];
    design_decisions: Array<{
        category: string;
        question: string;
        answer?: string;
    }>;
    plan_items: Array<{
        id: string;
        type: string;
        name: string;
        status: string;
    }>;
}

/**
 * ExportService - Generates YAML exports
 */
export class ExportService {
    private _db: DesignerDatabase;
    private _workspaceRoot: string;
    private _exportDir: string;

    constructor(db: DesignerDatabase, workspaceRoot: string) {
        this._db = db;
        this._workspaceRoot = workspaceRoot;
        this._exportDir = path.join(workspaceRoot, 'design', 'export');
    }

    /**
     * Export all design data to YAML files
     */
    public async exportAll(): Promise<string[]> {
        // Ensure export directory exists
        if (!fs.existsSync(this._exportDir)) {
            fs.mkdirSync(this._exportDir, { recursive: true });
        }

        const exportedFiles: string[] = [];

        // Export project overview
        const projectFile = await this._exportProject();
        if (projectFile) exportedFiles.push(projectFile);

        // Export requirements
        const reqFiles = await this._exportRequirements();
        exportedFiles.push(...reqFiles);

        // Export plan
        const planFile = await this._exportPlan();
        if (planFile) exportedFiles.push(planFile);

        // Export history
        const historyFile = await this._exportHistory();
        if (historyFile) exportedFiles.push(historyFile);

        return exportedFiles;
    }

    /**
     * Export project overview
     */
    private async _exportProject(): Promise<string | undefined> {
        const project = this._db.get<Project>(`SELECT * FROM project WHERE id = 1`);
        if (!project) return undefined;

        const reqCount = this._db.get<{ count: number }>(`SELECT COUNT(*) as count FROM requirements`)?.count || 0;
        const planCount = this._db.get<{ count: number }>(`SELECT COUNT(*) as count FROM plan_items`)?.count || 0;
        const artifactCount = this._db.get<{ count: number }>(`SELECT COUNT(*) as count FROM artifacts`)?.count || 0;
        const assessment = this._db.get<DriftAssessment>(`SELECT * FROM drift_assessments ORDER BY assessed_at DESC LIMIT 1`);

        const exportData: ProjectExport = {
            metadata: {
                exported_at: new Date().toISOString(),
                version: '1.0.0',
                tool: 'Ansible Content Designer'
            },
            project: {
                name: project.name,
                namespace: project.namespace,
                full_name: `${project.namespace}.${project.name}`,
                type: project.type,
                description: project.description,
                phase: project.phase,
                created_at: project.created_at
            },
            statistics: {
                requirements: reqCount,
                plan_items: planCount,
                artifacts: artifactCount,
                compliance: assessment?.overall_compliance
            }
        };

        const filePath = path.join(this._exportDir, 'project.yaml');
        fs.writeFileSync(filePath, this._toYaml(exportData));

        return 'design/export/project.yaml';
    }

    /**
     * Export requirements
     */
    private async _exportRequirements(): Promise<string[]> {
        const requirements = this._db.all<Requirement>(`SELECT * FROM requirements ORDER BY id`);
        const files: string[] = [];

        // Create requirements subdirectory
        const reqDir = path.join(this._exportDir, 'requirements');
        if (!fs.existsSync(reqDir)) {
            fs.mkdirSync(reqDir, { recursive: true });
        }

        for (const req of requirements) {
            // Get related data
            const tags = this._db.all<{ tag: string }>(`
                SELECT tag FROM requirement_tags WHERE requirement_id = ?
            `, req.id).map(t => t.tag);

            const decisions = this._db.all<DesignDecision>(`
                SELECT * FROM design_decisions WHERE requirement_id = ?
            `, req.id);

            const planItems = this._db.all<PlanItem>(`
                SELECT * FROM plan_items WHERE requirement_id = ?
            `, req.id);

            const exportData: RequirementExport = {
                id: req.id,
                description: req.description,
                status: req.status,
                tags,
                design_decisions: decisions.map(d => ({
                    category: d.category,
                    question: d.question,
                    answer: d.answer
                })),
                plan_items: planItems.map(p => ({
                    id: p.id,
                    type: p.type,
                    name: p.name,
                    status: p.status
                }))
            };

            const fileName = `${req.id.toLowerCase()}.yaml`;
            const filePath = path.join(reqDir, fileName);
            fs.writeFileSync(filePath, this._toYaml(exportData));
            files.push(`design/export/requirements/${fileName}`);
        }

        return files;
    }

    /**
     * Export implementation plan
     */
    private async _exportPlan(): Promise<string | undefined> {
        const planItems = this._db.all<PlanItem>(`SELECT * FROM plan_items ORDER BY sequence, id`);
        if (planItems.length === 0) return undefined;

        const artifacts = this._db.all<Artifact>(`SELECT * FROM artifacts`);

        const exportData = {
            metadata: {
                exported_at: new Date().toISOString(),
                total_items: planItems.length
            },
            items: planItems.map(item => {
                const itemArtifacts = artifacts.filter(a => a.plan_item_id === item.id);
                return {
                    id: item.id,
                    requirement: item.requirement_id,
                    type: item.type,
                    name: item.name,
                    description: item.description,
                    collection: item.collection,
                    status: item.status,
                    artifacts: itemArtifacts.map(a => ({
                        path: a.path,
                        stale: a.stale
                    }))
                };
            })
        };

        const filePath = path.join(this._exportDir, 'plan.yaml');
        fs.writeFileSync(filePath, this._toYaml(exportData));

        return 'design/export/plan.yaml';
    }

    /**
     * Export history/audit trail
     */
    private async _exportHistory(): Promise<string | undefined> {
        const history = this._db.all<HistoryEntry>(`
            SELECT * FROM history ORDER BY timestamp DESC LIMIT 100
        `);

        if (history.length === 0) return undefined;

        const exportData = {
            metadata: {
                exported_at: new Date().toISOString(),
                entry_count: history.length
            },
            entries: history.map(h => ({
                timestamp: h.timestamp,
                action: h.action,
                entity: `${h.entity_type}:${h.entity_id || 'N/A'}`,
                actor: h.actor || 'system',
                details: h.details ? JSON.parse(h.details) : undefined
            }))
        };

        const filePath = path.join(this._exportDir, 'history.yaml');
        fs.writeFileSync(filePath, this._toYaml(exportData));

        return 'design/export/history.yaml';
    }

    /**
     * Convert object to YAML string
     */
    private _toYaml(obj: unknown, indent: number = 0): string {
        const lines: string[] = [];
        const prefix = '  '.repeat(indent);

        if (obj === null || obj === undefined) {
            return 'null';
        }

        if (typeof obj === 'string') {
            // Handle multiline strings
            if (obj.includes('\n')) {
                lines.push('|');
                for (const line of obj.split('\n')) {
                    lines.push(`${prefix}  ${line}`);
                }
                return lines.join('\n');
            }
            // Quote strings with special characters
            if (obj.match(/[:#\[\]{}|>!&*?'"`@,]/)) {
                return `"${obj.replace(/"/g, '\\"')}"`;
            }
            return obj;
        }

        if (typeof obj === 'number' || typeof obj === 'boolean') {
            return String(obj);
        }

        if (Array.isArray(obj)) {
            if (obj.length === 0) {
                return '[]';
            }

            for (const item of obj) {
                if (typeof item === 'object' && item !== null) {
                    const itemYaml = this._toYaml(item, indent + 1);
                    const itemLines = itemYaml.split('\n');
                    lines.push(`${prefix}- ${itemLines[0]}`);
                    for (let i = 1; i < itemLines.length; i++) {
                        lines.push(`${prefix}  ${itemLines[i]}`);
                    }
                } else {
                    lines.push(`${prefix}- ${this._toYaml(item, indent)}`);
                }
            }
            return lines.join('\n');
        }

        if (typeof obj === 'object') {
            const entries = Object.entries(obj as Record<string, unknown>);
            if (entries.length === 0) {
                return '{}';
            }

            for (const [key, value] of entries) {
                if (value === undefined) continue;

                if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
                    lines.push(`${prefix}${key}:`);
                    const nested = this._toYaml(value, indent + 1);
                    for (const line of nested.split('\n')) {
                        lines.push(line);
                    }
                } else if (Array.isArray(value)) {
                    lines.push(`${prefix}${key}:`);
                    if (value.length === 0) {
                        lines[lines.length - 1] += ' []';
                    } else {
                        const nested = this._toYaml(value, indent + 1);
                        for (const line of nested.split('\n')) {
                            lines.push(line);
                        }
                    }
                } else {
                    lines.push(`${prefix}${key}: ${this._toYaml(value, indent)}`);
                }
            }
            return lines.join('\n');
        }

        return String(obj);
    }

    /**
     * Generate a summary report
     */
    public async generateSummary(): Promise<string> {
        const project = this._db.get<Project>(`SELECT * FROM project WHERE id = 1`);
        if (!project) return 'No project found';

        const reqCount = this._db.get<{ count: number }>(`SELECT COUNT(*) as count FROM requirements`)?.count || 0;
        const planCount = this._db.get<{ count: number }>(`SELECT COUNT(*) as count FROM plan_items`)?.count || 0;
        const artifactCount = this._db.get<{ count: number }>(`SELECT COUNT(*) as count FROM artifacts`)?.count || 0;
        const assessment = this._db.get<DriftAssessment>(`SELECT * FROM drift_assessments ORDER BY assessed_at DESC LIMIT 1`);

        const lines = [
            `# ${project.namespace}.${project.name}`,
            '',
            `**Type:** ${project.type}`,
            `**Phase:** ${project.phase}`,
            `**Created:** ${project.created_at}`,
            '',
            '## Statistics',
            '',
            `- Requirements: ${reqCount}`,
            `- Plan Items: ${planCount}`,
            `- Artifacts: ${artifactCount}`,
            assessment ? `- Compliance: ${assessment.overall_compliance}%` : '',
            '',
            project.description ? `## Description\n\n${project.description}` : ''
        ];

        return lines.filter(Boolean).join('\n');
    }
}
