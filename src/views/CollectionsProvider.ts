import * as vscode from 'vscode';
import { PythonEnvironmentApi } from '../types/pythonEnvApi';
import * as cp from 'child_process';
import * as path from 'path';

type TreeNode = CollectionNode | PluginTypeNode | PluginNode | LoadingNode;

interface LoadingNode {
    type: 'loading';
}

interface CollectionInfo {
    version: string;
    authors: string[];
    description: string;
}

interface CollectionNode {
    type: 'collection';
    name: string;
    info: CollectionInfo;
    pluginTypes: Map<string, PluginInfo[]>;
}

interface PluginTypeNode {
    type: 'pluginType';
    name: string;
    collectionName: string;
    plugins: PluginInfo[];
}

interface PluginNode {
    type: 'plugin';
    name: string;
    fullName: string;
    shortDescription: string;
    pluginType: string;
}

interface PluginInfo {
    name: string;
    fullName: string;
    shortDescription: string;
}

interface MetadataDoc {
    plugin_name?: string;
    short_description?: string;
    collection?: string;
}

interface MetadataEntry {
    doc?: MetadataDoc;
}

interface MetadataPluginTypes {
    [pluginType: string]: {
        [pluginFullName: string]: MetadataEntry;
    };
}

interface MetadataDump {
    all?: MetadataPluginTypes;
}

interface AdeCollectionInfo {
    collection_info: {
        version: string;
        authors: string[];
        description: string;
    };
}

interface AdeInspectOutput {
    [collectionName: string]: AdeCollectionInfo;
}

export class CollectionsProvider implements vscode.TreeDataProvider<TreeNode> {
    private _onDidChangeTreeData: vscode.EventEmitter<TreeNode | undefined | null | void> = new vscode.EventEmitter<TreeNode | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<TreeNode | undefined | null | void> = this._onDidChangeTreeData.event;

    private _pythonEnvApi: PythonEnvironmentApi | undefined;
    private _collections: Map<string, { info: CollectionInfo; pluginTypes: Map<string, PluginInfo[]> }> = new Map();
    private _envListener: vscode.Disposable | undefined;
    private _loading: boolean = false;

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
        // Prevent concurrent refreshes
        if (this._loading) {
            return;
        }
        
        this._loading = true;
        this._collections.clear(); // Clear before firing to show loading state
        this._onDidChangeTreeData.fire();
        
        try {
            await this._loadCollections();
        } finally {
            this._loading = false;
            this._onDidChangeTreeData.fire();
        }
    }

    private async _loadCollections(): Promise<void> {
        this._collections.clear();
        
        if (!this._pythonEnvApi) {
            return;
        }

        try {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
            const environment = await this._pythonEnvApi.getEnvironment(workspaceFolder);
            
            if (!environment) {
                return;
            }

            const executable = environment.execInfo?.run?.executable;
            if (!executable) {
                return;
            }

            const envBinDir = path.dirname(executable);
            const envPath = path.dirname(envBinDir); // Get venv root path
            const ansibleDocPath = path.join(envBinDir, 'ansible-doc');
            const adePath = path.join(envBinDir, 'ade');

            // First, get collection info from ade inspect
            const collectionInfoMap = new Map<string, CollectionInfo>();
            try {
                const adeResult = await new Promise<string>((resolve, reject) => {
                    cp.exec(
                        `"${adePath}" inspect --venv "${envPath}" --no-ansi`,
                        { maxBuffer: 10 * 1024 * 1024 },
                        (error, stdout, stderr) => {
                            if (error) {
                                reject(error);
                                return;
                            }
                            resolve(stdout);
                        }
                    );
                });

                const adeData: AdeInspectOutput = JSON.parse(adeResult);
                for (const [collName, collData] of Object.entries(adeData)) {
                    if (collData.collection_info) {
                        collectionInfoMap.set(collName, {
                            version: collData.collection_info.version || '',
                            authors: collData.collection_info.authors || [],
                            description: collData.collection_info.description || ''
                        });
                    }
                }
            } catch (error) {
                console.log('ade inspect not available, collection metadata will be limited');
            }

            // Run ansible-doc --metadata-dump
            const result = await new Promise<string>((resolve, reject) => {
                cp.exec(
                    `ANSIBLE_WARNINGS=false "${ansibleDocPath}" --metadata-dump --no-fail-on-errors`,
                    { maxBuffer: 50 * 1024 * 1024 }, // 50MB buffer for large output
                    (error, stdout, stderr) => {
                        if (error) {
                            reject(error);
                            return;
                        }
                        resolve(stdout);
                    }
                );
            });

            // Parse the JSON output
            const metadata: MetadataDump = JSON.parse(result);
            
            if (!metadata.all) {
                return;
            }

            // Use a Set to track unique plugins globally (collection:pluginType:fullName)
            const seenPlugins = new Set<string>();

            // Process each plugin type
            for (const [pluginType, plugins] of Object.entries(metadata.all)) {
                for (const [fullName, pluginData] of Object.entries(plugins)) {
                    const doc = pluginData.doc;
                    if (!doc) {continue;}
                    
                    const collectionName = doc.collection || 'unknown';
                    const pluginName = doc.plugin_name?.split('.').pop() || fullName.split('.').pop() || fullName;
                    const shortDescription = doc.short_description || '';

                    // Create unique key to prevent duplicates
                    const uniqueKey = `${collectionName}:${pluginType}:${fullName}`;
                    if (seenPlugins.has(uniqueKey)) {
                        continue; // Skip duplicate
                    }
                    seenPlugins.add(uniqueKey);

                    // Get or create collection
                    if (!this._collections.has(collectionName)) {
                        const info = collectionInfoMap.get(collectionName) || {
                            version: '',
                            authors: [],
                            description: ''
                        };
                        this._collections.set(collectionName, {
                            info,
                            pluginTypes: new Map()
                        });
                    }
                    const collection = this._collections.get(collectionName)!;

                    // Get or create plugin type
                    if (!collection.pluginTypes.has(pluginType)) {
                        collection.pluginTypes.set(pluginType, []);
                    }
                    
                    collection.pluginTypes.get(pluginType)!.push({
                        name: pluginName,
                        fullName: fullName,
                        shortDescription: shortDescription
                    });
                }
            }

            // Sort plugins within each type
            for (const collection of this._collections.values()) {
                for (const plugins of collection.pluginTypes.values()) {
                    plugins.sort((a, b) => a.name.localeCompare(b.name));
                }
            }
        } catch (error) {
            console.error('Failed to load collections:', error);
        }
    }

    getTreeItem(element: TreeNode): vscode.TreeItem {
        if (element.type === 'loading') {
            const item = new vscode.TreeItem(
                'Indexing collections...',
                vscode.TreeItemCollapsibleState.None
            );
            item.iconPath = new vscode.ThemeIcon('sync~spin');
            item.tooltip = 'Scanning installed collections and plugins. This may take a moment.';
            return item;
        }
        
        if (element.type === 'collection') {
            const item = new vscode.TreeItem(
                element.name,
                vscode.TreeItemCollapsibleState.Collapsed
            );
            item.description = element.info.version ? `v${element.info.version}` : undefined;
            item.iconPath = new vscode.ThemeIcon('library');
            item.contextValue = 'collection';
            
            // Build tooltip with collection info
            const tooltipParts: string[] = [`**${element.name}**`];
            if (element.info.version) {
                tooltipParts.push(`\n\nVersion: ${element.info.version}`);
            }
            if (element.info.authors && element.info.authors.length > 0) {
                tooltipParts.push(`\n\nAuthors: ${element.info.authors.join(', ')}`);
            }
            if (element.info.description) {
                tooltipParts.push(`\n\n${element.info.description}`);
            }
            item.tooltip = new vscode.MarkdownString(tooltipParts.join(''));
            
            return item;
        } else if (element.type === 'pluginType') {
            const item = new vscode.TreeItem(
                element.name,
                vscode.TreeItemCollapsibleState.Collapsed
            );
            item.description = `(${element.plugins.length})`;
            item.iconPath = new vscode.ThemeIcon('symbol-folder');
            item.contextValue = 'pluginType';
            return item;
        } else if (element.type === 'plugin') {
            const item = new vscode.TreeItem(
                element.name,
                vscode.TreeItemCollapsibleState.None
            );
            item.description = element.shortDescription;
            item.iconPath = new vscode.ThemeIcon('symbol-method');
            item.contextValue = 'plugin';
            item.tooltip = new vscode.MarkdownString(
                `**${element.fullName}**\n\n${element.shortDescription}\n\n*Click to view documentation*`
            );
            item.command = {
                command: 'ansibleDevTools.showPluginDoc',
                title: 'Show Plugin Documentation',
                arguments: [element.fullName, element.pluginType]
            };
            return item;
        } else {
            // Loading node - handled above
            return new vscode.TreeItem('');
        }
    }

    getChildren(element?: TreeNode): Thenable<TreeNode[]> {
        if (!element) {
            // Show loading indicator when indexing
            if (this._loading) {
                return Promise.resolve([{ type: 'loading' } as LoadingNode]);
            }
            
            // Root level - return collections sorted alphabetically
            const collections: CollectionNode[] = [];
            for (const [name, data] of this._collections) {
                collections.push({
                    type: 'collection',
                    name,
                    info: data.info,
                    pluginTypes: data.pluginTypes
                });
            }
            collections.sort((a, b) => a.name.localeCompare(b.name));
            return Promise.resolve(collections);
        } else if (element.type === 'collection') {
            // Return plugin types for this collection
            const pluginTypes: PluginTypeNode[] = [];
            for (const [typeName, plugins] of element.pluginTypes) {
                pluginTypes.push({
                    type: 'pluginType',
                    name: typeName,
                    collectionName: element.name,
                    plugins
                });
            }
            pluginTypes.sort((a, b) => a.name.localeCompare(b.name));
            return Promise.resolve(pluginTypes);
        } else if (element.type === 'pluginType') {
            // Return plugins for this type
            const plugins: PluginNode[] = element.plugins.map(p => ({
                type: 'plugin',
                name: p.name,
                fullName: p.fullName,
                shortDescription: p.shortDescription,
                pluginType: element.name
            }));
            return Promise.resolve(plugins);
        }
        
        return Promise.resolve([]);
    }

    dispose() {
        this._envListener?.dispose();
        this._onDidChangeTreeData.dispose();
    }
}
