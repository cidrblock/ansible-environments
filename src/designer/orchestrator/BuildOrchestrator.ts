/**
 * Ansible Content Designer - Build Orchestrator
 * 
 * Executes the agent's implementation plan. The agent determines what to build.
 * This orchestrator simply executes the plan:
 * 
 * - 'scaffold' actions: Run ansible-creator commands
 * - 'generate' actions: Use LLM to generate file content
 * - 'install' actions: Install collections
 * - 'configure' actions: Modify configuration files
 * 
 * Each step is validated and iterated until passing or max attempts reached.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { 
    PlanItem,
    Artifact
} from '../types/designer';
import { DesignerDatabase } from '../database/DesignerDatabase';
import { GuidanceService } from '../services/GuidanceService';
import { LlmService } from '../services/LlmService';
import { PlanningAgent, AgentBuildStep } from './PlanningAgent';

// Import services
import { CollectionsService, CreatorService } from '@ansible/core';
import { CreatorToolGenerator } from '@ansible/mcp-server';

const execAsync = promisify(exec);

// Maximum iterations per generate action
const MAX_ITERATIONS = 5;

/**
 * Build event for progress updates
 */
export interface BuildEvent {
    type: 'build_started' | 'step_started' | 'step_progress' | 'step_completed' | 'step_failed' |
          'scaffold_started' | 'scaffold_completed' | 'scaffold_failed' |
          'generate_started' | 'generate_iteration' | 'generate_completed' | 'generate_failed' |
          'validation_started' | 'validation_passed' | 'validation_failed' |
          'install_started' | 'install_completed' | 'install_failed' |
          'build_completed' | 'build_failed';
    itemId: string;
    message: string;
    iteration?: number;
    maxIterations?: number;
    errors?: string[];
    artifactPath?: string;
}

/**
 * Build progress callback
 */
export type BuildProgressCallback = (event: BuildEvent) => void;

/**
 * BuildOrchestrator - Executes the agent's plan
 */
export class BuildOrchestrator {
    private _db: DesignerDatabase;
    private _guidanceService: GuidanceService;
    private _llmService: LlmService;
    private _planningAgent: PlanningAgent;
    private _workspaceRoot: string;
    private _onProgress: BuildProgressCallback | undefined;
    private _collectionsService: CollectionsService | undefined;
    private _creatorService: CreatorService | undefined;
    private _creatorTools: CreatorToolGenerator | undefined;

    constructor(db: DesignerDatabase, workspaceRoot: string) {
        this._db = db;
        this._workspaceRoot = workspaceRoot;
        this._guidanceService = new GuidanceService(workspaceRoot);
        this._llmService = LlmService.getInstance();
        this._planningAgent = new PlanningAgent(db, workspaceRoot);
        
        // Initialize services
        try {
            this._collectionsService = CollectionsService.getInstance();
            this._creatorService = CreatorService.getInstance();
            this._creatorTools = new CreatorToolGenerator();
        } catch (error) {
            console.log('BuildOrchestrator: Some services not available, will use fallbacks');
        }
    }

    /**
     * Set progress callback
     */
    public onProgress(callback: BuildProgressCallback): void {
        this._onProgress = callback;
    }

    /**
     * Build all approved plan items
     */
    public async buildAll(cancellationToken?: vscode.CancellationToken): Promise<void> {
        const items = this._planningAgent.getPlanItems()
            .filter(item => item.status === 'approved')
            .sort((a, b) => (a.sequence || 0) - (b.sequence || 0));

        if (items.length === 0) {
            throw new Error('No approved items to build');
        }

        this._emit({
            type: 'build_started',
            itemId: '',
            message: `Starting build for ${items.length} approved steps`
        });

        let successCount = 0;
        let failCount = 0;

        // Execute each step in sequence
        for (const item of items) {
            if (cancellationToken?.isCancellationRequested) {
                break;
            }

            const success = await this._executeStep(item, cancellationToken);
            
            if (success) {
                successCount++;
            } else {
                failCount++;
            }
        }

        // Finalize
        await this._finalize();

        this._emit({
            type: 'build_completed',
            itemId: '',
            message: `Build completed: ${successCount} succeeded, ${failCount} failed`
        });
    }

    /**
     * Execute a single plan step based on its action type
     */
    private async _executeStep(item: PlanItem, cancellationToken?: vscode.CancellationToken): Promise<boolean> {
        // Parse the step details from description (stored as JSON)
        let stepDetails: AgentBuildStep;
        try {
            stepDetails = JSON.parse(item.description || '{}');
        } catch {
            // Fallback if description isn't JSON
            stepDetails = {
                action: item.type as 'scaffold' | 'generate' | 'install' | 'configure',
                summary: item.description || item.name,
                sequence: item.sequence || 0,
                addresses: {
                    requirements: [item.requirement_id],
                    design_decisions: [],
                    best_practices: []
                }
            };
        }

        this._emit({
            type: 'step_started',
            itemId: item.id,
            message: `Step ${item.id}: ${stepDetails.summary || item.name}`
        });

        // Update status
        this._db.run(`UPDATE plan_items SET status = 'in_progress' WHERE id = ?`, item.id);

        let success = false;

        try {
            switch (stepDetails.action) {
                case 'scaffold':
                    success = await this._executeScaffold(item, stepDetails, cancellationToken);
                    break;
                    
                case 'generate':
                    success = await this._executeGenerate(item, stepDetails, cancellationToken);
                    break;
                    
                case 'install':
                    success = await this._executeInstall(item, stepDetails);
                    break;
                    
                case 'configure':
                    success = await this._executeConfigure(item, stepDetails, cancellationToken);
                    break;
                    
                default:
                    console.log(`BuildOrchestrator: Unknown action type '${stepDetails.action}', treating as generate`);
                    success = await this._executeGenerate(item, stepDetails, cancellationToken);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this._emit({
                type: 'step_failed',
                itemId: item.id,
                message: `Step ${item.id} failed: ${message}`
            });
        }

        // Update final status
        const finalStatus = success ? 'complete' : 'failed';
        this._db.run(`UPDATE plan_items SET status = ? WHERE id = ?`, finalStatus, item.id);

        this._emit({
            type: success ? 'step_completed' : 'step_failed',
            itemId: item.id,
            message: `Step ${item.id} ${finalStatus}`
        });

        return success;
    }

    /**
     * Execute a scaffold action - run ansible-creator command
     */
    private async _executeScaffold(
        item: PlanItem,
        step: AgentBuildStep,
        _cancellationToken?: vscode.CancellationToken
    ): Promise<boolean> {
        this._emit({
            type: 'scaffold_started',
            itemId: item.id,
            message: `Scaffolding: ${step.summary}`
        });

        if (!step.creator_command || step.creator_command.length === 0) {
            this._emit({
                type: 'scaffold_failed',
                itemId: item.id,
                message: 'No ansible-creator command specified'
            });
            return false;
        }

        try {
            // Initialize creator tools if needed
            if (this._creatorTools) {
                await this._creatorTools.initialize();
                
                // Convert command path to tool name (e.g., ['init', 'playbook'] -> 'ac_init_play')
                const toolName = this._getToolNameFromCommand(step.creator_command);
                console.log(`BuildOrchestrator: Looking for tool '${toolName}' for command ${step.creator_command.join(' ')}`);
                
                const tools = this._creatorTools.getTools();
                const tool = tools.find(t => t.name === toolName);
                
                if (tool) {
                    console.log(`BuildOrchestrator: Found tool '${toolName}', executing with args:`, step.creator_args);
                    
                    const result = await this._creatorTools.handleTool(toolName, step.creator_args || {});
                    
                    if (result.isError) {
                        console.error('BuildOrchestrator: Tool execution failed:', result.content);
                        this._emit({
                            type: 'scaffold_failed',
                            itemId: item.id,
                            message: `ansible-creator failed: ${result.content.map((c: { text: string }) => c.text).join('\n')}`
                        });
                        return false;
                    }
                    
                    // Wait for terminal command if in VS Code
                    await new Promise(resolve => setTimeout(resolve, 3000));
                    
                    this._emit({
                        type: 'scaffold_completed',
                        itemId: item.id,
                        message: `Scaffolded: ${step.summary}`
                    });
                    return true;
                    
                } else {
                    console.log(`BuildOrchestrator: Tool '${toolName}' not found, falling back to direct command`);
                }
            }
            
            // Fallback: run ansible-creator directly
            return await this._runCreatorCommandDirectly(item, step);
            
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this._emit({
                type: 'scaffold_failed',
                itemId: item.id,
                message: `Scaffold failed: ${message}`
            });
            return false;
        }
    }

    /**
     * Convert command path to MCP tool name
     */
    private _getToolNameFromCommand(command: string[]): string {
        // ansible-creator commands map to tool names like:
        // ['init', 'playbook'] -> 'ac_init_play'
        // ['init', 'collection'] -> 'ac_init_coll'
        // ['add', 'resource', 'role'] -> 'ac_add_reso_role'
        
        const shortMap: Record<string, string> = {
            'playbook': 'play',
            'collection': 'coll',
            'execution_env': 'ee',
            'resource': 'reso'
        };
        
        const parts = command.map(p => shortMap[p] || p.substring(0, 4));
        return 'ac_' + parts.join('_');
    }

    /**
     * Run ansible-creator command directly via shell
     */
    private async _runCreatorCommandDirectly(item: PlanItem, step: AgentBuildStep): Promise<boolean> {
        const command = step.creator_command || [];
        const args = step.creator_args || {};
        
        // Build command string
        let cmdStr = `ansible-creator ${command.join(' ')}`;
        
        // Add positional args first (collection name, path)
        if (args['collection']) {
            cmdStr += ` "${args['collection']}"`;
        }
        if (args['init_path']) {
            cmdStr += ` "${args['init_path']}"`;
        }
        
        // Add flag args
        for (const [key, value] of Object.entries(args)) {
            if (key === 'collection' || key === 'init_path') continue;
            if (typeof value === 'boolean' && value) {
                cmdStr += ` --${key}`;
            } else if (typeof value === 'string' && value) {
                cmdStr += ` --${key} "${value}"`;
            }
        }
        
        console.log(`BuildOrchestrator: Running command: ${cmdStr}`);
        
        try {
            const { stdout, stderr } = await execAsync(cmdStr, {
                cwd: this._workspaceRoot,
                timeout: 60000
            });
            
            console.log('BuildOrchestrator: Command output:', stdout || stderr);
            
            this._emit({
                type: 'scaffold_completed',
                itemId: item.id,
                message: `Scaffolded: ${step.summary}`
            });
            return true;
            
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this._emit({
                type: 'scaffold_failed',
                itemId: item.id,
                message: `Command failed: ${message}`
            });
            return false;
        }
    }

    /**
     * Execute a generate action - use LLM to generate file content
     */
    private async _executeGenerate(
        item: PlanItem,
        step: AgentBuildStep,
        cancellationToken?: vscode.CancellationToken
    ): Promise<boolean> {
        this._emit({
            type: 'generate_started',
            itemId: item.id,
            message: `Generating: ${step.file_path || item.name}`
        });

        if (!step.file_path) {
            this._emit({
                type: 'generate_failed',
                itemId: item.id,
                message: 'No file path specified for generation'
            });
            return false;
        }

        // Build the prompt with full context
        const prompt = await this._buildGenerationPrompt(item, step);
        
        // Iterative generation with validation
        let lastContent = '';
        let lastErrors: string[] = [];
        let currentPrompt = prompt;

        for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
            if (cancellationToken?.isCancellationRequested) {
                return false;
            }

            this._emit({
                type: 'generate_iteration',
                itemId: item.id,
                message: `Generation iteration ${iteration}/${MAX_ITERATIONS}`,
                iteration,
                maxIterations: MAX_ITERATIONS
            });

            const response = await this._llmService.request(currentPrompt, {
                maxRetries: 2,
                systemContext: this._getSystemContext()
            });

            if (!response.success) {
                lastErrors = [response.error || 'LLM request failed'];
                continue;
            }

            // Extract code from response
            lastContent = this._extractCode(response.content, step.file_path);

            // Write to file
            const fullPath = this._resolveFilePath(step.file_path);
            await this._writeFile(fullPath, lastContent);

            // Validate
            this._emit({
                type: 'validation_started',
                itemId: item.id,
                message: `Validating iteration ${iteration}...`
            });

            const validation = await this._validateContent(fullPath);

            if (validation.valid) {
                this._emit({
                    type: 'validation_passed',
                    itemId: item.id,
                    message: `Validation passed on iteration ${iteration}`,
                    artifactPath: fullPath
                });

                // Record the artifact
                this._recordArtifact(item, fullPath);
                
                this._emit({
                    type: 'generate_completed',
                    itemId: item.id,
                    message: `Generated: ${step.file_path}`,
                    artifactPath: fullPath
                });
                return true;
            }

            // Validation failed - prepare correction prompt
            lastErrors = validation.errors;

            this._emit({
                type: 'validation_failed',
                itemId: item.id,
                message: `Validation failed on iteration ${iteration}`,
                errors: lastErrors,
                iteration
            });

            currentPrompt = this._buildCorrectionPrompt(step, lastContent, lastErrors);
        }

        this._emit({
            type: 'generate_failed',
            itemId: item.id,
            message: `Generation failed after ${MAX_ITERATIONS} iterations`,
            errors: lastErrors
        });

        return false;
    }

    /**
     * Build generation prompt for a step
     */
    private async _buildGenerationPrompt(item: PlanItem, step: AgentBuildStep): Promise<string> {
        // Get guidance
        const guidance = await this._guidanceService.formatForPrompt();
        
        // Get requirement and decisions
        const reqId = step.addresses?.requirements?.[0] || item.requirement_id;
        const requirement = this._db.get<{ description: string }>(`
            SELECT description FROM requirements WHERE id = ?
        `, reqId);
        
        const decisions = this._db.all<{ category: string; question: string; answer: string }>(`
            SELECT category, question, answer FROM design_decisions 
            WHERE requirement_id = ? AND answer IS NOT NULL
        `, reqId);

        const decisionsText = decisions
            .map(d => `- **${d.category}**: ${d.answer}`)
            .join('\n');

        // Get relevant plugin docs
        const pluginDocs = await this._getRelevantPluginDocs(step.content_description || step.summary || '');

        // Use centralized prompt template
        const { CONTENT_GENERATION_PROMPT, renderTemplate } = await import('../prompts');
        
        return renderTemplate(CONTENT_GENERATION_PROMPT, {
            guidance: guidance || 'Follow Ansible best practices.',
            requirement: requirement?.description || 'No specific requirement.',
            designDecisions: decisionsText || 'None recorded.',
            filePath: step.file_path || '',
            contentDescription: step.content_description || step.summary || '',
            pluginDocs: pluginDocs || 'Use standard Ansible built-in modules.'
        });
    }

    /**
     * Get relevant plugin documentation for a description
     */
    private async _getRelevantPluginDocs(description: string): Promise<string> {
        if (!this._collectionsService) {
            return '';
        }

        const plugins: string[] = [];
        const desc = description.toLowerCase();

        // Guess relevant plugins from description
        if (desc.includes('file') || desc.includes('copy')) {
            plugins.push('ansible.builtin.copy', 'ansible.builtin.file');
        }
        if (desc.includes('package') || desc.includes('install')) {
            plugins.push('ansible.builtin.package');
        }
        if (desc.includes('service') || desc.includes('systemd')) {
            plugins.push('ansible.builtin.service');
        }
        if (desc.includes('template') || desc.includes('config')) {
            plugins.push('ansible.builtin.template');
        }
        if (desc.includes('user')) {
            plugins.push('ansible.builtin.user');
        }

        const docs: string[] = [];
        for (const plugin of plugins.slice(0, 3)) {
            try {
                const doc = await this._collectionsService.getPluginDocumentation(plugin, 'module');
                if (doc?.doc) {
                    docs.push(`### ${plugin}\n${doc.doc.short_description || ''}`);
                }
            } catch {
                // Plugin doc not available
            }
        }

        return docs.join('\n\n');
    }

    /**
     * Build correction prompt after validation failure
     */
    private _buildCorrectionPrompt(step: AgentBuildStep, previousContent: string, errors: string[]): string {
        const errorsText = errors.map((e, i) => `${i + 1}. ${e}`).join('\n');

        // Use centralized prompt template
        const { ERROR_CORRECTION_PROMPT, renderTemplate } = require('../prompts');
        
        return renderTemplate(ERROR_CORRECTION_PROMPT, {
            filePath: step.file_path || '',
            errors: errorsText,
            previousContent: previousContent
        });
    }

    /**
     * Execute an install action - install a collection
     */
    private async _executeInstall(item: PlanItem, step: AgentBuildStep): Promise<boolean> {
        const collection = step.collection || '';
        
        if (!collection) {
            this._emit({
                type: 'install_failed',
                itemId: item.id,
                message: 'No collection specified for installation'
            });
            return false;
        }

        this._emit({
            type: 'install_started',
            itemId: item.id,
            message: `Installing collection: ${collection}`
        });

        try {
            if (this._collectionsService) {
                await this._collectionsService.installCollection(collection);
            } else {
                // Fallback to direct command
                await execAsync(`ansible-galaxy collection install ${collection}`, {
                    cwd: this._workspaceRoot,
                    timeout: 120000
                });
            }

            this._emit({
                type: 'install_completed',
                itemId: item.id,
                message: `Installed: ${collection}`
            });
            return true;

        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this._emit({
                type: 'install_failed',
                itemId: item.id,
                message: `Install failed: ${message}`
            });
            return false;
        }
    }

    /**
     * Execute a configure action - modify a configuration file
     */
    private async _executeConfigure(
        item: PlanItem,
        step: AgentBuildStep,
        cancellationToken?: vscode.CancellationToken
    ): Promise<boolean> {
        // Configure actions are treated like generate actions
        return this._executeGenerate(item, step, cancellationToken);
    }

    /**
     * Get system context for LLM
     */
    private _getSystemContext(): string {
        return `You are an expert Ansible automation engineer.
Your code must be production-ready, idempotent, and well-documented.
Always use FQCN for modules.
Never use placeholder content or TODO comments.`;
    }

    /**
     * Resolve file path relative to project
     */
    private _resolveFilePath(filePath: string): string {
        if (path.isAbsolute(filePath)) {
            return filePath;
        }

        const project = this._db.get<{ name: string }>(`SELECT name FROM project WHERE id = 1`);
        const basePath = project 
            ? path.join(this._workspaceRoot, project.name)
            : this._workspaceRoot;

        return path.join(basePath, filePath);
    }

    /**
     * Write file content
     */
    private async _writeFile(filePath: string, content: string): Promise<void> {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(filePath, content);
    }

    /**
     * Validate generated content
     */
    private async _validateContent(filePath: string): Promise<{ valid: boolean; errors: string[] }> {
        const errors: string[] = [];

        if (!fs.existsSync(filePath)) {
            return { valid: false, errors: ['File was not created'] };
        }

        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            
            if (content.trim().length === 0) {
                errors.push('Generated content is empty');
                return { valid: false, errors };
            }

            if (content.includes('TODO') || content.includes('FIXME')) {
                errors.push('Content contains TODO/FIXME placeholders');
            }

            // Run ansible-lint if it's a YAML file
            if (filePath.endsWith('.yml') || filePath.endsWith('.yaml')) {
                const lintErrors = await this._runAnsibleLint(filePath);
                errors.push(...lintErrors);
            }

        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            errors.push(`File read error: ${message}`);
        }

        return { valid: errors.length === 0, errors };
    }

    /**
     * Run ansible-lint on a file
     */
    private async _runAnsibleLint(filePath: string): Promise<string[]> {
        const errors: string[] = [];

        try {
            await execAsync(`ansible-lint --nocolor "${filePath}" 2>&1`, {
                cwd: this._workspaceRoot,
                timeout: 30000
            });
        } catch (error) {
            if ('stdout' in (error as Record<string, unknown>)) {
                const output = String((error as { stdout: unknown }).stdout);
                const lines = output.split('\n').filter(l => l.trim());
                for (const line of lines) {
                    if (line.match(/: error|: warning|^[A-Z]+\d+:/)) {
                        errors.push(line.trim());
                    }
                }
            }
        }

        return errors.slice(0, 5); // Limit to 5 errors
    }

    /**
     * Extract code from LLM response
     */
    private _extractCode(response: string, filePath: string): string {
        // Remove markdown code fences
        let content = response.replace(/```(?:yaml|yml|python|jinja2|json)?\n?/gi, '');
        content = content.replace(/```/g, '').trim();
        
        // For YAML files, ensure proper structure
        if (filePath.endsWith('.yml') || filePath.endsWith('.yaml')) {
            if (!content.startsWith('---') && !content.startsWith('-') && !content.startsWith('#')) {
                content = '---\n' + content;
            }
        }

        return content;
    }

    /**
     * Record artifact in database
     */
    private _recordArtifact(item: PlanItem, filePath: string): void {
        const relativePath = path.relative(this._workspaceRoot, filePath);
        const hash = this._hashContent(fs.readFileSync(filePath, 'utf-8'));

        this._db.run(`
            INSERT INTO artifacts (plan_item_id, path, content_hash)
            VALUES (?, ?, ?)
            ON CONFLICT(path) DO UPDATE SET 
                content_hash = ?,
                stale = FALSE,
                generated_at = CURRENT_TIMESTAMP
        `, item.id, relativePath, hash, hash);
    }

    /**
     * Simple hash for content comparison
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
     * Finalize the build
     */
    private async _finalize(): Promise<void> {
        // Generate requirements.yml if collections were installed
        const collections = this._db.all<{ name: string }>(`
            SELECT name FROM plan_items 
            WHERE type = 'install' AND status = 'complete'
        `);

        if (collections.length > 0) {
            const project = this._db.get<{ name: string }>(`SELECT name FROM project WHERE id = 1`);
            const reqPath = path.join(
                this._workspaceRoot,
                project?.name || '',
                'requirements.yml'
            );
            
            // Parse collection names from the step descriptions
            const collectionNames: string[] = [];
            for (const c of collections) {
                try {
                    const step = JSON.parse(c.name.replace('Install ', ''));
                    if (step.collection) {
                        collectionNames.push(step.collection);
                    }
                } catch {
                    // Try extracting from the name directly
                    const match = c.name.match(/Install (.+)/);
                    if (match) {
                        collectionNames.push(match[1]);
                    }
                }
            }

            if (collectionNames.length > 0) {
                const reqContent = `---\ncollections:\n${collectionNames.map(c => `  - name: ${c}`).join('\n')}\n`;
                fs.writeFileSync(reqPath, reqContent);
            }
        }

        // Log completion
        const items = this._planningAgent.getPlanItems();
        this._db.logHistory('build_completed', 'build', undefined, undefined, {
            completed: items.filter(i => i.status === 'complete').length,
            failed: items.filter(i => i.status === 'failed').length
        });
    }

    /**
     * Emit progress event
     */
    private _emit(event: BuildEvent): void {
        console.log(`BuildOrchestrator: [${event.type}] ${event.message}`);
        if (this._onProgress) {
            this._onProgress(event);
        }
    }

    /**
     * Build a single plan item
     */
    public async buildItem(itemId: string, cancellationToken?: vscode.CancellationToken): Promise<void> {
        const item = this._db.get<PlanItem>(`SELECT * FROM plan_items WHERE id = ?`, itemId);

        if (!item) {
            throw new Error(`Plan item not found: ${itemId}`);
        }

        await this._executeStep(item, cancellationToken);
    }

    /**
     * Get build progress summary
     */
    public getBuildProgress(): {
        total: number;
        completed: number;
        failed: number;
        inProgress: number;
        pending: number;
    } {
        const items = this._planningAgent.getPlanItems();
        return {
            total: items.length,
            completed: items.filter(i => i.status === 'complete').length,
            failed: items.filter(i => i.status === 'failed').length,
            inProgress: items.filter(i => i.status === 'in_progress').length,
            pending: items.filter(i => i.status === 'approved' || i.status === 'proposed').length
        };
    }

    /**
     * Get all artifacts
     */
    public getArtifacts(): Artifact[] {
        return this._db.all<Artifact>(`SELECT * FROM artifacts ORDER BY generated_at DESC`);
    }

    /**
     * Reset all items for rebuild
     */
    public resetAllItems(): void {
        this._db.run(`
            UPDATE plan_items SET status = 'approved' 
            WHERE status IN ('complete', 'failed', 'in_progress')
        `);
        this._db.run(`DELETE FROM artifacts`);
    }

    /**
     * Reset a single item for rebuild
     */
    public resetItem(itemId: string): void {
        this._db.run(`UPDATE plan_items SET status = 'approved' WHERE id = ?`, itemId);
        this._db.run(`DELETE FROM artifacts WHERE plan_item_id = ?`, itemId);
    }
}
