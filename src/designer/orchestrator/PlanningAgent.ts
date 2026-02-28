/**
 * Ansible Content Designer - Planning Agent (Agentic)
 * 
 * Uses tools to gather context and create an implementation plan.
 * Follows the same pattern as DependencyAssessmentAgent and AssessmentAgent.
 */

import * as vscode from 'vscode';
import type { 
    EnrichedRequirement,
    PlanItem,
    DesignDecision
} from '../types/designer';
import { DesignerDatabase } from '../database/DesignerDatabase';
import { getAgentToolService, AgentToolService } from '../services/AgentToolService';

/**
 * What a step addresses (requirements, decisions, best practices)
 */
export interface StepAddresses {
    /** Which requirements this step satisfies */
    requirements: string[];
    /** Which design decisions this step honors (e.g., "Q-001", "Q-002") */
    design_decisions: string[];
    /** Which best practices this step applies */
    best_practices: string[];
}

/**
 * Agent-proposed build step
 */
export interface AgentBuildStep {
    /** Order/sequence */
    sequence: number;
    /** Type: 'scaffold' (ansible-creator) or 'generate' (LLM content) or 'configure' */
    action: 'scaffold' | 'generate' | 'configure' | 'install';
    /** 2-3 sentence summary explaining WHY, WHAT, and HOW */
    summary: string;
    /** For scaffold: the ansible-creator command path like ['init', 'playbook'] */
    creator_command?: string[];
    /** For scaffold: the arguments to pass */
    creator_args?: Record<string, string>;
    /** For generate: the file path to create/modify */
    file_path?: string;
    /** For generate: description of what content to generate */
    content_description?: string;
    /** For install: collection to install */
    collection?: string;
    /** What this step addresses */
    addresses: StepAddresses;
}

/**
 * Verification that all requirements are addressed
 */
export interface PlanVerification {
    /** All REQ-* that have steps addressing them */
    requirements_addressed: string[];
    /** Design decisions reflected in steps */
    design_decisions_honored: string[];
    /** Best practices applied across steps */
    best_practices_applied: string[];
}

/**
 * Agent's proposed implementation plan
 */
export interface AgentPlan {
    /** Summary of the approach */
    summary: string;
    /** Rationale for key decisions */
    rationale: string;
    /** Collections to install (only if not already installed) */
    collections_to_install: string[];
    /** Verification that all requirements are met */
    verification: PlanVerification;
    /** Ordered build steps */
    steps: AgentBuildStep[];
}

/**
 * Tools available for planning
 */
const PLANNING_TOOLS = [
    'get_project_requirements',     // Get requirements and system guidance
    'get_design_decisions',         // Get answered design decisions
    'get_ansible_best_practices',   // Get coding standards
    'get_ansible_creator_schema',   // Get scaffolding options
    'list_ansible_collections',     // See installed collections
    'get_collection_plugins',       // List plugins in a collection
    'get_plugin_documentation',     // Get module parameter details
    'search_ansible_plugins'        // Search plugin index
];

/**
 * PlanningAgent - Agentic implementation planning
 */
export class PlanningAgent {
    private _db: DesignerDatabase;
    private _workspaceRoot: string;
    private _toolService: AgentToolService;
    private _logService: import('../services/AgentLogService').AgentLogService;
    private _maxIterations = 15;

    constructor(db: DesignerDatabase, workspaceRoot: string) {
        this._db = db;
        this._workspaceRoot = workspaceRoot;
        this._toolService = getAgentToolService();
        
        // Initialize logging
        const { getAgentLogService } = require('../services/AgentLogService');
        this._logService = getAgentLogService(workspaceRoot);
    }

    /**
     * Generate agent-driven implementation plan
     */
    public async generatePlan(requirements: EnrichedRequirement[]): Promise<AgentPlan> {
        this._logService.startPhase('planning');
        this._logService.startInteraction('Generating implementation plan');
        this._logService.log('info', 'Generating implementation plan');
        this._logService.log('info', `Processing ${requirements.length} requirements`);

        try {
            const plan = await this._generatePlanWithTools(requirements);
            
            // Store the plan in the database
            this._storePlan(plan, requirements);
            
            this._logService.log('info', `Generated plan with ${plan.steps.length} steps`);
            
            return plan;
        } catch (error) {
            this._logService.log('error', `Planning failed: ${error}`);
            return this._generateFallbackPlan(requirements);
        }
    }

    /**
     * Generate plan using agentic tool calling
     */
    private async _generatePlanWithTools(requirements: EnrichedRequirement[]): Promise<AgentPlan> {
        // Ensure tools are initialized
        await this._toolService.initialize();

        if (!vscode.lm?.selectChatModels) {
            this._logService.log('info', 'No LLM models available');
            return this._generateFallbackPlan(requirements);
        }

        const models = await vscode.lm.selectChatModels({});
        if (models.length === 0) {
            this._logService.log('info', 'No LLM models found');
            return this._generateFallbackPlan(requirements);
        }

        // Select best model (prefer Claude)
        const model = models.find(m => m.id.toLowerCase().includes('claude')) || models[0];
        this._logService.log('info', `Using model: ${model.id}`);

        // Get our tools in VS Code format
        const tools = this._toolService.getToolsByName(PLANNING_TOOLS);
        this._logService.log('info', `Loaded ${tools.length} tools for planning`);

        // Build the prompt
        const prompt = this._buildPlanningPrompt();
        this._logService.logPrompt('PLANNING_AGENTIC_PROMPT', prompt, model.id);

        // Build conversation history
        const messages: vscode.LanguageModelChatMessage[] = [
            vscode.LanguageModelChatMessage.User(prompt)
        ];

        let iterations = 0;
        
        while (iterations < this._maxIterations) {
            iterations++;
            this._logService.log('debug', `Planning iteration ${iterations}/${this._maxIterations}`);

            // Send request WITH tools
            const response = await model.sendRequest(messages, {
                tools,
                toolMode: vscode.LanguageModelChatToolMode.Auto
            });

            // Process the stream
            let textParts: string[] = [];
            const toolCalls: vscode.LanguageModelToolCallPart[] = [];

            for await (const part of response.stream) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    textParts.push(part.value);
                } else if (part instanceof vscode.LanguageModelToolCallPart) {
                    toolCalls.push(part);
                    this._logService.log('tool_call', `Tool call requested: ${part.name}`, {
                        callId: part.callId,
                        input: part.input
                    });
                }
            }

            const fullText = textParts.join('');
            this._logService.logResponse(fullText);

            // If no tool calls, check if we have a final plan
            if (toolCalls.length === 0) {
                const plan = this._extractPlanFromResponse(fullText);
                if (plan) {
                    this._logService.logParsed(plan, `Extracted plan with ${plan.steps.length} steps`);
                    return plan;
                }
                
                // No plan and no tool calls - we're done
                this._logService.log('info', 'No tool calls and no plan found, ending');
                return this._generateFallbackPlan(requirements);
            }

            // Execute each tool call
            for (const toolCall of toolCalls) {
                this._logService.log('info', `Executing tool: ${toolCall.name}`);
                
                try {
                    const result = await this._toolService.callTool(
                        toolCall.name,
                        toolCall.input as Record<string, unknown>
                    );
                    
                    this._logService.log('tool_result', `Tool ${toolCall.name} completed`, {
                        result_preview: result.substring(0, 500)
                    });

                    // Add assistant message with tool call
                    messages.push(vscode.LanguageModelChatMessage.Assistant([
                        new vscode.LanguageModelToolCallPart(toolCall.callId, toolCall.name, toolCall.input)
                    ]));

                    // Add tool result
                    messages.push(vscode.LanguageModelChatMessage.User([
                        new vscode.LanguageModelToolResultPart(toolCall.callId, [
                            new vscode.LanguageModelTextPart(result)
                        ])
                    ]));
                } catch (error) {
                    this._logService.log('error', `Tool ${toolCall.name} failed: ${error}`);
                    
                    // Add error result
                    messages.push(vscode.LanguageModelChatMessage.Assistant([
                        new vscode.LanguageModelToolCallPart(toolCall.callId, toolCall.name, toolCall.input)
                    ]));
                    messages.push(vscode.LanguageModelChatMessage.User([
                        new vscode.LanguageModelToolResultPart(toolCall.callId, [
                            new vscode.LanguageModelTextPart(`Error: ${error}`)
                        ])
                    ]));
                }
            }
        }

        this._logService.log('info', 'Max iterations reached');
        return this._generateFallbackPlan(requirements);
    }

    /**
     * Build the planning prompt
     */
    private _buildPlanningPrompt(): string {
        // Get project info
        const project = this._db.get<{ type: string; namespace: string; name: string }>(`
            SELECT type, namespace, name FROM project WHERE id = 1
        `);

        const projectContext = project 
            ? `- Type: ${project.type}\n- Namespace: ${project.namespace}\n- Name: ${project.name}`
            : 'Project info not available';

        return `You are an expert Ansible automation architect creating an implementation plan.

## YOUR MISSION
Create a detailed implementation plan based on requirements and design decisions.

## UNDERSTANDING THE TASK LIST FORMAT
When you call **get_project_requirements**, you receive a structured task list with two types:

**SYS-* (System Guidance):** These are YOUR operational instructions.
- Execute them IN ORDER (SYS-001, SYS-002, SYS-003...)
- Each step provides context that informs your plan

**REQ-* (User Requirements):** These are what needs to be built.
- Each REQ-* should result in specific build steps
- Use design decisions to understand HOW to build each

## PROJECT CONTEXT
${projectContext}
Workspace: ${this._workspaceRoot}

## WORKFLOW
1. Call **get_project_requirements**(include_system: true) to get SYS-* and REQ-*
2. Execute each **SYS-*** instruction (call the tools it specifies)
3. Call **get_design_decisions**() to see user's choices for each REQ-*
4. Call **get_ansible_creator_schema**() to understand scaffolding options
5. For each REQ-*, call **get_plugin_documentation** for relevant modules
6. Generate the implementation plan

## AVAILABLE TOOLS
- get_project_requirements: Get SYS-* guidance and REQ-* requirements
- get_design_decisions: Get user's design choices for each requirement
- get_ansible_best_practices: Ansible coding conventions
- get_ansible_creator_schema: Project scaffolding options (init, add role, etc.)
- list_ansible_collections: Installed collections
- get_collection_plugins: Plugins in a collection
- get_plugin_documentation: Module parameter details
- search_ansible_plugins: Search plugin index

## OUTPUT FORMAT
After gathering context, output your plan as JSON:
\`\`\`json
{
  "summary": "Brief overview of the implementation approach",
  "rationale": "Key decisions and why",
  "collections_to_install": ["namespace.collection"],
  "verification": {
    "requirements_addressed": ["REQ-001", "REQ-002"],
    "design_decisions_honored": ["Q-001: server_type=cpx11", "Q-002: location=fsn1"],
    "best_practices_applied": ["FQCN module names", "Idempotent tasks", "Role-based organization"]
  },
  "steps": [
    {
      "sequence": 1,
      "action": "scaffold",
      "summary": "Initialize the playbook project structure using ansible-creator. This establishes the standard Ansible project layout with proper directory structure, following best practices for maintainability. Addresses REQ-001 (scaffolding requirement).",
      "creator_command": ["init", "playbook"],
      "creator_args": {
        "collection-name": "namespace.project_name",
        "path": "./"
      },
      "addresses": {
        "requirements": ["REQ-001"],
        "design_decisions": [],
        "best_practices": ["Standard project structure", "Collection-based organization"]
      }
    },
    {
      "sequence": 2,
      "action": "scaffold",
      "summary": "Create a dedicated role for Hetzner Cloud server provisioning. Roles provide reusability and clear separation of concerns. This role will encapsulate all server creation logic, making it easy to provision multiple servers with different configurations.",
      "creator_command": ["add", "resource", "role"],
      "creator_args": {
        "role_name": "hetzner_server",
        "path": "./collections/ansible_collections/namespace/project"
      },
      "addresses": {
        "requirements": ["REQ-002"],
        "design_decisions": [],
        "best_practices": ["Role-based organization", "Descriptive naming"]
      }
    },
    {
      "sequence": 3,
      "action": "generate",
      "summary": "Implement the hetzner_server role tasks using the hetzner.hcloud.server module. Tasks will use FQCN, handle idempotency via state=present, and configure the server according to design decisions (cpx11 type, fsn1 location, SSH key authentication).",
      "file_path": "roles/hetzner_server/tasks/main.yml",
      "content_description": "Tasks using hetzner.hcloud.server with: state=present, server_type from Q-002, location from Q-004, SSH keys from Q-005, error handling with block/rescue",
      "addresses": {
        "requirements": ["REQ-002"],
        "design_decisions": ["Q-001", "Q-002", "Q-004", "Q-005"],
        "best_practices": ["FQCN", "Idempotency", "Error handling"]
      }
    }
  ]
}
\`\`\`

## PLAN STRUCTURE
- **Steps are SEQUENTIAL** - Each step builds on previous steps
- **One step can address MULTIPLE requirements** - Don't create redundant steps
- **Every step has a summary** - 2-3 sentences explaining:
  - WHY: Why this step exists in the plan
  - WHAT: What it accomplishes
  - HOW: Which best practices, requirements, or design decisions it addresses

## ACTION TYPES
- **scaffold**: Run ansible-creator (provide creator_command and creator_args)
- **generate**: Generate file content (provide file_path and content_description)
- **install**: Install a collection (provide collection name) - only if not already installed
- **configure**: Modify configuration (provide file_path and what to configure)

## VERIFICATION REQUIREMENTS
Before outputting the plan, verify:
1. **All REQ-* requirements** have at least one step addressing them
2. **All answered design decisions** are reflected in the relevant steps
3. **Key best practices** from get_ansible_best_practices are applied

List what you've verified in the "verification" section.

## IMPORTANT RULES
1. **Use get_ansible_creator_schema** to get the EXACT parameter names for creator commands
2. **Role names must be descriptive**: \`hetzner_server\`, \`docker_deploy\` - NOT \`req002_role\`
3. **Exclude already-installed collections** from collections_to_install
4. **Content descriptions should reference specific design decision answers**

## START NOW
Call get_project_requirements(include_system: true) and execute each SYS-* instruction.`;
    }

    /**
     * Extract plan from LLM response
     */
    private _extractPlanFromResponse(text: string): AgentPlan | null {
        // Try to find JSON in the response
        const jsonMatch = text.match(/```json\s*([\s\S]*?)```/) || 
                          text.match(/\{[\s\S]*"steps"[\s\S]*\}/);
        
        if (!jsonMatch) {
            return null;
        }

        try {
            const jsonStr = jsonMatch[1] || jsonMatch[0];
            const parsed = JSON.parse(jsonStr);
            
            // Validate structure
            if (!parsed.steps || !Array.isArray(parsed.steps)) {
                return null;
            }

            const verification = parsed.verification as Record<string, string[]> | undefined;

            return {
                summary: parsed.summary || 'Implementation plan',
                rationale: parsed.rationale || '',
                collections_to_install: parsed.collections_to_install || [],
                verification: {
                    requirements_addressed: verification?.requirements_addressed || [],
                    design_decisions_honored: verification?.design_decisions_honored || [],
                    best_practices_applied: verification?.best_practices_applied || []
                },
                steps: parsed.steps.map((s: Record<string, unknown>, i: number) => {
                    const addresses = s.addresses as Record<string, string[]> | undefined;
                    // Support both old format (requirement_refs) and new format (addresses)
                    const reqRefs = (s.requirement_refs as string[]) || addresses?.requirements || [];
                    
                    return {
                        sequence: (s.sequence as number) || i + 1,
                        action: (s.action as string) || 'generate',
                        summary: (s.summary as string) || (s.description as string) || '',
                        creator_command: s.creator_command as string[] | undefined,
                        creator_args: s.creator_args as Record<string, string> | undefined,
                        file_path: s.file_path as string | undefined,
                        content_description: s.content_description as string | undefined,
                        collection: s.collection as string | undefined,
                        addresses: {
                            requirements: reqRefs,
                            design_decisions: addresses?.design_decisions || [],
                            best_practices: addresses?.best_practices || []
                        }
                    };
                })
            };
        } catch (error) {
            console.error('PlanningAgent: Failed to parse plan JSON:', error);
            return null;
        }
    }

    /**
     * Store the plan in the database
     */
    private _storePlan(plan: AgentPlan, requirements: EnrichedRequirement[]): void {
        this._db.transaction(() => {
            // Clear existing plan items
            this._db.run(`DELETE FROM plan_items`);
            
            // Store each step as a plan item
            let itemNum = 1;
            for (const step of plan.steps) {
                const id = `ITEM-${String(itemNum++).padStart(3, '0')}`;
                
                // Link to first requirement addressed (for backwards compatibility)
                const reqId = step.addresses.requirements[0] || requirements[0]?.id;
                
                // Store the step details as JSON in description
                const stepDetails = JSON.stringify({
                    action: step.action,
                    summary: step.summary,
                    creator_command: step.creator_command,
                    creator_args: step.creator_args,
                    file_path: step.file_path,
                    content_description: step.content_description,
                    collection: step.collection,
                    addresses: step.addresses
                });

                this._db.run(`
                    INSERT INTO plan_items (id, requirement_id, type, name, description, status, sequence)
                    VALUES (?, ?, ?, ?, ?, 'proposed', ?)
                `, id, reqId, step.action, step.summary, stepDetails, step.sequence);
            }

            // Log the plan creation with verification info
            this._db.logHistory('plan_created', 'plan', undefined, 'agent', {
                summary: plan.summary,
                rationale: plan.rationale,
                step_count: plan.steps.length,
                collections: plan.collections_to_install,
                verification: plan.verification
            });
        });
    }

    /**
     * Generate a fallback plan when LLM fails
     */
    private _generateFallbackPlan(requirements: EnrichedRequirement[]): AgentPlan {
        const steps: AgentBuildStep[] = [];
        let seq = 1;
        const userReqs = requirements.filter(r => r.id.startsWith('REQ-'));

        // Get project info
        const project = this._db.get<{ type: string; namespace: string; name: string }>(`
            SELECT type, namespace, name FROM project WHERE id = 1
        `);

        // Add project scaffolding step
        if (project) {
            const typeMap: Record<string, string> = {
                'playbook_collection': 'playbook',
                'collection': 'collection',
                'execution_environment': 'execution_env'
            };
            
            steps.push({
                sequence: seq++,
                action: 'scaffold',
                summary: `Initialize the ${project.type} project structure using ansible-creator. This establishes the foundation for all subsequent content and follows Ansible best practices for project organization.`,
                creator_command: ['init', typeMap[project.type] || 'playbook'],
                creator_args: {
                    'collection-name': `${project.namespace}.${project.name}`,
                    'path': './'
                },
                addresses: {
                    requirements: ['REQ-001'],
                    design_decisions: [],
                    best_practices: ['Standard project structure']
                }
            });
        }

        // Add a step for each user requirement (skip SYS-* and REQ-001)
        for (const req of userReqs) {
            if (req.id === 'REQ-001') {
                continue; // Already handled by scaffolding
            }
            
            steps.push({
                sequence: seq++,
                action: 'generate',
                summary: `Implement requirement ${req.id}: ${req.description.substring(0, 80)}. This step will generate the necessary Ansible content to fulfill this user requirement.`,
                file_path: `playbooks/${req.id.toLowerCase()}.yml`,
                content_description: req.description,
                addresses: {
                    requirements: [req.id],
                    design_decisions: [],
                    best_practices: []
                }
            });
        }

        return {
            summary: 'Fallback plan - LLM was unavailable',
            rationale: 'Basic structure generated without AI assistance',
            collections_to_install: [],
            verification: {
                requirements_addressed: userReqs.map(r => r.id),
                design_decisions_honored: [],
                best_practices_applied: []
            },
            steps
        };
    }

    /**
     * Get plan items from database
     */
    public getPlanItems(): PlanItem[] {
        return this._db.all<PlanItem>(`
            SELECT * FROM plan_items ORDER BY sequence, id
        `);
    }

    /**
     * Get plan item history
     */
    public getItemHistory(itemId: string): Array<{ entry_type: string; content: string; by: string; created_at: string }> {
        return this._db.all(`
            SELECT * FROM plan_item_history WHERE plan_item_id = ? ORDER BY version
        `, itemId);
    }

    /**
     * Add history entry for a plan item
     */
    public addPlanItemHistory(itemId: string, entryType: string, content: string, by: string): void {
        const version = this._db.get<{ max_version: number }>(`
            SELECT COALESCE(MAX(version), 0) + 1 as max_version FROM plan_item_history WHERE plan_item_id = ?
        `, itemId)?.max_version || 1;

        this._db.run(`
            INSERT INTO plan_item_history (plan_item_id, version, entry_type, content, by)
            VALUES (?, ?, ?, ?, ?)
        `, itemId, version, entryType, content, by);
    }

    /**
     * Update plan item status
     */
    public updatePlanItemStatus(itemId: string, status: string): void {
        this._db.run(`
            UPDATE plan_items SET status = ? WHERE id = ?
        `, status, itemId);
    }

    /**
     * Approve all proposed items
     */
    public approveAllItems(): void {
        this._db.run(`
            UPDATE plan_items SET status = 'approved' WHERE status = 'proposed'
        `);
    }

    /**
     * Approve a single item
     */
    public approveItem(itemId: string): void {
        this._db.run(`
            UPDATE plan_items SET status = 'approved' WHERE id = ?
        `, itemId);
        this.addPlanItemHistory(itemId, 'approved', 'Item approved by user', 'user');
    }

    /**
     * Reject a single item
     */
    public rejectItem(itemId: string, reason?: string): void {
        this._db.run(`
            UPDATE plan_items SET status = 'rejected' WHERE id = ?
        `, itemId);
        this.addPlanItemHistory(itemId, 'rejected', reason || 'Item rejected by user', 'user');
    }

    /**
     * Delete a plan item
     */
    public deleteItem(itemId: string): void {
        this._db.run(`
            DELETE FROM plan_items WHERE id = ?
        `, itemId);
    }

    /**
     * Get collections to install from plan
     */
    public getCollectionsToInstall(): string[] {
        const items = this._db.all<{ description: string }>(`
            SELECT description FROM plan_items WHERE type = 'install'
        `);

        const collections: string[] = [];
        for (const item of items) {
            try {
                const details = JSON.parse(item.description);
                if (details.collection) {
                    collections.push(details.collection);
                }
            } catch {
                // Not JSON
            }
        }
        return collections;
    }

    /**
     * Add a comment to an item (triggers regeneration)
     */
    public async addComment(itemId: string, comment: string): Promise<void> {
        this.addPlanItemHistory(itemId, 'comment', comment, 'user');
        this._db.run(`
            UPDATE plan_items SET status = 'needs_clarification' WHERE id = ?
        `, itemId);
    }

    /**
     * Regenerate a single item based on comments
     */
    public async regenerateItem(itemId: string): Promise<void> {
        // Get the item and its history
        const item = this._db.get<PlanItem>(`
            SELECT * FROM plan_items WHERE id = ?
        `, itemId);

        if (!item) {
            return;
        }

        const history = this.getItemHistory(itemId);
        const comments = history.filter(h => h.entry_type === 'comment').map(h => h.content);

        if (comments.length === 0) {
            // No comments, just approve as-is
            this.approveItem(itemId);
            return;
        }

        // For now, just mark as revised - full regeneration would need LLM
        this._db.run(`
            UPDATE plan_items SET status = 'revised' WHERE id = ?
        `, itemId);
        this.addPlanItemHistory(itemId, 'revised', 'Item marked for review', 'user');
    }
}
