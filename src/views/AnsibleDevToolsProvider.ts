import * as vscode from 'vscode';
import { PythonEnvironment, PythonEnvironmentApi } from '../types/pythonEnvApi';

interface DevToolPackage {
    name: string;
    version: string;
}

export class AnsibleDevToolsProvider implements vscode.TreeDataProvider<DevToolPackage> {
    private _onDidChangeTreeData: vscode.EventEmitter<DevToolPackage | undefined | null | void> = new vscode.EventEmitter<DevToolPackage | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<DevToolPackage | undefined | null | void> = this._onDidChangeTreeData.event;

    private _pythonEnvApi: PythonEnvironmentApi | undefined;
    private _packages: DevToolPackage[] = [];
    private _loading: boolean = false;
    private _envListener: vscode.Disposable | undefined;

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
        this._loading = true;
        this._onDidChangeTreeData.fire();
        
        try {
            await this._loadPackages();
        } finally {
            this._loading = false;
            this._onDidChangeTreeData.fire();
        }
    }

    private async _loadPackages(): Promise<void> {
        if (!this._pythonEnvApi) {
            this._packages = [];
            return;
        }

        try {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
            const environment = await this._pythonEnvApi.getEnvironment(workspaceFolder);
            
            if (!environment) {
                this._packages = [];
                return;
            }

            // Run adt --version and parse the output
            const executable = environment.execInfo?.run?.executable;
            if (!executable) {
                this._packages = [];
                return;
            }

            const cp = await import('child_process');
            const path = await import('path');
            const envBinDir = path.dirname(executable);
            const adtPath = path.join(envBinDir, 'adt');

            const result = await new Promise<string>((resolve, reject) => {
                cp.exec(`"${adtPath}" --version`, (error, stdout, stderr) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    resolve(stdout);
                });
            });

            // Parse the adt --version output
            const packages: DevToolPackage[] = [];
            const lines = result.trim().split('\n');
            for (const line of lines) {
                const match = line.match(/^(\S+)\s+(\S+)$/);
                if (match) {
                    packages.push({ name: match[1], version: match[2] });
                }
            }

            this._packages = packages;
        } catch (error) {
            console.error('Failed to load packages:', error);
            this._packages = [];
        }
    }

    getTreeItem(element: DevToolPackage): vscode.TreeItem {
        const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None);
        item.description = element.version;
        item.iconPath = new vscode.ThemeIcon('package');
        item.contextValue = 'devToolPackage';
        return item;
    }

    getChildren(element?: DevToolPackage): Thenable<DevToolPackage[]> {
        if (element) {
            return Promise.resolve([]);
        }
        return Promise.resolve(this._packages);
    }

    hasPackages(): boolean {
        return this._packages.length > 0;
    }

    dispose() {
        this._envListener?.dispose();
        this._onDidChangeTreeData.dispose();
    }
}
