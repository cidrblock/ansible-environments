import * as vscode from 'vscode';
import * as path from 'path';
import { PluginDocPanel } from './panels/PluginDocPanel';
import { AnsibleDevToolsProvider } from './views/AnsibleDevToolsProvider';
import { EnvironmentManagersProvider } from './views/EnvironmentManagersProvider';
import { CollectionsProvider } from './views/CollectionsProvider';
import { ExecutionEnvironmentsProvider } from './views/ExecutionEnvironmentsProvider';
import { CreatorProvider } from './views/CreatorProvider';
import { CreatorFormPanel } from './panels/CreatorFormPanel';
import { McpToolsProvider, injectToolPromptIntoChat } from './views/McpToolsProvider';
import { GalaxyCollectionCache } from './services/GalaxyCollectionCache';
import { CollectionsService } from './services/CollectionsService';
import { DevToolsService } from './services/DevToolsService';
import { ExecutionEnvService } from './services/ExecutionEnvService';
import { CreatorService } from './services/CreatorService';
import { PythonEnvironment, PythonEnvironmentApi } from './types/pythonEnvApi';
import { registerMcpServerProvider, isMcpAvailable, configureCursorMcp, showCursorMcpStatus } from './mcp';
import { cacheSelectedEnvironment } from './services/EnvironmentCache';

// Create output channel for extension logs
export const outputChannel = vscode.window.createOutputChannel('Ansible Environments');

export function log(message: string) {
    const timestamp = new Date().toISOString();
    outputChannel.appendLine(`[${timestamp}] ${message}`);
    console.log(message);
}

export function activate(context: vscode.ExtensionContext) {
    outputChannel.show(true); // Show the output channel on activation
    log('Ansible Environments extension is now active');
    console.log('Ansible Environments extension is now active');

    // Register MCP server provider for VS Code Copilot integration
    if (isMcpAvailable()) {
        registerMcpServerProvider(context);
        log('MCP server provider registered for VS Code');
    } else {
        log('VS Code MCP API not available (requires VS Code 1.99+)');
    }

    // Check if workspace is open
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        vscode.window.showWarningMessage('Ansible Environments requires an open workspace folder.');
        return;
    }

    // Register the Environment Managers view
    const envManagersProvider = new EnvironmentManagersProvider();
    const envManagersView = vscode.window.createTreeView('ansibleDevToolsEnvManagers', {
        treeDataProvider: envManagersProvider,
        showCollapseAll: true
    });
    context.subscriptions.push(envManagersView);

    // Register the Packages view
    const devToolsProvider = new AnsibleDevToolsProvider();
    const packagesView = vscode.window.createTreeView('ansibleDevToolsPackages', {
        treeDataProvider: devToolsProvider,
        showCollapseAll: false
    });
    context.subscriptions.push(packagesView);

    // Register the Collections view
    const collectionsProvider = new CollectionsProvider();
    const collectionsView = vscode.window.createTreeView('ansibleDevToolsCollections', {
        treeDataProvider: collectionsProvider,
        showCollapseAll: true
    });
    context.subscriptions.push(collectionsView);

    // Register the Execution Environments view
    const eeProvider = new ExecutionEnvironmentsProvider();
    const eeView = vscode.window.createTreeView('ansibleExecutionEnvironments', {
        treeDataProvider: eeProvider,
        showCollapseAll: true
    });
    context.subscriptions.push(eeView);

    // Register the Creator view
    const creatorProvider = new CreatorProvider();
    const creatorView = vscode.window.createTreeView('ansibleCreator', {
        treeDataProvider: creatorProvider,
        showCollapseAll: true
    });
    context.subscriptions.push(creatorView);

    // Register the MCP Tools view
    const mcpToolsProvider = new McpToolsProvider();
    const mcpToolsView = vscode.window.createTreeView('ansibleMcpTools', {
        treeDataProvider: mcpToolsProvider,
        showCollapseAll: true
    });
    context.subscriptions.push(mcpToolsView);

    // Register sidebar commands
    const refreshCommand = vscode.commands.registerCommand(
        'ansibleDevToolsPackages.refresh',
        () => {
            devToolsProvider.refresh();
        }
    );

    const installCommand = vscode.commands.registerCommand(
        'ansibleDevToolsPackages.install',
        async () => {
            try {
                const devToolsService = DevToolsService.getInstance();
                await devToolsService.install();
                vscode.window.showInformationMessage('ansible-dev-tools installation started.');
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to install ansible-dev-tools: ${error}`);
            }
        }
    );

    const upgradeCommand = vscode.commands.registerCommand(
        'ansibleDevToolsPackages.upgrade',
        async () => {
            try {
                const devToolsService = DevToolsService.getInstance();
                await devToolsService.upgrade();
                vscode.window.showInformationMessage('Upgrading ansible-dev-tools...');
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to upgrade ansible-dev-tools: ${error}`);
            }
        }
    );

    // Register Environment Managers commands
    const envManagersRefreshCommand = vscode.commands.registerCommand(
        'ansibleDevToolsEnvManagers.refresh',
        () => {
            envManagersProvider.refresh();
        }
    );

    const envManagersCreateCommand = vscode.commands.registerCommand(
        'ansibleDevToolsEnvManagers.create',
        async () => {
            try {
                const pythonEnvExtension = vscode.extensions.getExtension<PythonEnvironmentApi>('ms-python.vscode-python-envs');
                if (!pythonEnvExtension) {
                    vscode.window.showErrorMessage('Python Environments extension not found.');
                    return;
                }

                if (!pythonEnvExtension.isActive) {
                    await pythonEnvExtension.activate();
                }

                const api = pythonEnvExtension.exports;
                const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;

                if (!workspaceFolder) {
                    vscode.window.showErrorMessage('No workspace folder open.');
                    return;
                }

                const environment = await api.createEnvironment(workspaceFolder, {
                    quickCreate: false
                });

                if (environment) {
                    vscode.window.showInformationMessage(`Created environment: ${environment.displayName}`);
                    envManagersProvider.refresh();
                    devToolsProvider.refresh();
                    collectionsProvider.refresh();
                }
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to create environment: ${error}`);
            }
        }
    );

    const selectEnvCommand = vscode.commands.registerCommand(
        'ansibleDevTools.selectEnvironment',
        async (environment: PythonEnvironment) => {
            try {
                const pythonEnvExtension = vscode.extensions.getExtension<PythonEnvironmentApi>('ms-python.vscode-python-envs');
                if (!pythonEnvExtension) {
                    vscode.window.showErrorMessage('Python Environments extension not found.');
                    return;
                }

                if (!pythonEnvExtension.isActive) {
                    await pythonEnvExtension.activate();
                }

                const api = pythonEnvExtension.exports;
                const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;

                await api.setEnvironment(workspaceFolder, environment);
                vscode.window.showInformationMessage(`Selected environment: ${environment.displayName}`);
                
                // Refresh all views
                envManagersProvider.refresh();
                devToolsProvider.refresh();
                collectionsProvider.refresh();
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to select environment: ${error}`);
            }
        }
    );

    // Start background loading of Galaxy collections cache
    const galaxyCache = GalaxyCollectionCache.getInstance();
    galaxyCache.setExtensionContext(context);
    galaxyCache.startBackgroundLoad();

    // Register Collections commands
    const collectionsRefreshCommand = vscode.commands.registerCommand(
        'ansibleDevToolsCollections.refresh',
        () => {
            collectionsProvider.refresh();
        }
    );

    // Register Execution Environments refresh command
    const eeRefreshCommand = vscode.commands.registerCommand(
        'ansibleExecutionEnvironments.refresh',
        () => {
            eeProvider.refresh();
        }
    );

    // Register Creator commands
    const creatorRefreshCommand = vscode.commands.registerCommand(
        'ansibleCreator.refresh',
        () => {
            creatorProvider.refresh();
        }
    );

    const creatorOpenFormCommand = vscode.commands.registerCommand(
        'ansibleCreator.openForm',
        (commandPath: string[], schema: unknown) => {
            CreatorFormPanel.show(context.extensionUri, commandPath, schema as any);
        }
    );

    // Register Cursor MCP configuration commands
    const configureCursorMcpCommand = vscode.commands.registerCommand(
        'ansible-environments.configureCursorMcp',
        () => configureCursorMcp(context)
    );

    const showMcpStatusCommand = vscode.commands.registerCommand(
        'ansible-environments.showMcpStatus',
        () => showCursorMcpStatus(context)
    );

    // Register MCP Tools commands
    const mcpToolsRefreshCommand = vscode.commands.registerCommand(
        'ansibleMcpTools.refresh',
        () => mcpToolsProvider.refresh()
    );

    const mcpToolsUseInChatCommand = vscode.commands.registerCommand(
        'ansibleMcpTools.useInChat',
        async (toolInfo) => {
            if (toolInfo) {
                await injectToolPromptIntoChat(toolInfo);
            }
        }
    );

    const mcpToolsCopyPromptCommand = vscode.commands.registerCommand(
        'ansibleMcpTools.copyPrompt',
        async (node) => {
            if (node && node.toolInfo) {
                await vscode.env.clipboard.writeText(node.toolInfo.examplePrompt);
                vscode.window.showInformationMessage(`Prompt copied: "${node.toolInfo.examplePrompt}"`);
            }
        }
    );

    // Register Galaxy cache refresh command
    const galaxyCacheRefreshCommand = vscode.commands.registerCommand(
        'ansibleDevToolsCollections.refreshGalaxyCache',
        async () => {
            vscode.window.showInformationMessage('Refreshing Galaxy collections cache...');
            await galaxyCache.forceRefresh();
            vscode.window.showInformationMessage(`Galaxy cache refreshed: ${galaxyCache.getCollections().length} collections loaded`);
        }
    );

    const collectionsInstallCommand = vscode.commands.registerCommand(
        'ansibleDevToolsCollections.install',
        async () => {
            try {
                const collectionsService = CollectionsService.getInstance();
                
                // Show quick pick immediately
                const quickPick = vscode.window.createQuickPick();
                quickPick.title = 'Install Ansible Collection';
                quickPick.placeholder = 'Type to search collections...';
                quickPick.matchOnDescription = true;
                quickPick.matchOnDetail = true;
                quickPick.busy = !galaxyCache.isLoaded();

                const updateItems = (query: string) => {
                    if (!galaxyCache.isLoaded()) {
                        const progress = galaxyCache.getProgress();
                        const progressText = progress.total > 0 
                            ? `${progress.loaded} of ${progress.total}`
                            : '...';
                        quickPick.items = [{
                            label: `$(sync~spin) Loading collections from Galaxy... ${progressText}`,
                            description: '',
                            alwaysShow: true
                        }];
                        return;
                    }
                    
                    const results = galaxyCache.search(query);
                    quickPick.items = results.map(c => ({
                        label: `${c.namespace}.${c.name}`,
                        description: `v${c.version}`,
                        detail: c.deprecated ? '(deprecated)' : `${c.downloadCount.toLocaleString()} downloads`
                    }));
                };

                // Initial items
                updateItems('');

                // If cache loads while picker is open, update the list
                const loadListener = galaxyCache.onDidLoad(() => {
                    quickPick.busy = false;
                    updateItems(quickPick.value);
                });

                // Update progress while loading
                const progressListener = galaxyCache.onDidUpdateProgress(() => {
                    if (!galaxyCache.isLoaded()) {
                        updateItems(quickPick.value);
                    }
                });

                quickPick.onDidChangeValue(value => {
                    updateItems(value);
                });

                // Ensure cache is loading
                if (!galaxyCache.isLoaded() && !galaxyCache.isLoading()) {
                    galaxyCache.startBackgroundLoad();
                }

                quickPick.onDidAccept(async () => {
                    const selected = quickPick.selectedItems[0];
                    // Skip if loading placeholder or no selection
                    if (!selected || selected.label.startsWith('$(sync~spin)')) {
                        return;
                    }
                    
                    quickPick.hide();
                    
                    const collectionName = selected.label;
                    
                    try {
                        await collectionsService.installCollection(collectionName);
                        vscode.window.showInformationMessage(`Installing collection ${collectionName}...`);
                    } catch (error) {
                        vscode.window.showErrorMessage(`Failed to install collection: ${error}`);
                    }
                });

                quickPick.onDidHide(() => {
                    loadListener.dispose();
                    progressListener.dispose();
                    quickPick.dispose();
                });
                quickPick.show();

            } catch (error) {
                vscode.window.showErrorMessage(`Failed to install collection: ${error}`);
            }
        }
    );

    // Register plugin documentation command
    const showPluginDocCommand = vscode.commands.registerCommand(
        'ansibleDevTools.showPluginDoc',
        async (pluginFullName: string, pluginType: string) => {
            await PluginDocPanel.show(context.extensionUri, pluginFullName, pluginType);
        }
    );

    context.subscriptions.push(
        refreshCommand, 
        installCommand, 
        upgradeCommand,
        envManagersRefreshCommand,
        envManagersCreateCommand,
        selectEnvCommand,
        collectionsRefreshCommand,
        collectionsInstallCommand,
        showPluginDocCommand,
        eeRefreshCommand,
        galaxyCacheRefreshCommand,
        creatorRefreshCommand,
        creatorOpenFormCommand,
        configureCursorMcpCommand,
        showMcpStatusCommand,
        mcpToolsRefreshCommand,
        mcpToolsUseInChatCommand,
        mcpToolsCopyPromptCommand
    );

    // Check if Python Environments extension is available and set up environment caching
    const pythonEnvsExtension = vscode.extensions.getExtension<PythonEnvironmentApi>('ms-python.vscode-python-envs');
    if (!pythonEnvsExtension) {
        vscode.window.showErrorMessage(
            'The Microsoft Python Environments extension is required. Please install it from the marketplace.',
            'Install'
        ).then(selection => {
            if (selection === 'Install') {
                vscode.commands.executeCommand(
                    'workbench.extensions.installExtension',
                    'ms-python.vscode-python-envs'
                );
            }
        });
    } else {
        // Set up environment caching for standalone MCP server
        // Use the same pattern as the UI providers - refresh cache when environment changes
        (async () => {
            try {
                if (!pythonEnvsExtension.isActive) {
                    await pythonEnvsExtension.activate();
                }
                const api = pythonEnvsExtension.exports;
                
                // Helper to refresh the cache - always fetches current environment from API
                const refreshCache = async () => {
                    try {
                        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
                        const currentEnv = await api.getEnvironment(workspaceFolder);
                        
                        if (currentEnv?.execInfo?.run?.executable) {
                            const execPath = currentEnv.execInfo.run.executable;
                            log(`Caching environment: ${currentEnv.displayName} (${execPath})`);
                            cacheSelectedEnvironment(execPath, currentEnv.displayName);
                        } else {
                            log(`No environment executable found to cache`);
                        }
                    } catch (error) {
                        log(`Failed to refresh environment cache: ${error}`);
                    }
                };
                
                // Listen for environment changes - refresh cache when it changes
                if (api.onDidChangeEnvironment) {
                    const envCacheListener = api.onDidChangeEnvironment(async () => {
                        // Use a small delay to ensure the change is fully processed
                        setTimeout(refreshCache, 500);
                    });
                    context.subscriptions.push(envCacheListener);
                }
                
                // Initial cache after a delay to let Python extension discover venvs
                setTimeout(refreshCache, 2000);
                
            } catch (error) {
                log(`Failed to set up environment caching: ${error}`);
            }
        })();
    }
}

export function deactivate() {
    outputChannel.dispose();
}
