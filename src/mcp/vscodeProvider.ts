/**
 * VS Code MCP Provider
 * 
 * Registers the Ansible Environments MCP server with VS Code's
 * language model API (for Copilot integration).
 * 
 * Based on: https://github.com/microsoft/vscode-extension-samples/tree/main/mcp-extension-sample
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
    // Check if the MCP API exists (requires VS Code 1.101+)
    if (!vscode.lm || typeof (vscode.lm as any).registerMcpServerDefinitionProvider !== 'function') {
        console.log('Ansible Environments: VS Code MCP API not available');
        return;
    }

    if (!(vscode as any).McpStdioServerDefinition) {
        console.log('Ansible Environments: McpStdioServerDefinition not available');
        return;
    }

    const didChangeEmitter = new vscode.EventEmitter<void>();

    // Get the path to the compiled MCP server
    const serverPath = context.asAbsolutePath(path.join('out', 'mcp', 'server.js'));

    // Register the provider following the official sample pattern
    // https://github.com/microsoft/vscode-extension-samples/blob/main/mcp-extension-sample/src/extension.ts
    context.subscriptions.push(
        (vscode.lm as any).registerMcpServerDefinitionProvider('ansibleEnvironments', {
            onDidChangeMcpServerDefinitions: didChangeEmitter.event,
            provideMcpServerDefinitions: async (): Promise<any[]> => {
                // Get the workspace folder - MCP server needs this to find the environment cache
                const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                
                if (!workspaceFolder) {
                    console.log('Ansible Environments: No workspace folder, MCP server not available');
                    return [];
                }

                // McpStdioServerDefinition(label, command, args, env)
                // Constructor takes positional arguments, NOT an options object
                // The 4th arg (env) should include cwd via shell execution
                return [
                    new (vscode as any).McpStdioServerDefinition(
                        'Ansible Environments',  // label
                        'node',                   // command
                        [serverPath],             // args
                        { ANSIBLE_ENV_WORKSPACE: workspaceFolder }  // env - pass workspace path
                    )
                ];
            }
        })
    );

    context.subscriptions.push(didChangeEmitter);
    console.log('Ansible Environments: MCP server provider registered');
}

/**
 * Check if VS Code MCP is available
 */
export function isMcpAvailable(): boolean {
    return !!vscode.lm && typeof (vscode.lm as any).registerMcpServerDefinitionProvider === 'function';
}
