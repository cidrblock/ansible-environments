/**
 * MCP Tools Tree View Provider
 * 
 * Displays available MCP tools and allows users to inject prompts
 * into Cursor/Copilot chat to invoke them.
 */

import * as vscode from 'vscode';
import { STATIC_TOOLS, McpToolDefinition } from '../mcp/tools';
import { CreatorToolGenerator } from '../mcp/creatorTools';
import { log } from '../extension';

type ToolCategory = 'discovery' | 'generation' | 'execution' | 'devtools' | 'creator';

interface ToolInfo {
    tool: McpToolDefinition;
    category: ToolCategory;
    examplePrompt: string;
}

class ToolCategoryNode extends vscode.TreeItem {
    constructor(
        public readonly categoryLabel: string,
        public readonly categoryId: ToolCategory,
        public readonly toolCount: number
    ) {
        super(categoryLabel, vscode.TreeItemCollapsibleState.Expanded);
        this.contextValue = 'toolCategory';
        this.description = `${toolCount} tools`;
        
        // Set icons based on category
        const iconMap: Record<ToolCategory, string> = {
            discovery: 'search',
            generation: 'code',
            execution: 'package',
            devtools: 'tools',
            creator: 'wand'
        };
        this.iconPath = new vscode.ThemeIcon(iconMap[categoryId] || 'symbol-method');
    }
}

class ToolNode extends vscode.TreeItem {
    constructor(
        public readonly toolInfo: ToolInfo
    ) {
        super(toolInfo.tool.name, vscode.TreeItemCollapsibleState.None);
        
        // Show first line of description
        const firstLine = toolInfo.tool.description.split('\n')[0];
        this.description = firstLine.length > 50 ? firstLine.substring(0, 47) + '...' : firstLine;
        this.tooltip = new vscode.MarkdownString(this._formatTooltip());
        this.contextValue = 'mcpTool';
        this.iconPath = new vscode.ThemeIcon('symbol-method');
        
        // Command to inject prompt into chat
        this.command = {
            command: 'ansibleMcpTools.useInChat',
            title: 'Use in Chat',
            arguments: [toolInfo]
        };
    }

    private _formatTooltip(): string {
        const tool = this.toolInfo.tool;
        const lines: string[] = [
            `### ${tool.name}`,
            '',
            tool.description,
            ''
        ];

        // Show parameters
        const props = tool.inputSchema.properties;
        const required = new Set(tool.inputSchema.required || []);
        
        if (Object.keys(props).length > 0) {
            lines.push('**Parameters:**');
            for (const [name, schema] of Object.entries(props)) {
                const s = schema as { description?: string; type?: string };
                const reqMark = required.has(name) ? ' *(required)*' : '';
                lines.push(`- \`${name}\`${reqMark}: ${s.description || s.type || 'any'}`);
            }
            lines.push('');
        }

        lines.push('**Example prompt:**');
        lines.push(`\`${this.toolInfo.examplePrompt}\``);

        return lines.join('\n');
    }
}

type ToolTreeItem = ToolCategoryNode | ToolNode;

export class McpToolsProvider implements vscode.TreeDataProvider<ToolTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<ToolTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private _tools: ToolInfo[] = [];
    private _creatorToolGenerator: CreatorToolGenerator;
    private _isLoading = false;

    constructor() {
        this._creatorToolGenerator = new CreatorToolGenerator();
        this._loadTools();
    }

    refresh(): void {
        this._loadTools();
    }

    private async _loadTools(): Promise<void> {
        if (this._isLoading) {
            return;
        }

        this._isLoading = true;
        this._tools = [];

        try {
            // Load static tools with categories
            for (const tool of STATIC_TOOLS) {
                const category = this._categorizeStaticTool(tool.name);
                const examplePrompt = this._generateExamplePrompt(tool);
                this._tools.push({ tool, category, examplePrompt });
            }

            // Load dynamic creator tools
            try {
                await this._creatorToolGenerator.refresh();
                const creatorTools = this._creatorToolGenerator.getTools();
                
                for (const tool of creatorTools) {
                    const examplePrompt = this._generateExamplePrompt(tool);
                    this._tools.push({ tool, category: 'creator', examplePrompt });
                }
                
                log(`McpToolsProvider: Loaded ${STATIC_TOOLS.length} static + ${creatorTools.length} creator tools`);
            } catch (error) {
                log(`McpToolsProvider: Failed to load creator tools: ${error}`);
                // Continue with static tools only
            }

        } finally {
            this._isLoading = false;
            this._onDidChangeTreeData.fire();
        }
    }

    private _categorizeStaticTool(name: string): ToolCategory {
        if (name.includes('search') || name.includes('list') || name.includes('get_plugin_documentation')) {
            return 'discovery';
        }
        if (name.includes('generate') || name.includes('build_ansible_task')) {
            return 'generation';
        }
        if (name.includes('execution_environment') || name.includes('ee_')) {
            return 'execution';
        }
        if (name.includes('dev_tools')) {
            return 'devtools';
        }
        return 'discovery'; // default
    }

    private _generateExamplePrompt(tool: McpToolDefinition): string {
        const name = tool.name;
        const required = tool.inputSchema.required || [];
        const props = tool.inputSchema.properties;

        // Build example based on tool type
        switch (name) {
            case 'search_ansible_plugins':
                return 'Search for Ansible plugins to copy files';
            case 'get_plugin_documentation':
                return 'Show me the documentation for ansible.builtin.copy';
            case 'list_ansible_collections':
                return 'What Ansible collections are installed?';
            case 'generate_ansible_task':
                return 'Generate an Ansible task to copy /etc/hosts to /tmp/hosts.backup';
            case 'build_ansible_task':
                return 'Help me build an Ansible task for the apt module step by step';
            case 'generate_ansible_playbook':
                return 'Create a playbook to install and configure nginx on webservers';
            case 'list_execution_environments':
                return 'What execution environments are available?';
            case 'get_ee_details':
                return 'Show me the details of the creator-ee execution environment';
            case 'list_ansible_dev_tools':
                return 'What ansible-dev-tools packages are installed?';
            default:
                // For creator tools and others
                if (name.startsWith('creator_')) {
                    const parts = name.replace('creator_', '').split('_');
                    return `Use ansible-creator to ${parts.join(' ')}`;
                }
                // Generic: mention required params
                if (required.length > 0) {
                    const paramHints = required.map(p => {
                        const desc = (props[p] as { description?: string })?.description || p;
                        return desc.split(' ').slice(0, 3).join(' ');
                    }).join(', ');
                    return `Use ${name} with ${paramHints}`;
                }
                return `Use the ${name} tool`;
        }
    }

    getTreeItem(element: ToolTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: ToolTreeItem): Promise<ToolTreeItem[]> {
        if (!element) {
            // Root level - return categories
            const categories: { id: ToolCategory; label: string }[] = [
                { id: 'discovery', label: 'Discovery' },
                { id: 'generation', label: 'Task Generation' },
                { id: 'execution', label: 'Execution Environments' },
                { id: 'devtools', label: 'Dev Tools' },
                { id: 'creator', label: 'Creator' }
            ];

            return categories
                .map(cat => {
                    const count = this._tools.filter(t => t.category === cat.id).length;
                    return new ToolCategoryNode(cat.label, cat.id, count);
                })
                .filter(node => node.toolCount > 0); // Only show non-empty categories
        }

        if (element instanceof ToolCategoryNode) {
            // Return tools in this category
            return this._tools
                .filter(t => t.category === element.categoryId)
                .map(t => new ToolNode(t));
        }

        return [];
    }

    /**
     * Get the CreatorToolGenerator instance for MCP handlers
     */
    getCreatorToolGenerator(): CreatorToolGenerator {
        return this._creatorToolGenerator;
    }

    /**
     * Get all loaded tools
     */
    getAllTools(): ToolInfo[] {
        return [...this._tools];
    }
}

/**
 * Inject a tool prompt into the chat
 */
export async function injectToolPromptIntoChat(toolInfo: ToolInfo): Promise<void> {
    const prompt = toolInfo.examplePrompt;

    // Try different methods to inject into chat
    const methods = [
        // VS Code Copilot chat commands
        'workbench.panel.chat.view.copilot.focus',
        'workbench.action.chat.open',
        'github.copilot.chat.focus',
        // Cursor chat commands (may vary)
        'aichat.newchataction',
    ];

    let chatOpened = false;

    for (const cmd of methods) {
        try {
            await vscode.commands.executeCommand(cmd);
            chatOpened = true;
            log(`McpToolsProvider: Opened chat with command: ${cmd}`);
            break;
        } catch {
            // Command not available, try next
        }
    }

    if (!chatOpened) {
        // Fallback: copy to clipboard and notify user
        await vscode.env.clipboard.writeText(prompt);
        vscode.window.showInformationMessage(
            `Prompt copied to clipboard: "${prompt}"`,
            'Paste in Chat'
        );
        return;
    }

    // Small delay to let the chat panel focus
    await new Promise(resolve => setTimeout(resolve, 100));

    // Try to insert text into the chat input
    try {
        // Method 1: Use the type command to insert text
        await vscode.commands.executeCommand('type', { text: prompt });
        log(`McpToolsProvider: Inserted prompt via type command`);
    } catch {
        // Method 2: Copy to clipboard as fallback
        await vscode.env.clipboard.writeText(prompt);
        try {
            await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
            log(`McpToolsProvider: Inserted prompt via paste`);
        } catch {
            vscode.window.showInformationMessage(
                `Prompt copied to clipboard: "${prompt}"`,
                'Paste in Chat'
            );
        }
    }
}
