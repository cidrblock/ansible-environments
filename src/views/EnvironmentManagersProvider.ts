import * as vscode from 'vscode';
import { PythonEnvironment, PythonEnvironmentApi } from '../types/pythonEnvApi';

type TreeNode = ManagerNode | EnvironmentNode;

interface ManagerNode {
    type: 'manager';
    id: string;
    name: string;
    environments: PythonEnvironment[];
}

interface EnvironmentNode {
    type: 'environment';
    environment: PythonEnvironment;
    managerId: string;
}

export class EnvironmentManagersProvider implements vscode.TreeDataProvider<TreeNode> {
    private _onDidChangeTreeData: vscode.EventEmitter<TreeNode | undefined | null | void> = new vscode.EventEmitter<TreeNode | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<TreeNode | undefined | null | void> = this._onDidChangeTreeData.event;

    private _pythonEnvApi: PythonEnvironmentApi | undefined;
    private _managers: Map<string, PythonEnvironment[]> = new Map();
    private _envListener: vscode.Disposable | undefined;
    private _currentEnvId: string | undefined;

    constructor() {
        this._initPythonEnvApi();
    }

    private async _initPythonEnvApi() {
        try {
            const pythonEnvExtension = vscode.extensions.getExtension<PythonEnvironmentApi>('ms-python.vscode-python-envs');
            if (pythonEnvExtension) {
                if (!pythonEnvExtension.isActive) {
                    await pythonEnvExtension.activate();
                }
                this._pythonEnvApi = pythonEnvExtension.exports;
                
                // Listen for environment changes
                if (this._pythonEnvApi.onDidChangeEnvironment) {
                    this._envListener = this._pythonEnvApi.onDidChangeEnvironment(() => {
                        this.refresh();
                    });
                }
                
                // Initial load
                await this.refresh();
            }
        } catch (error) {
            console.error('Failed to get Python Environments API:', error);
        }
    }

    async refresh(): Promise<void> {
        try {
            await this._loadEnvironments();
        } finally {
            this._onDidChangeTreeData.fire();
        }
    }

    private async _loadEnvironments(): Promise<void> {
        this._managers.clear();
        
        if (!this._pythonEnvApi) {
            return;
        }

        try {
            // Get current environment to mark it
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
            const currentEnv = await this._pythonEnvApi.getEnvironment(workspaceFolder);
            this._currentEnvId = currentEnv?.envId.id;

            // Get all environments
            const environments = await this._pythonEnvApi.getEnvironments('all');
            
            // Group by manager
            for (const env of environments) {
                const managerId = env.envId.managerId;
                if (!this._managers.has(managerId)) {
                    this._managers.set(managerId, []);
                }
                this._managers.get(managerId)!.push(env);
            }
        } catch (error) {
            console.error('Failed to load environments:', error);
        }
    }

    private _getManagerDisplayName(managerId: string): string {
        // Extract a friendly name from the manager ID
        // e.g., "ms-python.vscode-python-envs:venv" -> "venv"
        const parts = managerId.split(':');
        const name = parts[parts.length - 1] || managerId;
        
        // Rename "system" to "Global" to match Python Environments extension
        if (name.toLowerCase() === 'system') {
            return 'Global';
        }
        
        // Keep venv lowercase, capitalize others
        if (name.toLowerCase() === 'venv') {
            return 'venv';
        }
        
        // Capitalize first letter for others
        return name.charAt(0).toUpperCase() + name.slice(1);
    }

    private _isVenvManager(managerId: string): boolean {
        const name = managerId.split(':').pop()?.toLowerCase() || '';
        return name === 'venv';
    }

    getTreeItem(element: TreeNode): vscode.TreeItem {
        if (element.type === 'manager') {
            // venv should be expanded, others (like Global) should be collapsed
            const isVenv = this._isVenvManager(element.id);
            const item = new vscode.TreeItem(
                element.name,
                isVenv ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
            );
            item.iconPath = new vscode.ThemeIcon(element.name === 'Global' ? 'globe' : 'folder');
            item.contextValue = 'envManager';
            return item;
        } else {
            const env = element.environment;
            const isCurrent = env.envId.id === this._currentEnvId;
            
            const item = new vscode.TreeItem(
                env.displayName || env.name,
                vscode.TreeItemCollapsibleState.None
            );
            // Use checkmark icon for current environment
            item.iconPath = isCurrent 
                ? new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'))
                : new vscode.ThemeIcon('symbol-misc');
            item.contextValue = isCurrent ? 'pythonEnvironmentCurrent' : 'pythonEnvironment';
            item.tooltip = new vscode.MarkdownString(
                `**${env.displayName}**\n\n` +
                `Version: ${env.version}\n\n` +
                `Path: ${env.sysPrefix || env.displayPath}`
            );
            
            // Command to select this environment
            item.command = {
                command: 'ansibleDevTools.selectEnvironment',
                title: 'Select Environment',
                arguments: [env]
            };
            
            return item;
        }
    }

    getChildren(element?: TreeNode): Thenable<TreeNode[]> {
        if (!element) {
            // Root level - return managers
            const managers: ManagerNode[] = [];
            for (const [managerId, environments] of this._managers) {
                managers.push({
                    type: 'manager',
                    id: managerId,
                    name: this._getManagerDisplayName(managerId),
                    environments
                });
            }
            // Sort by name
            managers.sort((a, b) => a.name.localeCompare(b.name));
            return Promise.resolve(managers);
        } else if (element.type === 'manager') {
            // Return environments for this manager
            const envNodes: EnvironmentNode[] = element.environments.map(env => ({
                type: 'environment',
                environment: env,
                managerId: element.id
            }));
            // Sort by display name
            envNodes.sort((a, b) => 
                (a.environment.displayName || a.environment.name)
                    .localeCompare(b.environment.displayName || b.environment.name)
            );
            return Promise.resolve(envNodes);
        }
        
        return Promise.resolve([]);
    }

    dispose() {
        this._envListener?.dispose();
        this._onDidChangeTreeData.dispose();
    }
}
