/**
 * Ansible Content Designer - Dependency Assessment Agent
 * 
 * Phase 1 of the two-phase assessment:
 * 1. Analyzes requirements to identify needed Ansible collections
 * 2. Searches Galaxy for relevant collections
 * 3. Generates confirmation questions for the user
 * 4. Installs confirmed collections
 * 
 * Uses VS Code's native tool calling API for reliable tool execution.
 */

import * as vscode from 'vscode';
import type { EnrichedRequirement, AssessmentQuestion, QuestionType, QuestionPriority, IdentifiedCollection } from '../types/designer';
import { DesignerDatabase } from '../database/DesignerDatabase';
import { CollectionsService } from '../../services/CollectionsService';
import { getAgentToolService, AgentToolService } from '../services/AgentToolService';

/**
 * Keywords mapped to likely collections
 */
const COLLECTION_HINTS: Record<string, string[]> = {
    // Cloud providers
    'aws': ['amazon.aws', 'community.aws'],
    'amazon': ['amazon.aws', 'community.aws'],
    'ec2': ['amazon.aws'],
    'azure': ['azure.azcollection'],
    'gcp': ['google.cloud'],
    'google cloud': ['google.cloud'],
    'hetzner': ['hetzner.hcloud'],
    'digitalocean': ['community.digitalocean'],
    'linode': ['linode.cloud'],
    'vultr': ['vultr.cloud'],
    'vmware': ['community.vmware', 'vmware.vmware_rest'],
    'proxmox': ['community.general'],
    'openstack': ['openstack.cloud'],
    
    // Containers & Kubernetes
    'docker': ['community.docker'],
    'container': ['community.docker', 'containers.podman'],
    'podman': ['containers.podman'],
    'kubernetes': ['kubernetes.core'],
    'k8s': ['kubernetes.core'],
    'helm': ['kubernetes.core'],
    'openshift': ['redhat.openshift'],
    
    // Networking
    'cisco': ['cisco.ios', 'cisco.nxos', 'cisco.aci'],
    'juniper': ['junipernetworks.junos'],
    'arista': ['arista.eos'],
    'fortinet': ['fortinet.fortios'],
    'palo alto': ['paloaltonetworks.panos'],
    'f5': ['f5networks.f5_modules'],
    'network': ['ansible.netcommon'],
    
    // Databases
    'postgresql': ['community.postgresql'],
    'postgres': ['community.postgresql'],
    'mysql': ['community.mysql'],
    'mariadb': ['community.mysql'],
    'mongodb': ['community.mongodb'],
    'redis': ['community.general'],
    
    // Security & Identity
    'vault': ['community.hashi_vault'],
    'hashicorp': ['community.hashi_vault'],
    'keycloak': ['community.general'],
    'freeipa': ['freeipa.ansible_freeipa'],
    'ldap': ['community.general'],
    'certificate': ['community.crypto'],
    'ssl': ['community.crypto'],
    'tls': ['community.crypto'],
    
    // Configuration Management
    'windows': ['ansible.windows', 'community.windows'],
    'linux': ['ansible.posix', 'community.general'],
    'rhel': ['redhat.rhel_system_roles'],
    'systemd': ['ansible.posix'],
    'selinux': ['ansible.posix'],
    'firewall': ['ansible.posix'],
    
    // Monitoring & Observability  
    'grafana': ['grafana.grafana'],
    'prometheus': ['prometheus.prometheus'],
    'zabbix': ['community.zabbix'],
    'nagios': ['community.general'],
    'datadog': ['datadog.dd'],
    'splunk': ['splunk.es'],
};

/**
 * Tools the agent can use for dependency discovery
 */
const DEPENDENCY_TOOLS = [
    'get_project_requirements',     // Fetch requirements from Content Designer
    'get_design_decisions',         // Get existing design decisions (may be empty initially)
    'get_ansible_best_practices',   // Ansible best practices guidance
    'get_ansible_creator_schema',   // Understand project types and scaffolding options
    'list_ansible_collections',     // List installed collections
    'search_available_collections', // Search Galaxy and GitHub
    'list_source_collections',      // List from specific source
    'get_collection_plugins',       // List plugins in a collection
    'search_ansible_plugins',       // Search installed plugin index
    'get_plugin_documentation',     // Get plugin docs
    'install_ansible_collection'    // Install a collection
];

/**
 * DependencyAssessmentAgent - Identifies collections needed for requirements
 * 
 * Uses VS Code's native tool calling API for reliable LLM-driven tool use.
 */
export class DependencyAssessmentAgent {
    private _db: DesignerDatabase;
    private _collectionsService: CollectionsService;
    private _workspaceRoot: string;
    private _logService: import('../services/AgentLogService').AgentLogService;
    private _toolService: AgentToolService;
    private _maxIterations = 10;

    constructor(db: DesignerDatabase, workspaceRoot: string) {
        this._db = db;
        this._workspaceRoot = workspaceRoot;
        this._collectionsService = CollectionsService.getInstance();
        this._toolService = getAgentToolService();
        
        // Initialize logging
        const { getAgentLogService } = require('../services/AgentLogService');
        this._logService = getAgentLogService(workspaceRoot);
    }

    /**
     * Analyze requirements and generate dependency questions
     */
    public async generateDependencyQuestions(requirements: EnrichedRequirement[]): Promise<AssessmentQuestion[]> {
        this._logService.startPhase('dependency_assessment');
        this._logService.startInteraction('Generating dependency assessment questions');
        
        const questions: AssessmentQuestion[] = [];
        const identifiedCollections: Map<string, { reqs: Set<string>; reason: string }> = new Map();

        // Get currently installed collections
        this._logService.log('info', 'Checking installed collections');
        const installedCollections = await this._getInstalledCollections();
        this._logService.log('info', `Found ${Object.keys(installedCollections).length} installed collections`, {
            collections: Object.keys(installedCollections)
        });

        // Phase 1: Keyword-based identification (fast)
        for (const req of requirements) {
            const collections = this._identifyCollectionsFromText(req.description);
            for (const { fqcn, reason } of collections) {
                if (!identifiedCollections.has(fqcn)) {
                    identifiedCollections.set(fqcn, { reqs: new Set(), reason });
                }
                identifiedCollections.get(fqcn)!.reqs.add(req.id);
            }
        }

        // Phase 2: LLM-based identification with native tool calling
        const llmCollections = await this._identifyCollectionsWithLLM(requirements, installedCollections);
        for (const { fqcn, reason, requirementId } of llmCollections) {
            if (!identifiedCollections.has(fqcn)) {
                identifiedCollections.set(fqcn, { reqs: new Set(), reason });
            }
            if (requirementId) {
                identifiedCollections.get(fqcn)!.reqs.add(requirementId);
            }
        }

        // Store identified collections in database
        for (const [fqcn, { reqs, reason }] of identifiedCollections) {
            const reqId = reqs.values().next().value || null;
            this._db.run(`
                INSERT OR IGNORE INTO identified_collections (requirement_id, collection_fqcn, reason)
                VALUES (?, ?, ?)
            `, reqId, fqcn, reason);
        }

        // Generate questions for each identified collection
        let questionNum = 1;
        for (const [fqcn, { reqs, reason }] of identifiedCollections) {
            const reqId = reqs.values().next().value || requirements[0]?.id || 'REQ-001';
            
            // Check if question already exists
            const existing = this._db.get<{ id: number }>(`
                SELECT id FROM design_decisions 
                WHERE requirement_id = ? AND question_id LIKE 'DEP-%' AND question LIKE ?
            `, reqId, `%${fqcn}%`);
            
            if (existing) continue;

            // Determine if already installed
            const installedVersion = installedCollections[fqcn];
            const isInstalled = !!installedVersion;

            // Build choices based on installation state
            const choices = isInstalled ? [
                `Use installed version (${installedVersion})`,
                'Upgrade to latest version',
                'Skip - not needed'
            ] : [
                `Yes, install ${fqcn}`,
                'No, skip this collection'
            ];

            const question: AssessmentQuestion = {
                id: `DEP-${String(questionNum++).padStart(3, '0')}`,
                category: 'dependencies',
                question: isInstalled 
                    ? `The \`${fqcn}\` collection is already installed (v${installedVersion}). How would you like to proceed?`
                    : `Should we install the \`${fqcn}\` collection?`,
                type: 'single_choice' as QuestionType,
                choices,
                suggested_default: isInstalled ? 'use_installed' : 'install',
                rationale: reason,
                priority: 'high' as QuestionPriority,
                requirement_ref: reqId
            };

            questions.push(question);
        }

        // Store questions
        this._storeQuestions(questions);

        this._logService.log('info', `Generated ${questions.length} dependency questions`);
        this._logService.completeInteraction(true);
        this._logService.completePhase(`Identified ${identifiedCollections.size} collections, generated ${questions.length} questions`);

        return questions;
    }

    /**
     * Get installed collections using CollectionsService
     */
    private async _getInstalledCollections(): Promise<Record<string, string>> {
        const installed = await this._collectionsService.listInstalledCollections();
        const result: Record<string, string> = {};
        for (const coll of installed) {
            result[coll.name] = coll.version;
        }
        return result;
    }

    /**
     * Identify collections from text using keyword hints
     */
    private _identifyCollectionsFromText(text: string): Array<{ fqcn: string; reason: string }> {
        const results: Array<{ fqcn: string; reason: string }> = [];
        const lowerText = text.toLowerCase();
        
        for (const [keyword, collections] of Object.entries(COLLECTION_HINTS)) {
            if (lowerText.includes(keyword)) {
                for (const fqcn of collections) {
                    if (!results.some(r => r.fqcn === fqcn)) {
                        results.push({
                            fqcn,
                            reason: `Detected keyword "${keyword}" in requirement. ${fqcn} provides modules for this functionality.`
                        });
                    }
                }
            }
        }

        return results;
    }

    /**
     * Use LLM with NATIVE VS Code tool calling to identify collections
     * 
     * Uses model.sendRequest() with tools parameter and handles
     * LanguageModelToolCallPart responses properly.
     */
    private async _identifyCollectionsWithLLM(
        requirements: EnrichedRequirement[],
        installedCollections: Record<string, string>
    ): Promise<Array<{ fqcn: string; reason: string; requirementId?: string }>> {
        try {
            // Ensure tools are initialized
            await this._toolService.initialize();

            if (!vscode.lm?.selectChatModels) {
                this._logService.log('info', 'No LLM models available');
                return [];
            }

            const models = await vscode.lm.selectChatModels({});
            if (models.length === 0) {
                this._logService.log('info', 'No LLM models found');
                return [];
            }

            // Select best model (prefer Claude)
            const model = models.find(m => m.id.toLowerCase().includes('claude')) || models[0];
            this._logService.log('info', `Using model: ${model.id}`);

            // Get our tools in VS Code format
            const tools = this._toolService.getToolsByName(DEPENDENCY_TOOLS);
            this._logService.log('info', `Loaded ${tools.length} tools for dependency assessment`);

            // Use the minimal prompt - agent gets full instructions from SYS requirements via tools
            const { DEPENDENCY_ASSESSMENT_PROMPT } = await import('../prompts/dependencyAssessment');
            const prompt = DEPENDENCY_ASSESSMENT_PROMPT;

            this._logService.logPrompt('DEPENDENCY_NATIVE_TOOL_PROMPT', prompt, model.id);

            // Build conversation history
            const messages: vscode.LanguageModelChatMessage[] = [
                vscode.LanguageModelChatMessage.User(prompt)
            ];

            let iterations = 0;
            
            while (iterations < this._maxIterations) {
                iterations++;
                // Only log to file, not console - tool calls provide the useful info
                this._logService.log('debug', `Tool iteration ${iterations}/${this._maxIterations}`);

                // Send request WITH tools - this is the native way!
                const response = await model.sendRequest(messages, {
                    tools,
                    toolMode: vscode.LanguageModelChatToolMode.Auto
                });

                // Process the stream - may contain text AND tool calls
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

                // If no tool calls, check if we have a final answer
                if (toolCalls.length === 0) {
                    const collections = this._extractCollectionsFromResponse(fullText);
                    if (collections.length > 0) {
                        this._logService.logParsed(collections, `Extracted ${collections.length} collections from final answer`);
                        return collections;
                    }
                    
                    // No collections and no tool calls - we're done
                    this._logService.log('info', 'No tool calls and no collections found, ending');
                    return [];
                }

                // Execute each tool call using our AgentToolService
                for (const toolCall of toolCalls) {
                    this._logService.log('info', `Executing tool: ${toolCall.name}`);
                    
                    let resultText: string;
                    try {
                        // Use our AgentToolService to execute the tool
                        // This bypasses vscode.lm.invokeTool which requires a chat participant context
                        resultText = await this._toolService.callTool(
                            toolCall.name, 
                            toolCall.input as Record<string, unknown>
                        );

                        this._logService.log('tool_result', `Tool ${toolCall.name} completed`, {
                            result_preview: resultText.substring(0, 500)
                        });

                    } catch (error) {
                        this._logService.logError(`Tool ${toolCall.name} failed: ${error}`);
                        resultText = `Error: ${error instanceof Error ? error.message : String(error)}`;
                    }

                    // Add tool call and result to conversation for next iteration
                    messages.push(
                        vscode.LanguageModelChatMessage.Assistant([
                            new vscode.LanguageModelToolCallPart(toolCall.callId, toolCall.name, toolCall.input)
                        ])
                    );
                    messages.push(
                        vscode.LanguageModelChatMessage.User([
                            new vscode.LanguageModelToolResultPart(toolCall.callId, [
                                new vscode.LanguageModelTextPart(resultText)
                            ])
                        ])
                    );
                }
            }

            this._logService.log('info', `Max iterations (${this._maxIterations}) reached`);
            return [];

        } catch (error) {
            console.error('DependencyAssessmentAgent: Native tool calling error:', error);
            this._logService.logError(`Native tool calling error: ${error}`);
            return [];
        }
    }

    /**
     * Extract collections from LLM's final response
     */
    private _extractCollectionsFromResponse(response: string): Array<{ fqcn: string; reason: string; requirementId?: string }> {
        // Try to find JSON in code block
        const jsonMatch = response.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
        if (jsonMatch) {
            try {
                const parsed = JSON.parse(jsonMatch[1]);
                if (parsed.collections && Array.isArray(parsed.collections)) {
                    return parsed.collections.map((c: { fqcn: string; requirement_id?: string; reason: string }) => ({
                        fqcn: c.fqcn,
                        requirementId: c.requirement_id,
                        reason: c.reason
                    }));
                }
            } catch {
                // Not valid JSON
            }
        }

        // Try to find array directly
        const arrayMatch = response.match(/\[[\s\S]*?\]/);
        if (arrayMatch) {
            try {
                const parsed = JSON.parse(arrayMatch[0]);
                if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].fqcn) {
                    return parsed.map((c: { fqcn: string; requirement_id?: string; reason: string }) => ({
                        fqcn: c.fqcn,
                        requirementId: c.requirement_id,
                        reason: c.reason
                    }));
                }
            } catch {
                // Not valid JSON
            }
        }

        return [];
    }

    /**
     * Store dependency questions in database
     */
    private _storeQuestions(questions: AssessmentQuestion[]): void {
        for (const q of questions) {
            const existing = this._db.get<{ id: number }>(`
                SELECT id FROM design_decisions 
                WHERE requirement_id = ? AND question_id = ?
            `, q.requirement_ref, q.id);

            if (existing) continue;

            const choicesJson = q.choices ? JSON.stringify(q.choices) : null;

            this._db.run(`
                INSERT INTO design_decisions 
                (requirement_id, question_id, category, question, question_type, choices, suggested_default, rationale, stage)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'dependencies')
            `, q.requirement_ref, q.id, q.category, q.question, q.type, choicesJson, q.suggested_default, q.rationale);
        }
    }

    /**
     * Get confirmed collections ready to install
     */
    public getConfirmedCollections(): IdentifiedCollection[] {
        const confirmed = this._db.all<{
            id: number;
            collection_fqcn: string;
            requirement_id: string | null;
            reason: string | null;
            installed: number;
            answer: string;
        }>(`
            SELECT ic.id, ic.collection_fqcn, ic.requirement_id, ic.reason, ic.installed, dd.answer
            FROM identified_collections ic
            JOIN design_decisions dd ON dd.question LIKE '%' || ic.collection_fqcn || '%'
            WHERE dd.stage = 'dependencies' 
              AND dd.answer IS NOT NULL
              AND (dd.answer LIKE 'install%' OR dd.answer LIKE 'upgrade%' OR dd.answer LIKE 'Yes%')
        `);

        return confirmed.map(c => ({
            id: c.id,
            requirement_id: c.requirement_id || undefined,
            collection_fqcn: c.collection_fqcn,
            reason: c.reason || 'User confirmed installation',
            confirmed: true,
            installed: c.installed === 1
        }));
    }

    /**
     * Get the current assessment stage
     */
    public getCurrentStage(): 'dependencies' | 'content' {
        const proj = this._db.get<{ assessment_stage: string }>(`
            SELECT assessment_stage FROM project LIMIT 1
        `);
        return (proj?.assessment_stage as 'dependencies' | 'content') || 'dependencies';
    }

    /**
     * Get count of collections that need to be installed
     */
    public getCollectionsToInstallCount(): number {
        const count = this._db.get<{ count: number }>(`
            SELECT COUNT(*) as count
            FROM identified_collections ic
            JOIN design_decisions dd ON dd.question LIKE '%' || ic.collection_fqcn || '%'
            WHERE dd.stage = 'dependencies' 
              AND dd.answer IS NOT NULL
              AND (dd.answer LIKE 'Yes%' OR dd.answer LIKE 'install%')
              AND ic.installed = 0
        `);
        return count?.count || 0;
    }

    /**
     * Check if dependency assessment is complete (all questions answered)
     */
    public isDependencyAssessmentComplete(): boolean {
        const unanswered = this._db.get<{ count: number }>(`
            SELECT COUNT(*) as count
            FROM design_decisions
            WHERE stage = 'dependencies' AND answer IS NULL
        `);
        return (unanswered?.count || 0) === 0;
    }

    /**
     * Mark collections with "Use existing version" as installed
     */
    public markUseExistingAsInstalled(): void {
        this._db.run(`
            UPDATE identified_collections
            SET installed = 1
            WHERE collection_fqcn IN (
                SELECT DISTINCT 
                    REPLACE(REPLACE(question, 'The \`', ''), '\` collection is already installed', '')
                FROM design_decisions
                WHERE stage = 'dependencies' 
                  AND answer LIKE 'Use installed%'
            )
        `);
    }

    /**
     * Advance to content assessment stage
     */
    public advanceToContentStage(): void {
        this._db.run(`
            UPDATE project SET assessment_stage = 'content' WHERE assessment_stage = 'dependencies'
        `);
    }

    /**
     * Install confirmed collections
     * 
     * @param onProgress - Optional callback for progress updates
     * @returns Array of installation results
     */
    public async installConfirmedCollections(
        onProgress?: (collection: string, status: 'installing' | 'success' | 'failed', message?: string) => void
    ): Promise<Array<{ collection: string; success: boolean; error?: string }>> {
        const toInstall = this.getConfirmedCollections();
        const results: Array<{ collection: string; success: boolean; error?: string }> = [];

        for (const coll of toInstall) {
            if (coll.installed) {
                continue; // Already installed
            }

            const fqcn = coll.collection_fqcn;
            
            try {
                this._logService.log('info', `Installing collection: ${fqcn}`);
                onProgress?.(fqcn, 'installing');
                
                const result = await this._toolService.callTool('install_ansible_collection', {
                    collection_name: fqcn
                });

                if (result.includes('Error') || result.includes('failed')) {
                    results.push({ collection: fqcn, success: false, error: result });
                    onProgress?.(fqcn, 'failed', result);
                } else {
                    results.push({ collection: fqcn, success: true });
                    onProgress?.(fqcn, 'success');
                    // Mark as installed in database
                    this._db.run(`
                        UPDATE identified_collections 
                        SET installed = 1 
                        WHERE collection_fqcn = ?
                    `, fqcn);
                }
            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : String(error);
                results.push({ collection: fqcn, success: false, error: errorMsg });
                onProgress?.(fqcn, 'failed', errorMsg);
            }
        }

        this._logService.log('info', `Installation complete: ${results.filter(r => r.success).length} installed, ${results.filter(r => !r.success).length} failed`);
        return results;
    }
}
