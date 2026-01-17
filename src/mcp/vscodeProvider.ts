/**
 * VS Code MCP Provider
 * 
 * Registers the Ansible Environments MCP server with VS Code's
 * language model API (for Copilot integration).
 * 
 * This requires VS Code 1.99+ with MCP support.
 */

import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Register the MCP server with VS Code.
 * 
 * This makes the Ansible Environments tools available to VS Code Copilot
 * and other AI features that support MCP.
 * 
 * @param context Extension context for subscriptions and paths
 */
export function registerMcpServerProvider(context: vscode.ExtensionContext): void {
    // Check if VS Code supports MCP (requires 1.99+)
    // The lm namespace and registerMcpServerDefinitionProvider may not exist
    // in older versions, so we need to check dynamically
    const lm = (vscode as any).lm;
    
    if (!lm || typeof lm.registerMcpServerDefinitionProvider !== 'function') {
        console.log('Ansible Environments: VS Code MCP API not available (requires VS Code 1.99+)');
        return;
    }

    try {
        const didChangeEmitter = new vscode.EventEmitter<void>();

        // Get the path to the compiled MCP server
        const serverPath = context.asAbsolutePath(path.join('out', 'mcp', 'server.js'));

        const provider = {
            onDidChangeMcpServerDefinitions: didChangeEmitter.event,

            provideMcpServerDefinitions: async (): Promise<any[]> => {
                // Get workspace folder for cwd
                const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;

                // Create stdio server definition
                // Using dynamic construction since the class may not exist in type definitions
                const McpStdioServerDefinition = (vscode as any).McpStdioServerDefinition;
                
                if (!McpStdioServerDefinition) {
                    console.log('Ansible Environments: McpStdioServerDefinition not available');
                    return [];
                }

                return [
                    new McpStdioServerDefinition({
                        label: 'Ansible Environments',
                        command: 'node',
                        args: [serverPath],
                        cwd: workspaceFolder,
                        env: {},
                        version: '1.0.0'
                    })
                ];
            },

            resolveMcpServerDefinition: async (server: any): Promise<any> => {
                // No additional resolution needed
                // Could be used for authentication prompts in the future
                return server;
            }
        };

        const disposable = lm.registerMcpServerDefinitionProvider('ansibleEnvironments', provider);
        context.subscriptions.push(disposable);
        context.subscriptions.push(didChangeEmitter);

        console.log('Ansible Environments: MCP server provider registered for VS Code');
    } catch (error) {
        console.error('Ansible Environments: Failed to register MCP server provider:', error);
    }
}

/**
 * Check if VS Code MCP is available
 */
export function isMcpAvailable(): boolean {
    const lm = (vscode as any).lm;
    return lm && typeof lm.registerMcpServerDefinitionProvider === 'function';
}
