/**
 * Ansible Content Designer - Autonomous Agent
 * 
 * This is the core agent that:
 * 1. Receives requirements and context
 * 2. Creates its own execution plan using available MCP tools
 * 3. Executes that plan autonomously
 * 4. Reports progress to the human
 * 
 * Think of this as an AI Playbook - we provide:
 * - Best practices and guidance
 * - Available MCP tools with their schemas
 * - Requirements and design decisions
 * - Human feedback loop
 * 
 * The agent decides what to do and does it.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { EnrichedRequirement } from '../types/designer';
import { DesignerDatabase } from '../database/DesignerDatabase';
import { GuidanceService } from '../services/GuidanceService';
import { LlmService } from '../services/LlmService';

// Import MCP tool generators
import { CreatorToolGenerator } from '@ansible/mcp-server';
import { CollectionsService } from '@ansible/core';

/**
 * Tool definition for the agent
 */
interface ToolDefinition {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}

/**
 * Tool call from the agent
 */
interface ToolCall {
    tool: string;
    args: Record<string, unknown>;
    reasoning: string;
}

/**
 * Agent execution step
 */
interface ExecutionStep {
    step: number;
    action: string;
    tool_call?: ToolCall;
    result?: string;
    status: 'pending' | 'executing' | 'complete' | 'failed';
    error?: string;
}

/**
 * Agent state
 */
export interface AgentState {
    phase: 'planning' | 'executing' | 'complete' | 'failed';
    plan: ExecutionStep[];
    currentStep: number;
    context: string;
    iterations: number;
}

/**
 * Progress callback
 */
export type AgentProgressCallback = (state: AgentState, message: string) => void;

/**
 * Build log entry
 */
interface BuildLogEntry {
    timestamp: string;
    type: 'info' | 'prompt' | 'plan' | 'step_start' | 'step_complete' | 'step_failed' | 'tool_call' | 'tool_result' | 'error' | 'recovery';
    message: string;
    details?: Record<string, unknown>;
}

/**
 * Complete build log structure
 */
interface BuildLog {
    started_at: string;
    completed_at?: string;
    status: 'running' | 'complete' | 'failed';
    project: {
        name?: string;
        namespace?: string;
        type?: string;
    };
    requirements_count: number;
    tools_available: string[];
    planning_prompt?: string;
    plan_response?: string;
    plan_summary: Array<{
        step: number;
        action: string;
        tool: string;
        status: string;
        result_summary?: string;
        error?: string;
    }>;
    entries: BuildLogEntry[];
    statistics: {
        total_steps: number;
        completed_steps: number;
        failed_steps: number;
        duration_ms?: number;
    };
    // File tracking for undo
    files_before: string[];
    files_created: string[];
}

/**
 * ContentDesignerAgent - Autonomous content generation
 */
export class ContentDesignerAgent {
    private _db: DesignerDatabase;
    private _guidanceService: GuidanceService;
    private _llmService: LlmService;
    private _workspaceRoot: string;
    private _creatorTools: CreatorToolGenerator | undefined;
    private _collectionsService: CollectionsService | undefined;
    private _onProgress: AgentProgressCallback | undefined;
    private _state: AgentState;
    private _availableTools: ToolDefinition[] = [];
    private _buildLog: BuildLog;
    private _buildStartTime: number = 0;
    private _logService: import('../services/AgentLogService').AgentLogService;

    constructor(db: DesignerDatabase, workspaceRoot: string) {
        this._db = db;
        this._workspaceRoot = workspaceRoot;
        this._guidanceService = new GuidanceService(workspaceRoot);
        this._llmService = LlmService.getInstance();
        this._state = {
            phase: 'planning',
            plan: [],
            currentStep: 0,
            context: '',
            iterations: 0
        };

        // Initialize logging
        const { getAgentLogService } = require('../services/AgentLogService');
        this._logService = getAgentLogService(workspaceRoot);

        // Initialize build log
        this._buildLog = this._initBuildLog();

        // Initialize tool providers
        try {
            this._creatorTools = new CreatorToolGenerator();
            this._collectionsService = CollectionsService.getInstance();
        } catch (error) {
            console.log('ContentDesignerAgent: Some tools not available');
        }
    }

    /**
     * Initialize a fresh build log
     */
    private _initBuildLog(): BuildLog {
        return {
            started_at: new Date().toISOString(),
            status: 'running',
            project: {},
            requirements_count: 0,
            tools_available: [],
            plan_summary: [],
            entries: [],
            statistics: {
                total_steps: 0,
                completed_steps: 0,
                failed_steps: 0
            },
            files_before: [],
            files_created: []
        };
    }

    /**
     * Get all files in workspace (excluding design/, node_modules/, .git/, etc.)
     */
    private _getWorkspaceFiles(): string[] {
        const files: string[] = [];
        const ignoreDirs = new Set(['design', 'node_modules', '.git', '.venv', 'venv', '__pycache__', '.tox', '.pytest_cache']);
        
        const walk = (dir: string, prefix: string = ''): void => {
            if (!fs.existsSync(dir)) return;
            
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (ignoreDirs.has(entry.name)) continue;
                
                const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
                
                if (entry.isDirectory()) {
                    walk(path.join(dir, entry.name), relativePath);
                } else {
                    files.push(relativePath);
                }
            }
        };
        
        walk(this._workspaceRoot);
        return files.sort();
    }

    /**
     * Snapshot files before build
     */
    private _snapshotFilesBefore(): void {
        this._buildLog.files_before = this._getWorkspaceFiles();
        this._logEntry('info', `Snapshot: ${this._buildLog.files_before.length} files before build`);
    }

    /**
     * Calculate files created during build
     */
    private _calculateFilesCreated(): void {
        const filesBefore = new Set(this._buildLog.files_before);
        const filesAfter = this._getWorkspaceFiles();
        
        this._buildLog.files_created = filesAfter.filter(f => !filesBefore.has(f));
        this._logEntry('info', `Build created ${this._buildLog.files_created.length} new files`);
    }

    /**
     * Undo the build by removing created files
     */
    public undoBuild(): { removed: string[]; errors: string[] } {
        const removed: string[] = [];
        const errors: string[] = [];

        // Load build log from disk
        const logPath = path.join(this._workspaceRoot, 'design', 'build-log.json');
        if (!fs.existsSync(logPath)) {
            return { removed: [], errors: ['No build log found'] };
        }

        const buildLog: BuildLog = JSON.parse(fs.readFileSync(logPath, 'utf-8'));
        
        if (!buildLog.files_created || buildLog.files_created.length === 0) {
            return { removed: [], errors: ['No files to undo'] };
        }

        // Remove files in reverse order (deepest first for clean directory removal)
        const filesToRemove = [...buildLog.files_created].sort().reverse();
        
        for (const file of filesToRemove) {
            const fullPath = path.join(this._workspaceRoot, file);
            try {
                if (fs.existsSync(fullPath)) {
                    fs.unlinkSync(fullPath);
                    removed.push(file);
                }
            } catch (error) {
                errors.push(`Failed to remove ${file}: ${error}`);
            }
        }

        // Try to remove empty directories
        const dirsToCheck = new Set<string>();
        for (const file of removed) {
            let dir = path.dirname(file);
            while (dir && dir !== '.') {
                dirsToCheck.add(dir);
                dir = path.dirname(dir);
            }
        }

        // Sort by depth (deepest first)
        const sortedDirs = Array.from(dirsToCheck).sort((a, b) => 
            b.split('/').length - a.split('/').length
        );

        for (const dir of sortedDirs) {
            const fullDir = path.join(this._workspaceRoot, dir);
            try {
                if (fs.existsSync(fullDir)) {
                    const contents = fs.readdirSync(fullDir);
                    if (contents.length === 0) {
                        fs.rmdirSync(fullDir);
                        removed.push(`${dir}/`);
                    }
                }
            } catch {
                // Directory not empty or other issue, ignore
            }
        }

        // Update build log to reflect undo
        buildLog.status = 'failed';
        buildLog.entries.push({
            timestamp: new Date().toISOString(),
            type: 'info',
            message: `Undo: removed ${removed.length} files`
        });
        fs.writeFileSync(logPath, JSON.stringify(buildLog, null, 2));

        return { removed, errors };
    }

    /**
     * Add entry to build log
     */
    private _logEntry(type: BuildLogEntry['type'], message: string, details?: Record<string, unknown>): void {
        this._buildLog.entries.push({
            timestamp: new Date().toISOString(),
            type,
            message,
            details
        });
        // Auto-save on each entry for crash recovery
        this._saveBuildLog();
    }

    /**
     * Save build log to design directory
     */
    private _saveBuildLog(): void {
        const designDir = path.join(this._workspaceRoot, 'design');
        if (!fs.existsSync(designDir)) {
            fs.mkdirSync(designDir, { recursive: true });
        }

        const logPath = path.join(designDir, 'build-log.json');
        fs.writeFileSync(logPath, JSON.stringify(this._buildLog, null, 2));
    }

    /**
     * Set progress callback
     */
    public onProgress(callback: AgentProgressCallback): void {
        this._onProgress = callback;
    }

    /**
     * Execute the full content design workflow
     */
    public async execute(cancellationToken?: vscode.CancellationToken): Promise<void> {
        // Start logging
        this._logService.startPhase('build');
        this._logService.startInteraction('Content build execution');
        
        // Reset build log for new execution
        this._buildLog = this._initBuildLog();
        this._buildStartTime = Date.now();
        this._logEntry('info', 'Build started');

        // Snapshot files before build for undo capability
        this._snapshotFilesBefore();

        try {
            // Phase 1: Gather all context
            this._emit('Gathering context...');
            this._logEntry('info', 'Gathering context from requirements, design decisions, and guidance');
            await this._gatherContext();

            // Phase 2: Discover available tools
            this._emit('Discovering available tools...');
            await this._discoverTools();
            this._buildLog.tools_available = this._availableTools.map(t => t.name);
            this._logEntry('info', `Discovered ${this._availableTools.length} tools`, {
                tools: this._buildLog.tools_available
            });

            // Phase 3: Let the agent plan
            this._emit('Agent is planning...');
            this._state.phase = 'planning';
            this._logEntry('info', 'Agent creating execution plan via LLM');
            await this._createPlan();

            // Phase 4: Execute the plan
            this._emit('Executing plan...');
            this._state.phase = 'executing';
            this._logEntry('info', `Executing plan with ${this._state.plan.length} steps`);
            await this._executePlan(cancellationToken);

            // Phase 5: Complete
            this._state.phase = 'complete';
            this._buildLog.status = 'complete';
            this._buildLog.completed_at = new Date().toISOString();
            this._buildLog.statistics.duration_ms = Date.now() - this._buildStartTime;
            
            // Calculate files created for undo
            this._calculateFilesCreated();
            
            this._logEntry('info', 'Build complete', {
                duration_ms: this._buildLog.statistics.duration_ms,
                completed_steps: this._buildLog.statistics.completed_steps,
                failed_steps: this._buildLog.statistics.failed_steps,
                files_created: this._buildLog.files_created.length
            });
            this._emit('Build complete!');
            
            // Complete logging
            this._logService.completeInteraction(true);
            this._logService.completePhase(`Build complete: ${this._buildLog.statistics.completed_steps} steps, ${this._buildLog.files_created.length} files created`);
            
        } catch (error) {
            this._state.phase = 'failed';
            this._buildLog.status = 'failed';
            this._buildLog.completed_at = new Date().toISOString();
            this._buildLog.statistics.duration_ms = Date.now() - this._buildStartTime;
            const errorMessage = error instanceof Error ? error.message : String(error);
            this._logEntry('error', `Build failed: ${errorMessage}`);
            
            // Log failure
            this._logService.logError('Build failed', error);
            this._logService.completeInteraction(false);
            this._logService.completePhase(`Build failed: ${errorMessage}`);
            
            throw error;
        }
    }

    /**
     * Gather all context for the agent
     */
    private async _gatherContext(): Promise<void> {
        const parts: string[] = [];

        // Project info
        const project = this._db.get<{ type: string; namespace: string; name: string; description?: string }>(`
            SELECT * FROM project WHERE id = 1
        `);
        if (project) {
            this._buildLog.project = {
                name: project.name,
                namespace: project.namespace,
                type: project.type
            };
            parts.push(`## Project
- Name: ${project.namespace}.${project.name}
- Type: ${project.type}
- Description: ${project.description || 'Not specified'}
- Workspace: ${this._workspaceRoot}`);
        }

        // Requirements
        const requirements = this._db.all<EnrichedRequirement>(`
            SELECT * FROM requirements ORDER BY id
        `);
        this._buildLog.requirements_count = requirements.length;
        
        if (requirements.length > 0) {
            parts.push(`## Requirements`);
            for (const req of requirements) {
                const decisions = this._db.all<{ category: string; question: string; answer: string }>(`
                    SELECT category, question, answer FROM design_decisions 
                    WHERE requirement_id = ? AND answer IS NOT NULL
                `, req.id);
                
                parts.push(`### ${req.id}: ${req.description}
Status: ${req.status}
Decisions:
${decisions.map(d => `- ${d.category}: ${d.answer}`).join('\n') || 'None'}`);
            }
        }

        // Best practices
        const guidance = await this._guidanceService.formatForPrompt();
        if (guidance) {
            parts.push(`## Best Practices and Guidance
${guidance}`);
        }

        this._state.context = parts.join('\n\n');
    }

    /**
     * Discover all available MCP tools
     */
    private async _discoverTools(): Promise<void> {
        this._availableTools = [];

        // Add ansible-creator tools
        if (this._creatorTools) {
            try {
                await this._creatorTools.initialize();
                const tools = this._creatorTools.getTools();
                for (const tool of tools) {
                    this._availableTools.push({
                        name: tool.name,
                        description: tool.description,
                        parameters: tool.inputSchema || {}
                    });
                }
            } catch (error) {
                console.log('ContentDesignerAgent: Creator tools not available');
            }
        }

        // Add file writing tool
        this._availableTools.push({
            name: 'write_file',
            description: 'Write content to a file in the project. Use for creating playbooks, roles, templates, etc.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Relative path from project root' },
                    content: { type: 'string', description: 'File content to write' }
                },
                required: ['path', 'content']
            }
        });

        // Add collection search tool
        this._availableTools.push({
            name: 'search_collections',
            description: 'Search for Ansible collections that might help with a task',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Search query (e.g., "docker", "aws", "networking")' }
                },
                required: ['query']
            }
        });

        // Add list installed collections tool
        this._availableTools.push({
            name: 'list_installed_collections',
            description: 'List all Ansible collections currently installed in the environment. Use this to check what collections are available before trying to install new ones.',
            parameters: {
                type: 'object',
                properties: {}
            }
        });

        // Add plugin documentation tool
        this._availableTools.push({
            name: 'get_plugin_docs',
            description: 'Get documentation for an Ansible module/plugin to understand its parameters',
            parameters: {
                type: 'object',
                properties: {
                    plugin_name: { type: 'string', description: 'FQCN of the plugin (e.g., ansible.builtin.copy)' }
                },
                required: ['plugin_name']
            }
        });

        // Add validation tool
        this._availableTools.push({
            name: 'validate_yaml',
            description: 'Validate an Ansible YAML file with ansible-lint',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Path to the YAML file to validate' }
                },
                required: ['path']
            }
        });

        // Add install collection tool
        this._availableTools.push({
            name: 'install_collection',
            description: 'Install an Ansible collection from Galaxy',
            parameters: {
                type: 'object',
                properties: {
                    collection: { type: 'string', description: 'Collection FQCN (e.g., community.docker)' }
                },
                required: ['collection']
            }
        });

        // Add best practices tool
        this._availableTools.push({
            name: 'get_ansible_best_practices',
            description: 'Get Ansible coding guidelines and best practices. Call this FIRST before generating any code to understand conventions.',
            parameters: {
                type: 'object',
                properties: {
                    section: { 
                        type: 'string', 
                        description: 'Section to get: full, principles, project_structure, naming, roles, collections, playbooks, testing',
                        enum: ['full', 'principles', 'project_structure', 'naming', 'roles', 'collections', 'playbooks', 'testing']
                    }
                }
            }
        });

        // Add query_design_db tool for agent to query project data
        this._availableTools.push({
            name: 'query_design_db',
            description: 'Execute a read-only SQL query against the Content Designer database. Use this to retrieve requirements, design decisions, and project details.',
            parameters: {
                type: 'object',
                properties: {
                    query: { 
                        type: 'string', 
                        description: 'SQL SELECT query to execute'
                    }
                },
                required: ['query']
            }
        });

        console.log(`ContentDesignerAgent: Discovered ${this._availableTools.length} tools`);
    }

    /**
     * Let the agent create its own execution plan
     */
    private async _createPlan(): Promise<void> {
        const toolsDescription = this._availableTools.map(t => 
            `### ${t.name}\n${t.description}\nParameters: ${JSON.stringify(t.parameters, null, 2)}`
        ).join('\n\n');

        // Get project info for prompt
        const project = this._db.get<{ type: string; namespace: string; name: string }>(`
            SELECT type, namespace, name FROM project WHERE id = 1
        `);

        // Get already-installed collections from assessment phase
        const installedCollections = this._db.all<{ collection_fqcn: string }>(`
            SELECT collection_fqcn FROM identified_collections WHERE installed = 1
        `).map(c => c.collection_fqcn);

        // Use centralized prompt template
        // NOTE: Requirements are NOT injected - agent must query for them
        const { BUILD_PLANNING_PROMPT, renderTemplate } = await import('../prompts');
        
        const prompt = renderTemplate(BUILD_PLANNING_PROMPT, {
            projectType: project?.type || 'unknown',
            projectNamespace: project?.namespace || 'unknown',
            projectName: project?.name || 'unknown',
            workspaceRoot: this._workspaceRoot,
            installedCollections: installedCollections.length > 0 
                ? installedCollections.map(c => `- ${c}`).join('\n') 
                : '- (none)',
            toolsDescription
        });
        
        // Log the prompt
        this._logService.logPrompt('BUILD_PLANNING_PROMPT', prompt);

        // Log the prompt to build log
        this._buildLog.planning_prompt = prompt;
        this._logEntry('prompt', 'Sending planning prompt to LLM', {
            prompt_length: prompt.length,
            tools_count: this._availableTools.length
        });

        // Use centralized system context
        const { BUILD_SYSTEM_CONTEXT } = await import('../prompts');
        
        const response = await this._llmService.request(prompt, {
            maxRetries: 3,
            expectJson: true,
            systemContext: BUILD_SYSTEM_CONTEXT
        });

        if (!response.success) {
            this._logEntry('error', `Planning failed: ${response.error}`);
            this._logService.logError('Planning failed', new Error(response.error));
            throw new Error(`Agent planning failed: ${response.error}`);
        }

        // Log raw response
        this._logService.logResponse(response.content);
        this._buildLog.plan_response = response.content;
        this._logEntry('plan', 'Received plan from LLM', {
            response_length: response.content.length
        });

        try {
            const plan = JSON.parse(response.content);
            this._state.plan = (plan.steps || plan).map((s: { step: number; action: string; tool_call?: ToolCall }) => ({
                ...s,
                status: 'pending' as const
            }));
            
            this._logService.logParsed(this._state.plan, `Parsed ${this._state.plan.length} plan steps`);
            
            // Update build log statistics
            this._buildLog.statistics.total_steps = this._state.plan.length;
            
            // Create plan summary for easy reading
            this._buildLog.plan_summary = this._state.plan.map(s => ({
                step: s.step,
                action: s.action,
                tool: s.tool_call?.tool || 'none',
                status: s.status
            }));
            
            this._emit(`Created plan with ${this._state.plan.length} steps`);
            this._logEntry('info', `Plan created with ${this._state.plan.length} steps`);
            
            // Store plan in database
            this._storePlan();
            
        } catch (error) {
            this._logEntry('error', `Failed to parse plan: ${error}`);
            throw new Error(`Failed to parse agent plan: ${error}`);
        }
    }

    /**
     * Map tool name to allowed plan item type
     */
    private _mapToolToType(toolName: string | undefined): 'scaffold' | 'generate' | 'install' | 'configure' {
        if (!toolName) return 'generate';
        
        // Scaffolding tools
        if (toolName.startsWith('ac_init_') || toolName.startsWith('ac_add_')) {
            return 'scaffold';
        }
        
        // Install tools
        if (toolName === 'install_collection') {
            return 'install';
        }
        
        // Configuration/validation tools
        if (toolName === 'validate_yaml' || toolName === 'get_ansible_best_practices' || 
            toolName === 'search_collections' || toolName === 'get_plugin_docs') {
            return 'configure';
        }
        
        // File creation = generate
        if (toolName === 'write_file') {
            return 'generate';
        }
        
        // Default to generate
        return 'generate';
    }

    /**
     * Store the plan in the database
     */
    private _storePlan(): void {
        this._db.transaction(() => {
            this._db.run('DELETE FROM plan_items');
            
            for (const step of this._state.plan) {
                const id = `ITEM-${String(step.step).padStart(3, '0')}`;
                const toolCall = step.tool_call;
                const itemType = this._mapToolToType(toolCall?.tool);
                
                this._db.run(`
                    INSERT INTO plan_items (id, requirement_id, type, name, description, status, sequence)
                    VALUES (?, ?, ?, ?, ?, 'proposed', ?)
                `, 
                    id,
                    null, // Will link later
                    itemType,
                    step.action,
                    JSON.stringify(toolCall || {}),
                    step.step
                );
            }
        });
    }

    /**
     * Execute the plan step by step
     */
    private async _executePlan(cancellationToken?: vscode.CancellationToken): Promise<void> {
        for (let i = 0; i < this._state.plan.length; i++) {
            if (cancellationToken?.isCancellationRequested) {
                this._logEntry('info', 'Build cancelled by user');
                break;
            }

            const step = this._state.plan[i];
            this._state.currentStep = i;
            step.status = 'executing';
            
            this._emit(`Step ${step.step}: ${step.action}`);
            this._logEntry('step_start', `Starting step ${step.step}: ${step.action}`, {
                step: step.step,
                tool: step.tool_call?.tool,
                args: step.tool_call?.args,
                reasoning: step.tool_call?.reasoning
            });

            try {
                if (step.tool_call) {
                    const result = await this._executeTool(step.tool_call);
                    step.result = result;
                    
                    this._logEntry('tool_result', `Tool result for step ${step.step}`, {
                        result_preview: result?.substring(0, 500)
                    });
                }
                step.status = 'complete';
                this._buildLog.statistics.completed_steps++;
                
                // Update plan summary
                const summaryItem = this._buildLog.plan_summary.find(s => s.step === step.step);
                if (summaryItem) {
                    summaryItem.status = 'complete';
                    summaryItem.result_summary = step.result?.substring(0, 200);
                }
                
                this._logEntry('step_complete', `Step ${step.step} completed successfully`);
                
                // Update database
                this._db.run(`
                    UPDATE plan_items SET status = 'complete' WHERE id = ?
                `, `ITEM-${String(step.step).padStart(3, '0')}`);
                
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                step.status = 'failed';
                step.error = message;
                this._buildLog.statistics.failed_steps++;
                
                // Update plan summary
                const summaryItem = this._buildLog.plan_summary.find(s => s.step === step.step);
                if (summaryItem) {
                    summaryItem.status = 'failed';
                    summaryItem.error = message;
                }
                
                this._emit(`Step ${step.step} failed: ${message}`);
                this._logEntry('step_failed', `Step ${step.step} failed: ${message}`, {
                    error: message,
                    tool: step.tool_call?.tool,
                    args: step.tool_call?.args
                });
                
                // Try to recover with agent help
                const recovered = await this._recoverFromError(step, message);
                if (!recovered) {
                    this._db.run(`
                        UPDATE plan_items SET status = 'failed' WHERE id = ?
                    `, `ITEM-${String(step.step).padStart(3, '0')}`);
                } else {
                    // Recovery succeeded, update stats
                    this._buildLog.statistics.failed_steps--;
                    this._buildLog.statistics.completed_steps++;
                    if (summaryItem) {
                        summaryItem.status = 'recovered';
                    }
                }
            }
        }
    }

    /**
     * Execute a single tool call
     */
    private async _executeTool(toolCall: ToolCall): Promise<string> {
        const { tool, args } = toolCall;
        
        // Log to console, UI, and build log
        const logMsg = `[TOOL] ${tool} ${JSON.stringify(args)}`;
        console.log(`ContentDesignerAgent: ${logMsg}`);
        this._emit(logMsg);
        this._logEntry('tool_call', `Calling tool: ${tool}`, { tool, args });

        switch (tool) {
            case 'write_file':
                return this._executeWriteFile(args);
                
            case 'search_collections':
                return this._executeSearchCollections(args);
            
            case 'list_installed_collections':
                return this._executeListInstalledCollections();
                
            case 'get_plugin_docs':
                return this._executeGetPluginDocs(args);
                
            case 'validate_yaml':
                return this._executeValidateYaml(args);
                
            case 'install_collection':
                return this._executeInstallCollection(args);
                
            case 'get_ansible_best_practices':
                return this._executeGetBestPractices(args);
            
            case 'query_design_db':
                return this._executeQueryDb(args);
                
            default:
                // Try ansible-creator tools
                if (this._creatorTools && tool.startsWith('ac_')) {
                    this._emit(`[MCP] Calling ansible-creator MCP tool: ${tool}`);
                    const result = await this._creatorTools.handleTool(tool, args);
                    if (result.isError) {
                        const errorText = result.content.map((c: { text: string }) => c.text).join('\n');
                        this._emit(`[ERROR] MCP tool failed: ${errorText}`);
                        throw new Error(errorText);
                    }
                    const successText = result.content.map((c: { text: string }) => c.text).join('\n');
                    this._emit(`[SUCCESS] ${successText.substring(0, 100)}`);
                    return successText;
                }
                
                this._emit(`[ERROR] Unknown tool: ${tool}`);
                throw new Error(`Unknown tool: ${tool}`);
        }
    }

    /**
     * Write file tool implementation
     */
    private _executeWriteFile(args: Record<string, unknown>): string {
        const filePath = args.path as string;
        const content = args.content as string;
        
        if (!filePath || !content) {
            throw new Error('write_file requires path and content');
        }

        const project = this._db.get<{ name: string }>('SELECT name FROM project WHERE id = 1');
        const fullPath = path.join(this._workspaceRoot, project?.name || '', filePath);
        
        // Ensure directory exists
        const dir = path.dirname(fullPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        
        fs.writeFileSync(fullPath, content);
        
        // Record artifact
        this._db.run(`
            INSERT INTO artifacts (path, content_hash)
            VALUES (?, ?)
            ON CONFLICT(path) DO UPDATE SET content_hash = ?, generated_at = CURRENT_TIMESTAMP
        `, filePath, this._hashContent(content), this._hashContent(content));
        
        return `Created: ${filePath}`;
    }

    /**
     * Search collections tool implementation
     */
    private async _executeSearchCollections(args: Record<string, unknown>): Promise<string> {
        const query = args.query as string;
        
        if (!this._collectionsService) {
            return 'Collections service not available';
        }

        await this._collectionsService.initialize();
        const collections = this._collectionsService.getCollections();
        
        const matches: string[] = [];
        const queryLower = query.toLowerCase();
        
        for (const [fqcn] of collections) {
            if (fqcn.toLowerCase().includes(queryLower)) {
                matches.push(fqcn);
            }
        }
        
        return matches.length > 0 
            ? `Found collections: ${matches.slice(0, 10).join(', ')}`
            : 'No matching collections found';
    }

    /**
     * List installed collections tool implementation
     */
    private async _executeListInstalledCollections(): Promise<string> {
        // First check the database for collections installed during assessment
        const dbCollections = this._db.all<{ collection_fqcn: string }>(`
            SELECT collection_fqcn FROM identified_collections WHERE installed = 1
        `);
        
        const installedFromAssessment = dbCollections.map(c => c.collection_fqcn);
        
        // Also check what's actually installed via ansible-galaxy
        let galaxyInstalled: string[] = [];
        try {
            const { getCommandService } = await import('@ansible/core');
            const commandService = getCommandService();
            const result = await commandService.runCommand('ansible-galaxy collection list --format json', {
                timeout: 30000
            });
            
            if (result.exitCode === 0 && result.stdout) {
                try {
                    const parsed = JSON.parse(result.stdout);
                    // Format is { "path": { "namespace.name": { "version": "x.y.z" } } }
                    for (const pathCollections of Object.values(parsed)) {
                        if (typeof pathCollections === 'object' && pathCollections !== null) {
                            galaxyInstalled.push(...Object.keys(pathCollections as object));
                        }
                    }
                } catch {
                    // JSON parse failed, try line-by-line parsing
                    const lines = result.stdout.split('\n');
                    for (const line of lines) {
                        const match = line.match(/^(\w+\.\w+)\s/);
                        if (match) {
                            galaxyInstalled.push(match[1]);
                        }
                    }
                }
            }
        } catch (error) {
            console.error('Failed to list galaxy collections:', error);
        }
        
        // Combine and dedupe
        const allInstalled = [...new Set([...installedFromAssessment, ...galaxyInstalled])];
        
        if (allInstalled.length === 0) {
            return 'No collections currently installed.';
        }
        
        return `Installed collections (${allInstalled.length}):\n${allInstalled.sort().map(c => `- ${c}`).join('\n')}`;
    }

    /**
     * Get plugin docs tool implementation
     */
    private async _executeGetPluginDocs(args: Record<string, unknown>): Promise<string> {
        const pluginName = args.plugin_name as string;
        
        if (!this._collectionsService) {
            return 'Collections service not available';
        }

        try {
            const doc = await this._collectionsService.getPluginDocumentation(pluginName, 'module');
            if (doc?.doc) {
                const params = Object.entries(doc.doc.options || {})
                    .slice(0, 10)
                    .map(([name, opt]) => {
                        const o = opt as { description?: string | string[]; required?: boolean };
                        return `- ${name}${o.required ? ' (REQUIRED)' : ''}: ${Array.isArray(o.description) ? o.description[0] : o.description || ''}`;
                    })
                    .join('\n');
                    
                return `## ${pluginName}\n${doc.doc.short_description || ''}\n\nParameters:\n${params}`;
            }
        } catch {
            // Plugin not found
        }
        
        return `Documentation not found for ${pluginName}`;
    }

    /**
     * Validate YAML tool implementation
     */
    private async _executeValidateYaml(args: Record<string, unknown>): Promise<string> {
        const filePath = args.path as string;
        
        // Try multiple possible file locations
        let fullPath = path.join(this._workspaceRoot, filePath);
        if (!fs.existsSync(fullPath)) {
            const project = this._db.get<{ name: string }>('SELECT name FROM project WHERE id = 1');
            fullPath = path.join(this._workspaceRoot, project?.name || '', filePath);
        }
        
        if (!fs.existsSync(fullPath)) {
            return `File not found: ${filePath}`;
        }

        try {
            // Use CommandService to run with proper venv PATH
            const { getCommandService } = await import('@ansible/core');
            const commandService = getCommandService();
            
            const result = await commandService.runTool('ansible-lint', ['--nocolor', `"${fullPath}"`], {
                timeout: 30000
            });
            
            if (result.exitCode === 0) {
                return 'Validation passed';
            } else {
                return `Validation issues:\n${result.stdout || result.stderr || 'Unknown error'}`;
            }
        } catch (error) {
            const e = error as { stdout?: string; stderr?: string; message?: string };
            return `Validation issues:\n${e.stdout || e.stderr || e.message || 'Unknown error'}`;
        }
    }

    /**
     * Install collection tool implementation
     */
    private async _executeInstallCollection(args: Record<string, unknown>): Promise<string> {
        const collection = args.collection as string;
        
        // Check if already installed during assessment phase
        const alreadyInstalled = this._db.get<{ installed: number }>(`
            SELECT installed FROM identified_collections 
            WHERE collection_fqcn = ? AND installed = 1
        `, collection);
        
        if (alreadyInstalled) {
            this._emit(`[SKIP] Collection ${collection} already installed during assessment`);
            return `Already installed: ${collection} (from assessment phase)`;
        }
        
        if (this._collectionsService) {
            try {
                await this._collectionsService.installCollection(collection);
                return `Installed: ${collection}`;
            } catch (error) {
                return `Collection may already be installed: ${collection}`;
            }
        }
        
        // Fallback to CommandService
        const { getCommandService } = await import('@ansible/core');
        const commandService = getCommandService();
        
        try {
            const result = await commandService.runCommand(`ansible-galaxy collection install ${collection}`, {
                timeout: 120000
            });
            if (result.exitCode === 0) {
                return `Installed: ${collection}`;
            }
            return `Failed to install: ${collection}\n${result.stderr}`;
        } catch {
            return `Failed to install: ${collection}`;
        }
    }

    /**
     * Get Ansible best practices tool implementation
     */
    private _executeGetBestPractices(args: Record<string, unknown>): string {
        const section = (args.section as string) || 'full';
        
        // Try to find the best practices file
        const possiblePaths = [
            path.join(__dirname, '..', '..', '..', 'resources', 'best_practises.md'),
            path.join(__dirname, '..', '..', 'resources', 'best_practises.md'),
            path.join(this._workspaceRoot, 'resources', 'best_practises.md')
        ];
        
        let content = '';
        
        for (const p of possiblePaths) {
            if (fs.existsSync(p)) {
                content = fs.readFileSync(p, 'utf-8');
                break;
            }
        }
        
        if (!content) {
            return 'Best practices document not found. Please ensure resources/best_practises.md exists.';
        }
        
        // If requesting full document, return it
        if (section === 'full') {
            return content;
        }
        
        // Extract specific section
        const sectionMap: Record<string, string> = {
            'principles': '## Guiding Principles',
            'project_structure': '### Project structure',
            'naming': '#### Naming Conventions',
            'roles': '#### Roles',
            'collections': '#### Collections',
            'playbooks': '#### Playbooks',
            'testing': '### Testing and Validation'
        };
        
        const heading = sectionMap[section];
        if (!heading) {
            return `Unknown section: ${section}. Available: ${Object.keys(sectionMap).join(', ')}`;
        }
        
        const startIndex = content.indexOf(heading);
        if (startIndex === -1) {
            return `Section "${section}" not found.`;
        }
        
        // Find next heading at same/higher level
        const headingLevel = heading.match(/^#+/)?.[0].length || 2;
        const regex = new RegExp(`^#{1,${headingLevel}}\\s`, 'm');
        
        const afterHeading = content.slice(startIndex + heading.length);
        const nextMatch = afterHeading.match(regex);
        const endIndex = nextMatch 
            ? startIndex + heading.length + afterHeading.indexOf(nextMatch[0])
            : content.length;
        
        return content.slice(startIndex, endIndex).trim();
    }

    /**
     * Execute query against design database
     */
    private _executeQueryDb(args: Record<string, unknown>): string {
        const query = args.query as string;
        
        if (!query) {
            return 'Error: query parameter is required';
        }
        
        // Only allow SELECT queries
        const trimmed = query.trim().toUpperCase();
        if (!trimmed.startsWith('SELECT')) {
            return 'Error: Only SELECT queries are allowed';
        }
        
        try {
            const result = this._db.executeReadonlyQuery(query, 100);
            
            if (!result.success) {
                return `Query Error: ${result.error}`;
            }
            
            if (!result.rows || result.rows.length === 0) {
                return 'Query returned no results.';
            }
            
            // Format as JSON for easy parsing
            return JSON.stringify(result.rows, null, 2);
        } catch (error) {
            return `Error: ${error instanceof Error ? error.message : error}`;
        }
    }

    /**
     * Try to recover from an error by asking the agent
     */
    private async _recoverFromError(step: ExecutionStep, error: string): Promise<boolean> {
        this._state.iterations++;
        
        if (this._state.iterations > 3) {
            this._logEntry('recovery', `Max recovery attempts reached for step ${step.step}`);
            return false;
        }

        this._emit(`Attempting recovery (attempt ${this._state.iterations}/3)...`);
        this._logEntry('recovery', `Recovery attempt ${this._state.iterations}/3 for step ${step.step}`, {
            error,
            original_tool_call: step.tool_call
        });

        const prompt = `A step in your execution plan failed. Please provide a corrected tool call.

## Failed Step
${step.action}

## Tool Call That Failed
${JSON.stringify(step.tool_call, null, 2)}

## Error
${error}

## Available Tools
${this._availableTools.map(t => `- ${t.name}: ${t.description}`).join('\n')}

## Instructions
Analyze the error and provide a corrected tool call. Output ONLY JSON:
\`\`\`json
{
  "tool": "tool_name",
  "args": { ... },
  "reasoning": "What I'm fixing"
}
\`\`\``;

        const response = await this._llmService.request(prompt, {
            maxRetries: 2,
            expectJson: true
        });

        if (!response.success) {
            return false;
        }

        try {
            const correctedCall = JSON.parse(response.content) as ToolCall;
            step.tool_call = correctedCall;
            
            const result = await this._executeTool(correctedCall);
            step.result = result;
            step.status = 'complete';
            
            this._emit(`Recovery successful: ${step.action}`);
            return true;
            
        } catch (retryError) {
            return false;
        }
    }

    /**
     * Simple content hash
     */
    private _hashContent(content: string): string {
        let hash = 0;
        for (let i = 0; i < content.length; i++) {
            const char = content.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return hash.toString(16);
    }

    /**
     * Emit progress event
     */
    private _emit(message: string): void {
        console.log(`ContentDesignerAgent: ${message}`);
        if (this._onProgress) {
            this._onProgress(this._state, message);
        }
    }

    /**
     * Get current state
     */
    public getState(): AgentState {
        return this._state;
    }
}
