import * as vscode from 'vscode';
import * as cp from 'child_process';
import { log } from '../extension';
import { PythonEnvironmentApi } from '../types/pythonEnvApi';

interface SchemaNode {
    name: string;
    description?: string;
    parameters?: {
        type: string;
        properties: Record<string, ParameterSchema>;
        required: string[];
    };
    subcommands?: Record<string, SchemaNode>;
}

interface ParameterSchema {
    type: string;
    description: string;
    default?: unknown;
    enum?: string[];
    aliases?: string[];
}

type TreeNode = CategoryNode | CommandNode;

class CategoryNode extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly children: TreeNode[],
        public readonly commandPath: string[],
        description?: string,
    ) {
        super(label, vscode.TreeItemCollapsibleState.Collapsed);
        this.contextValue = 'creatorCategory';
        this.iconPath = new vscode.ThemeIcon('folder');
        
        // Use description for tooltip
        if (description) {
            this.tooltip = description;
        }
    }
}

class CommandNode extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly schema: SchemaNode,
        public readonly commandPath: string[],
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.contextValue = 'creatorCommand';
        this.iconPath = new vscode.ThemeIcon('new-file');
        
        // Use description for tooltip (full text on hover)
        const desc = schema.description || '';
        this.tooltip = desc || label;
        
        // Show truncated description inline if available
        if (desc && desc.length > 0) {
            // Truncate long descriptions for inline display
            this.description = desc.length > 50 ? desc.substring(0, 47) + '...' : desc;
        }
        
        // Click to open form
        this.command = {
            command: 'ansibleCreator.openForm',
            title: 'Open Creator Form',
            arguments: [commandPath, schema],
        };
    }
}

export class CreatorProvider implements vscode.TreeDataProvider<TreeNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private _schema: SchemaNode | null = null;
    private _loading = false;

    constructor() {
        this._loadSchema();
    }

    refresh(): void {
        this._schema = null;
        this._loadSchema();
    }

    getTreeItem(element: TreeNode): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: TreeNode): Promise<TreeNode[]> {
        if (!element) {
            // Root level - show Init and Add categories
            if (this._loading) {
                return [new CommandNode('Loading...', { name: 'loading' }, [])];
            }

            if (!this._schema) {
                return [new CommandNode('Schema not loaded', { name: 'error' }, [])];
            }

            const children: TreeNode[] = [];

            // Add "Init" category
            if (this._schema.subcommands?.init) {
                const initNode = this._buildCategoryNode('Init', this._schema.subcommands.init, ['init']);
                children.push(initNode);
            }

            // Add "Add" category
            if (this._schema.subcommands?.add) {
                const addNode = this._buildCategoryNode('Add', this._schema.subcommands.add, ['add']);
                children.push(addNode);
            }

            return children;
        }

        if (element instanceof CategoryNode) {
            return element.children;
        }

        return [];
    }

    private _buildCategoryNode(label: string, schema: SchemaNode, path: string[]): CategoryNode {
        const children: TreeNode[] = [];

        if (schema.subcommands) {
            for (const [name, subSchema] of Object.entries(schema.subcommands)) {
                const subPath = [...path, name];
                
                // Check if this has further subcommands
                if (subSchema.subcommands && Object.keys(subSchema.subcommands).length > 0) {
                    // It's a category with more children
                    const categoryNode = this._buildCategoryNode(
                        this._formatLabel(name),
                        subSchema,
                        subPath,
                    );
                    children.push(categoryNode);
                } else {
                    // It's a leaf command
                    children.push(new CommandNode(
                        this._formatLabel(name),
                        subSchema,
                        subPath,
                    ));
                }
            }
        }

        return new CategoryNode(label, children, path, schema.description);
    }

    private _formatLabel(name: string): string {
        // Convert snake_case to Title Case
        return name
            .split(/[_-]/)
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
    }

    private async _loadSchema(): Promise<void> {
        if (this._loading) {
            return;
        }

        this._loading = true;
        this._onDidChangeTreeData.fire();

        try {
            const pythonEnvExtension = vscode.extensions.getExtension<PythonEnvironmentApi>(
                'ms-python.vscode-python-envs',
            );
            
            if (!pythonEnvExtension) {
                log('CreatorProvider: Python Environments extension not found');
                this._loading = false;
                this._onDidChangeTreeData.fire();
                return;
            }

            if (!pythonEnvExtension.isActive) {
                await pythonEnvExtension.activate();
            }

            const api = pythonEnvExtension.exports;
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
            const environment = await api.getEnvironment(workspaceFolder);

            if (!environment) {
                log('CreatorProvider: No Python environment selected');
                this._loading = false;
                this._onDidChangeTreeData.fire();
                return;
            }

            const executable = environment.execInfo?.run?.executable;
            if (!executable) {
                log('CreatorProvider: No Python executable found');
                this._loading = false;
                this._onDidChangeTreeData.fire();
                return;
            }

            // Run ansible-creator schema
            const output = await this._runCommand(`"${executable}" -m ansible_creator schema`);
            
            if (output) {
                this._schema = JSON.parse(output);
                log(`CreatorProvider: Schema loaded successfully`);
            }
        } catch (error) {
            log(`CreatorProvider: Error loading schema: ${error}`);
        } finally {
            this._loading = false;
            this._onDidChangeTreeData.fire();
        }
    }

    private _runCommand(command: string): Promise<string | null> {
        return new Promise((resolve) => {
            const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            
            cp.exec(command, { cwd, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
                if (error) {
                    log(`CreatorProvider: Command error: ${error.message}`);
                    resolve(null);
                    return;
                }
                resolve(stdout.trim());
            });
        });
    }

    public getSchema(): SchemaNode | null {
        return this._schema;
    }
}
