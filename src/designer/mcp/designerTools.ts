/**
 * Ansible Content Designer - MCP Tools
 * 
 * MCP tools for AI agents to interact with the Content Designer.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';

/**
 * query_design_db - Read-only SQL query tool
 * 
 * Allows AI agents to query the Content Designer database for context.
 */
export const QUERY_DESIGN_DB_TOOL: Tool = {
    name: 'query_design_db',
    description: `Execute a read-only SQL query against the Content Designer database.

This tool provides AI agents with access to project requirements, design decisions,
implementation plans, and build status. Use it to understand the current state of
the Ansible content project and make informed suggestions.

**Security**: Only SELECT queries are allowed. INSERT/UPDATE/DELETE are blocked.

**Available Tables**:
- project: Project metadata (name, namespace, type, phase)
- requirements: User requirements with constrained IDs (REQ-001)
- requirement_artifacts: Artifact types per requirement
- requirement_tags: Tags for requirements
- design_decisions: Assessment Q&A for each requirement
- project_decisions: Project-wide decisions
- plan_items: Implementation plan items (ITEM-001)
- build_steps: Build progress substeps
- artifacts: Generated files
- phase_progress: Workflow progress for each phase
- sign_offs: Phase approvals
- drift_assessments: Compliance checks
- drift_findings: Individual drift issues
- history: Audit log of all actions

**Example Queries**:
- Get all requirements: SELECT * FROM requirements
- Get pending questions: SELECT * FROM design_decisions WHERE answer IS NULL
- Get plan items for a requirement: SELECT * FROM plan_items WHERE requirement_id = 'REQ-001'
- Get build progress: SELECT * FROM phase_progress
- Get recent history: SELECT * FROM history ORDER BY timestamp DESC LIMIT 10

**Tips**:
- Use JOINs to get enriched data
- Results are limited to 100 rows by default (max 1000)
- Use the 'limit' parameter to control result size`,
    inputSchema: {
        type: 'object',
        required: ['query'],
        properties: {
            query: {
                type: 'string',
                description: 'SQL SELECT query to execute. Only SELECT statements are allowed.'
            },
            limit: {
                type: 'number',
                description: 'Maximum number of rows to return (default: 100, max: 1000)',
                default: 100
            }
        }
    }
};

/**
 * get_ansible_best_practices - Ansible coding guidelines
 * 
 * Returns comprehensive Ansible best practices for code generation.
 */
export const GET_BEST_PRACTICES_TOOL: Tool = {
    name: 'get_ansible_best_practices',
    description: `Get Ansible coding guidelines and best practices for AI-assisted development.

This tool returns comprehensive guidelines covering:
- Guiding principles (Zen of Ansible)
- Project structure (collections, playbooks)
- Coding standards (YAML, Python, naming conventions)
- Role design patterns
- Collections best practices
- Inventories and variables
- Plugins and modules
- Playbook patterns
- Testing strategies

**Use this tool when**:
- Planning what content to create
- Generating Ansible code (playbooks, roles, modules)
- Reviewing or improving existing automation
- Understanding Ansible conventions

**Sections available**:
- full: Complete guidelines document
- principles: Zen of Ansible and guiding principles
- project_structure: Collection and playbook project layouts
- naming: Naming conventions for all content types
- roles: Role design, parameters, templates
- collections: Collection structure and organization
- playbooks: Playbook patterns and best practices
- testing: Testing strategies and validation

Returns the guidelines in Markdown format.`,
    inputSchema: {
        type: 'object',
        properties: {
            section: {
                type: 'string',
                description: 'Specific section to retrieve. Use "full" for complete document.',
                enum: ['full', 'principles', 'project_structure', 'naming', 'roles', 'collections', 'playbooks', 'testing'],
                default: 'full'
            }
        }
    }
};

/**
 * Get all Content Designer MCP tools
 */
export function getDesignerTools(): Tool[] {
    return [
        QUERY_DESIGN_DB_TOOL,
        GET_BEST_PRACTICES_TOOL
    ];
}

/**
 * Tool name constants for handler routing
 */
export const DESIGNER_TOOL_NAMES = {
    QUERY_DESIGN_DB: 'query_design_db',
    GET_BEST_PRACTICES: 'get_ansible_best_practices'
} as const;
