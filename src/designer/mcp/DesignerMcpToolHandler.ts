/**
 * Content Designer MCP tool implementation for the extension host.
 * Registered via McpToolHandler.setDesignerHandler() so @ansible/mcp-server stays decoupled from DesignerDatabase.
 */

import type { McpDesignerToolHandler, McpToolResult } from '@ansible/mcp-server';
import { DesignerDatabase } from '../database/DesignerDatabase';

export class DesignerMcpToolHandler implements McpDesignerToolHandler {
    async handleTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
        switch (name) {
            case 'query_design_db':
                return this.queryDesignDb(args);
            case 'get_project_requirements':
                return this.getRequirements(args);
            case 'get_design_decisions':
                return this.getDesignDecisions(args);
            default:
                return {
                    content: [{ type: 'text', text: `Unknown designer tool: ${name}` }],
                    isError: true,
                };
        }
    }

    private async queryDesignDb(args: Record<string, unknown>): Promise<McpToolResult> {
        const query = args.query as string;
        const limit = (args.limit as number) || 100;

        if (!query) {
            return {
                content: [{ type: 'text', text: 'Error: query parameter is required' }],
                isError: true,
            };
        }

        const workspaceRoot = process.env.ANSIBLE_ENV_WORKSPACE;
        if (!workspaceRoot) {
            return {
                content: [{
                    type: 'text',
                    text: 'Error: No workspace context available. The Content Designer database requires a workspace.',
                }],
                isError: true,
            };
        }

        const db = new DesignerDatabase(workspaceRoot);
        if (!db.exists()) {
            return {
                content: [{
                    type: 'text',
                    text: `No Content Designer project found in this workspace.

To create a new Content Designer project:
1. Open the Content Designer view in VS Code
2. Click "New Project" to initialize a design.db

Or use the ansible-creator tool to scaffold a new project.`,
                }],
                isError: true,
            };
        }

        try {
            await db.initialize();
            const result = db.executeReadonlyQuery(query, limit);
            db.close();

            if (!result.success) {
                return {
                    content: [{
                        type: 'text',
                        text: `Query Error: ${result.error}\n\n${result.hint || ''}`,
                    }],
                    isError: true,
                };
            }

            if (!result.rows || result.rows.length === 0) {
                return {
                    content: [{ type: 'text', text: 'Query returned no results.' }],
                };
            }

            const columns = result.columns || [];
            const rows = result.rows || [];

            let table = '| ' + columns.join(' | ') + ' |\n';
            table += '| ' + columns.map(() => '---').join(' | ') + ' |\n';

            for (const row of rows) {
                const values = columns.map(col => {
                    const val = row[col];
                    if (val === null || val === undefined) { return ''; }
                    if (typeof val === 'object') { return JSON.stringify(val); }
                    return String(val).replace(/\|/g, '\\|').replace(/\n/g, ' ');
                });
                table += '| ' + values.join(' | ') + ' |\n';
            }

            let response = `Query returned ${result.rowCount} row(s)${result.truncated ? ' (truncated)' : ''}:\n\n${table}`;

            if (result.truncated) {
                response += `\n\n*Results truncated. Use the \`limit\` parameter to fetch more rows (max 1000).*`;
            }

            return { content: [{ type: 'text', text: response }] };
        } catch (error) {
            return {
                content: [{
                    type: 'text',
                    text: `Error executing query: ${error instanceof Error ? error.message : error}`,
                }],
                isError: true,
            };
        }
    }

    private async getRequirements(args: Record<string, unknown>): Promise<McpToolResult> {
        const includeSystem = args.include_system === true;
        const statusFilter = args.status_filter as string | undefined;

        const workspaceRoot = process.env.ANSIBLE_ENV_WORKSPACE;
        if (!workspaceRoot) {
            return {
                content: [{ type: 'text', text: 'Error: No workspace context available.' }],
                isError: true,
            };
        }

        const db = new DesignerDatabase(workspaceRoot);
        if (!db.exists()) {
            return {
                content: [{ type: 'text', text: 'No Content Designer project found. Create a new project first.' }],
                isError: true,
            };
        }

        await db.initialize();

        let sql = `
            SELECT 
                r.id,
                r.description,
                r.status,
                r.created_at,
                GROUP_CONCAT(rt.tag, ', ') as tags
            FROM requirements r
            LEFT JOIN requirement_tags rt ON r.id = rt.requirement_id
            WHERE 1=1
        `;
        const params: unknown[] = [];

        if (!includeSystem) {
            sql += ` AND r.id GLOB 'REQ-*'`;
        }

        if (statusFilter) {
            sql += ` AND r.status = ?`;
            params.push(statusFilter);
        }

        sql += ` GROUP BY r.id ORDER BY r.id`;

        try {
            const requirements = params.length > 0
                ? db.all<{
                    id: string;
                    description: string;
                    status: string;
                    created_at: string;
                    tags: string | null;
                }>(sql, ...params)
                : db.all<{
                    id: string;
                    description: string;
                    status: string;
                    created_at: string;
                    tags: string | null;
                }>(sql);

            if (requirements.length === 0) {
                return {
                    content: [{
                        type: 'text',
                        text: 'No requirements found. Add requirements in the Content Designer before assessment.',
                    }],
                };
            }

            const sysItems = requirements
                .filter((r: { id: string }) => r.id.startsWith('SYS-'))
                .map((r: { id: string; description: string; status: string; tags: string | null }) => ({
                    id: r.id,
                    instruction: r.description,
                    tags: r.tags ? r.tags.split(', ') : [],
                }));

            const reqItems = requirements
                .filter((r: { id: string }) => r.id.startsWith('REQ-'))
                .map((r: { id: string; description: string; status: string; tags: string | null; created_at: string }) => ({
                    id: r.id,
                    description: r.description,
                    status: r.status,
                    tags: r.tags ? r.tags.split(', ') : [],
                    created_at: r.created_at,
                }));

            const response: Record<string, unknown> = {
                user_requirements: {
                    count: reqItems.length,
                    note: 'These are what the user wants to build. Generate questions/content for these.',
                    items: reqItems,
                },
            };

            if (sysItems.length > 0) {
                response.system_guidance = {
                    count: sysItems.length,
                    note: 'These are YOUR operational instructions. Follow them in order (SYS-001, SYS-002, etc). Do NOT generate questions for these.',
                    items: sysItems,
                };
            }

            db.close();
            return {
                content: [{ type: 'text', text: JSON.stringify(response, null, 2) }],
            };
        } catch (error) {
            db.close();
            return {
                content: [{
                    type: 'text',
                    text: `Failed to query requirements: ${error instanceof Error ? error.message : String(error)}`,
                }],
                isError: true,
            };
        }
    }

    private async getDesignDecisions(args: Record<string, unknown>): Promise<McpToolResult> {
        const requirementId = args.requirement_id as string | undefined;
        const stage = args.stage as string | undefined;
        const answeredOnly = args.answered_only === true;

        const workspaceRoot = process.env.ANSIBLE_ENV_WORKSPACE;
        if (!workspaceRoot) {
            return {
                content: [{ type: 'text', text: 'Error: No workspace context available.' }],
                isError: true,
            };
        }

        const db = new DesignerDatabase(workspaceRoot);
        if (!db.exists()) {
            return {
                content: [{ type: 'text', text: 'No Content Designer project found.' }],
                isError: true,
            };
        }

        await db.initialize();

        let sql = `
            SELECT 
                dd.id,
                dd.requirement_id,
                dd.question_id,
                dd.category,
                dd.question,
                dd.question_type,
                dd.choices,
                dd.suggested_default,
                dd.answer,
                dd.rationale,
                dd.stage,
                r.description as requirement_description
            FROM design_decisions dd
            JOIN requirements r ON dd.requirement_id = r.id
            WHERE 1=1
        `;
        const params: unknown[] = [];

        if (requirementId) {
            sql += ` AND dd.requirement_id = ?`;
            params.push(requirementId);
        }

        if (stage) {
            sql += ` AND dd.stage = ?`;
            params.push(stage);
        }

        if (answeredOnly) {
            sql += ` AND dd.answer IS NOT NULL`;
        }

        sql += ` ORDER BY dd.requirement_id, dd.category, dd.question_id`;

        try {
            const decisions = params.length > 0
                ? db.all<{
                    id: number;
                    requirement_id: string;
                    question_id: string;
                    category: string;
                    question: string;
                    question_type: string;
                    choices: string | null;
                    suggested_default: string | null;
                    answer: string | null;
                    rationale: string | null;
                    stage: string;
                    requirement_description: string;
                }>(sql, ...params)
                : db.all<{
                    id: number;
                    requirement_id: string;
                    question_id: string;
                    category: string;
                    question: string;
                    question_type: string;
                    choices: string | null;
                    suggested_default: string | null;
                    answer: string | null;
                    rationale: string | null;
                    stage: string;
                    requirement_description: string;
                }>(sql);

            const grouped = new Map<string, {
                requirement_id: string;
                requirement_description: string;
                decisions: Array<{
                    question_id: string;
                    category: string;
                    question: string;
                    question_type: string;
                    choices: string[] | null;
                    suggested_default: string | null;
                    answer: string | null;
                    rationale: string | null;
                    stage: string;
                }>;
            }>();

            for (const d of decisions) {
                if (!grouped.has(d.requirement_id)) {
                    grouped.set(d.requirement_id, {
                        requirement_id: d.requirement_id,
                        requirement_description: d.requirement_description,
                        decisions: [],
                    });
                }
                grouped.get(d.requirement_id)!.decisions.push({
                    question_id: d.question_id,
                    category: d.category,
                    question: d.question,
                    question_type: d.question_type,
                    choices: d.choices ? JSON.parse(d.choices) : null,
                    suggested_default: d.suggested_default,
                    answer: d.answer,
                    rationale: d.rationale,
                    stage: d.stage,
                });
            }

            const result = {
                total_decisions: decisions.length,
                answered: decisions.filter((d: { answer: string | null }) => d.answer !== null).length,
                unanswered: decisions.filter((d: { answer: string | null }) => d.answer === null).length,
                by_requirement: Array.from(grouped.values()),
            };

            db.close();
            return {
                content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            };
        } catch (error) {
            db.close();
            return {
                content: [{
                    type: 'text',
                    text: `Failed to query design decisions: ${error instanceof Error ? error.message : String(error)}`,
                }],
                isError: true,
            };
        }
    }
}
