/**
 * AgentToolService - MCP Tool Access for AI Agents
 * 
 * Provides access to MCP tools for AI agents without using vscode.lm.registerTool()
 * (which has strict requirements and often fails).
 * 
 * Instead:
 * - Builds a list of tools in VS Code format for passing to sendRequest()
 * - Executes tools directly via McpToolHandler when the LLM requests them
 * - Sets workspace context before tool execution
 */

import * as vscode from 'vscode';
import { McpToolHandler } from '../../mcp/handlers';
import { STATIC_TOOLS, McpToolDefinition } from '../../mcp/tools';

// Singleton instance
let instance: AgentToolService | undefined;
let workspaceRoot: string | undefined;

/**
 * Tool definition in VS Code's format
 */
export interface VsCodeToolDefinition extends vscode.LanguageModelChatTool {
    name: string;
    description: string;
    inputSchema: object;
}

/**
 * AgentToolService - Provides MCP tools to AI agents
 */
export class AgentToolService {
    private _mcpHandler: McpToolHandler;
    private _initialized = false;
    private _tools: Map<string, VsCodeToolDefinition> = new Map();

    private constructor() {
        this._mcpHandler = new McpToolHandler();
    }

    /**
     * Get singleton instance
     */
    public static getInstance(): AgentToolService {
        if (!instance) {
            instance = new AgentToolService();
        }
        return instance;
    }

    /**
     * Initialize the service
     */
    public async initialize(): Promise<void> {
        if (this._initialized) {
            return;
        }

        // Initialize MCP handler
        await this._mcpHandler.initialize();

        // Build tool list (don't register with VS Code - causes errors)
        this._buildToolList();

        this._initialized = true;
        console.log(`AgentToolService: Initialized with ${this._tools.size} tools`);
    }

    /**
     * Build the list of available tools
     */
    private _buildToolList(): void {
        // Get static tools
        const staticTools = STATIC_TOOLS;
        
        // Get dynamic ansible-creator tools
        const creatorTools = this._mcpHandler.getCreatorTools();
        const dynamicTools = creatorTools.getTools();
        
        const allTools = [...staticTools, ...dynamicTools];

        for (const mcpTool of allTools) {
            // Tool names can only contain alphanumeric, hyphens, underscores (no dots!)
            const toolName = `ansible_${mcpTool.name}`;
            
            const vscTool: VsCodeToolDefinition = {
                name: toolName,
                description: mcpTool.description,
                inputSchema: mcpTool.inputSchema
            };

            this._tools.set(toolName, vscTool);
        }
    }

    /**
     * Get all tools for use with sendRequest()
     */
    public getTools(): vscode.LanguageModelChatTool[] {
        return Array.from(this._tools.values());
    }

    /**
     * Get tools matching a pattern
     */
    public getToolsByPattern(patterns: string[]): vscode.LanguageModelChatTool[] {
        return Array.from(this._tools.values()).filter(tool => {
            const baseName = tool.name.replace('ansible_', '');
            return patterns.some(p => baseName.includes(p) || p.includes(baseName));
        });
    }

    /**
     * Get specific tools by name
     */
    public getToolsByName(names: string[]): vscode.LanguageModelChatTool[] {
        return names
            .map(name => {
                const fullName = name.startsWith('ansible_') ? name : `ansible_${name}`;
                return this._tools.get(fullName);
            })
            .filter((t): t is VsCodeToolDefinition => t !== undefined);
    }

    /**
     * Set the workspace root for tool execution
     * Must be called before tools that need workspace context
     */
    public setWorkspaceRoot(root: string): void {
        workspaceRoot = root;
        // Also set env var for MCP handlers that check it
        process.env.ANSIBLE_ENV_WORKSPACE = root;
    }

    /**
     * Execute a tool directly (called when LLM requests a tool)
     * 
     * This bypasses vscode.lm.invokeTool() which requires a chat participant context.
     */
    public async callTool(name: string, args: Record<string, unknown>): Promise<string> {
        await this.initialize();
        
        // Ensure workspace context is set
        if (!workspaceRoot) {
            const wsFolder = vscode.workspace.workspaceFolders?.[0];
            if (wsFolder) {
                this.setWorkspaceRoot(wsFolder.uri.fsPath);
            }
        }
        
        // Strip ansible_ prefix if present to get the MCP tool name
        const mcpName = name.replace('ansible_', '');
        
        console.log(`AgentToolService: Executing tool ${mcpName} with args:`, JSON.stringify(args));
        
        try {
            const result = await this._mcpHandler.handleTool(mcpName, args);
            
            const textContent = result.content
                .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
                .map(c => c.text)
                .join('\n');

            if (result.isError) {
                console.error(`AgentToolService: Tool ${mcpName} returned error:`, textContent);
                throw new Error(textContent);
            }

            console.log(`AgentToolService: Tool ${mcpName} completed, result length: ${textContent.length}`);
            return textContent || 'Tool executed successfully';
        } catch (error) {
            console.error(`AgentToolService: Tool ${mcpName} failed:`, error);
            throw new Error(`Tool ${name} failed: ${error instanceof Error ? error.message : error}`);
        }
    }

    /**
     * Check if a tool is available
     */
    public hasTool(name: string): boolean {
        const fullName = name.startsWith('ansible_') ? name : `ansible_${name}`;
        return this._tools.has(fullName);
    }

    /**
     * Get a summary of available tools
     */
    public getToolSummary(): string {
        const tools = Array.from(this._tools.keys());
        return `Available tools (${tools.length}): ${tools.join(', ')}`;
    }

    /**
     * Dispose (no-op since we're not registering with VS Code anymore)
     */
    public dispose(): void {
        this._tools.clear();
        this._initialized = false;
    }
}

/**
 * Get singleton instance
 */
export function getAgentToolService(): AgentToolService {
    return AgentToolService.getInstance();
}

/**
 * Initialize the service (call during extension activation)
 */
export async function initializeAgentTools(): Promise<void> {
    const service = getAgentToolService();
    await service.initialize();
}
