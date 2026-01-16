import * as vscode from 'vscode';
import * as cp from 'child_process';
import { log } from '../extension';
import { PythonEnvironment, PythonEnvironmentApi } from '../types/pythonEnvApi';

interface ExecutionEnvironment {
    created: string;
    execution_environment: boolean;
    full_name: string;
    image_id: string;
}

interface EEDetails {
    ansible_collections?: {
        details: Record<string, string>;
    };
    ansible_version?: {
        details: string;
    };
    python_packages?: {
        details: Array<{
            name: string;
            version: string;
            summary?: string;
        }>;
    };
    os_release?: {
        details: Array<{
            'pretty-name'?: string;
            name?: string;
            version?: string;
        }>;
    };
    image_name?: string;
}

type TreeNode = EENode | EEDetailCategoryNode | EEDetailItemNode;

class EENode extends vscode.TreeItem {
    constructor(
        public readonly ee: ExecutionEnvironment
    ) {
        super(ee.full_name, vscode.TreeItemCollapsibleState.Collapsed);
        this.description = ee.created;
        this.tooltip = new vscode.MarkdownString();
        this.tooltip.appendMarkdown(`**${ee.full_name}**\n\n`);
        this.tooltip.appendMarkdown(`- Image ID: \`${ee.image_id}\`\n`);
        this.tooltip.appendMarkdown(`- Created: ${ee.created}\n`);
        this.iconPath = new vscode.ThemeIcon('package');
        this.contextValue = 'executionEnvironment';
    }
}

class EEDetailCategoryNode extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly items: EEDetailItemNode[],
        public readonly eeName: string
    ) {
        super(label, vscode.TreeItemCollapsibleState.Collapsed);
        this.description = `(${items.length})`;
        this.contextValue = 'eeDetailCategory';
        
        // Set appropriate icon based on category
        switch (label) {
            case 'Ansible Collections':
                this.iconPath = new vscode.ThemeIcon('library');
                break;
            case 'Python Packages':
                this.iconPath = new vscode.ThemeIcon('symbol-package');
                break;
            case 'Info':
                this.iconPath = new vscode.ThemeIcon('info');
                break;
            default:
                this.iconPath = new vscode.ThemeIcon('list-tree');
        }
    }
}

class EEDetailItemNode extends vscode.TreeItem {
    constructor(
        label: string,
        description?: string,
        tooltip?: string
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.description = description;
        if (tooltip) {
            this.tooltip = tooltip;
        }
        this.contextValue = 'eeDetailItem';
    }
}

export class ExecutionEnvironmentsProvider implements vscode.TreeDataProvider<TreeNode> {
    private _onDidChangeTreeData: vscode.EventEmitter<TreeNode | undefined | null | void> = new vscode.EventEmitter<TreeNode | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<TreeNode | undefined | null | void> = this._onDidChangeTreeData.event;

    private _executionEnvironments: ExecutionEnvironment[] = [];
    private _eeDetailsCache: Map<string, EEDetails> = new Map();
    private _loading = false;
    private _pythonEnvApi: PythonEnvironmentApi | undefined;

    constructor() {
        this._initApi();
    }

    private async _initApi(): Promise<void> {
        try {
            const pythonEnvExtension = vscode.extensions.getExtension<PythonEnvironmentApi>('ms-python.vscode-python-envs');
            if (pythonEnvExtension) {
                if (!pythonEnvExtension.isActive) {
                    await pythonEnvExtension.activate();
                }
                this._pythonEnvApi = pythonEnvExtension.exports;
            }
        } catch (error) {
            log(`ExecutionEnvironmentsProvider: Failed to initialize API: ${error}`);
        }

        // Initial load
        this.refresh();
    }

    refresh(): void {
        this._executionEnvironments = [];
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: TreeNode): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: TreeNode): Promise<TreeNode[]> {
        if (!element) {
            // Root level - load execution environments
            return this._getExecutionEnvironments();
        }

        if (element instanceof EENode) {
            // Load EE details categories
            return this._getEEDetailCategories(element.ee);
        }

        if (element instanceof EEDetailCategoryNode) {
            // Return the items in this category
            return element.items;
        }

        return [];
    }

    private async _getExecutionEnvironments(): Promise<TreeNode[]> {
        if (this._loading) {
            return [new EEDetailItemNode('$(sync~spin) Loading...', '', 'Loading execution environments')];
        }

        if (this._executionEnvironments.length > 0) {
            return this._executionEnvironments.map(ee => new EENode(ee));
        }

        this._loading = true;

        try {
            const pythonEnvExtension = vscode.extensions.getExtension<PythonEnvironmentApi>('ms-python.vscode-python-envs');
            if (!pythonEnvExtension) {
                this._loading = false;
                return [new EEDetailItemNode('Python Environments extension not found', '', 'Install ms-python.vscode-python-envs')];
            }

            if (!pythonEnvExtension.isActive) {
                await pythonEnvExtension.activate();
            }

            const api = pythonEnvExtension.exports;
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
            const environment = await api.getEnvironment(workspaceFolder);

            if (!environment) {
                this._loading = false;
                return [new EEDetailItemNode('No Python environment selected', '', 'Select a Python environment first')];
            }

            const executable = environment.execInfo?.run?.executable;
            if (!executable) {
                this._loading = false;
                return [new EEDetailItemNode('No Python executable found', '', 'Check your Python environment')];
            }

            // Run ansible-navigator images command
            const output = await this._runCommand(
                `"${executable}" -m ansible_navigator images --mode stdout --pull-policy never --format json`,
                environment
            );

            if (!output) {
                this._loading = false;
                return [new EEDetailItemNode('No execution environments found', '', 'Install ansible-navigator and container runtime')];
            }

            try {
                const ees: ExecutionEnvironment[] = JSON.parse(output);
                // Filter to only execution environments
                this._executionEnvironments = ees.filter(ee => ee.execution_environment);
                this._loading = false;

                if (this._executionEnvironments.length === 0) {
                    return [new EEDetailItemNode('No execution environments found', '', 'Build or pull an execution environment image')];
                }

                return this._executionEnvironments.map(ee => new EENode(ee));
            } catch (parseError) {
                log(`ExecutionEnvironmentsProvider: Failed to parse EE list: ${parseError}`);
                this._loading = false;
                return [new EEDetailItemNode('Failed to parse execution environments', '', String(parseError))];
            }
        } catch (error) {
            log(`ExecutionEnvironmentsProvider: Error loading EEs: ${error}`);
            this._loading = false;
            return [new EEDetailItemNode('Error loading execution environments', '', String(error))];
        }
    }

    private async _getEEDetailCategories(ee: ExecutionEnvironment): Promise<TreeNode[]> {
        // Check cache first
        let details = this._eeDetailsCache.get(ee.full_name);

        if (!details) {
            try {
                const pythonEnvExtension = vscode.extensions.getExtension<PythonEnvironmentApi>('ms-python.vscode-python-envs');
                if (!pythonEnvExtension) {
                    return [new EEDetailItemNode('Python Environments extension not found')];
                }

                if (!pythonEnvExtension.isActive) {
                    await pythonEnvExtension.activate();
                }

                const api = pythonEnvExtension.exports;
                const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
                const environment = await api.getEnvironment(workspaceFolder);

                if (!environment) {
                    return [new EEDetailItemNode('No Python environment selected')];
                }

                const executable = environment.execInfo?.run?.executable;
                if (!executable) {
                    return [new EEDetailItemNode('No Python executable found')];
                }

                // Run ansible-navigator images with --details
                const output = await this._runCommand(
                    `"${executable}" -m ansible_navigator images "${ee.full_name}" --mode stdout --pull-policy never --details --format json`,
                    environment
                );

                if (!output) {
                    return [new EEDetailItemNode('Failed to load details')];
                }

                details = JSON.parse(output) as EEDetails;
                this._eeDetailsCache.set(ee.full_name, details);
            } catch (error) {
                log(`ExecutionEnvironmentsProvider: Failed to load EE details: ${error}`);
                return [new EEDetailItemNode('Error loading details', '', String(error))];
            }
        }

        const categories: TreeNode[] = [];

        // Info category
        const infoItems: EEDetailItemNode[] = [];
        if (details.ansible_version?.details) {
            infoItems.push(new EEDetailItemNode('Ansible', details.ansible_version.details));
        }
        if (details.os_release?.details?.[0]) {
            const os = details.os_release.details[0];
            const osName = os['pretty-name'] || os.name || 'Unknown';
            infoItems.push(new EEDetailItemNode('OS', osName));
        }
        if (details.image_name) {
            infoItems.push(new EEDetailItemNode('Image', details.image_name));
        }
        if (infoItems.length > 0) {
            categories.push(new EEDetailCategoryNode('Info', infoItems, ee.full_name));
        }

        // Ansible Collections category
        if (details.ansible_collections?.details) {
            const collectionItems: EEDetailItemNode[] = [];
            const collections = Object.entries(details.ansible_collections.details)
                .sort(([a], [b]) => a.localeCompare(b));
            
            for (const [name, version] of collections) {
                collectionItems.push(new EEDetailItemNode(name, version));
            }
            
            if (collectionItems.length > 0) {
                categories.push(new EEDetailCategoryNode('Ansible Collections', collectionItems, ee.full_name));
            }
        }

        // Python Packages category
        if (details.python_packages?.details) {
            const packageItems: EEDetailItemNode[] = [];
            const packages = [...details.python_packages.details]
                .sort((a, b) => a.name.localeCompare(b.name));
            
            for (const pkg of packages) {
                packageItems.push(new EEDetailItemNode(
                    pkg.name, 
                    pkg.version,
                    pkg.summary || undefined
                ));
            }
            
            if (packageItems.length > 0) {
                categories.push(new EEDetailCategoryNode('Python Packages', packageItems, ee.full_name));
            }
        }

        return categories;
    }

    private _runCommand(command: string, environment: PythonEnvironment): Promise<string | null> {
        return new Promise((resolve) => {
            const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            
            log(`ExecutionEnvironmentsProvider: Running command: ${command}`);
            
            cp.exec(command, { cwd, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
                if (error) {
                    // Exit code 1 is normal for ansible-navigator when returning JSON
                    if (error.code !== 1) {
                        log(`ExecutionEnvironmentsProvider: Command error: ${error.message}`);
                        log(`ExecutionEnvironmentsProvider: stderr: ${stderr}`);
                    }
                }
                
                if (stdout && stdout.trim()) {
                    resolve(stdout.trim());
                } else {
                    resolve(null);
                }
            });
        });
    }
}
