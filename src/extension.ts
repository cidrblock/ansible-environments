import * as vscode from 'vscode';
import * as path from 'path';
import { PluginDocPanel } from './panels/PluginDocPanel';
import { AnsibleDevToolsProvider } from './views/AnsibleDevToolsProvider';
import { EnvironmentManagersProvider } from './views/EnvironmentManagersProvider';
import { CollectionsProvider } from './views/CollectionsProvider';
import { ExecutionEnvironmentsProvider } from './views/ExecutionEnvironmentsProvider';
import { CreatorProvider } from './views/CreatorProvider';
import { CreatorFormPanel } from './panels/CreatorFormPanel';
import { PlaybooksProvider } from './views/PlaybooksProvider';
import { PlaybookConfigPanel } from './panels/PlaybookConfigPanel';
import { PlaybooksService, PlaybookInfo, PlaybookPlay } from './services/PlaybooksService';
import { McpToolsProvider, injectToolPromptIntoChat } from './views/McpToolsProvider';
import { GalaxyCollectionCache } from './services/GalaxyCollectionCache';
import { CollectionsService, setLogFunction as setCollectionsLogFunction } from './services/CollectionsService';
import { DevToolsService } from './services/DevToolsService';
import { ExecutionEnvService } from './services/ExecutionEnvService';
import { CreatorService } from './services/CreatorService';
import { PythonEnvironment, PythonEnvironmentApi } from './types/pythonEnvApi';
import { registerMcpServerProvider, isMcpAvailable, configureCursorMcp, showCursorMcpStatus, getMcpStatus } from './mcp';
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
    
    // Inject log function into services
    setCollectionsLogFunction(log);
    
    log('Ansible Environments extension is now active');
    console.log('Ansible Environments extension is now active');

    // Helper to update MCP status context
    const updateMcpStatusContext = () => {
        const status = getMcpStatus(context);
        vscode.commands.executeCommand('setContext', 'ansibleMcp.configured', status.isConfigured);
        log(`MCP Status: IDE=${status.ide}, configured=${status.isConfigured}`);
    };
    
    // Set initial MCP status context
    updateMcpStatusContext();

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

    // Register the Playbooks view
    const playbooksProvider = new PlaybooksProvider();
    const playbooksView = vscode.window.createTreeView('ansiblePlaybooks', {
        treeDataProvider: playbooksProvider,
        showCollapseAll: true
    });
    context.subscriptions.push(playbooksView);

    // Refresh playbooks when workspace folders change
    const workspaceFoldersListener = vscode.workspace.onDidChangeWorkspaceFolders(() => {
        log('Workspace folders changed, refreshing playbooks...');
        playbooksProvider.refresh();
    });
    context.subscriptions.push(workspaceFoldersListener);

    // Register the MCP Tools view
    const mcpToolsProvider = new McpToolsProvider(context);
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

                // Check if this is a global/system environment
                const isGlobalEnv = environment.envId?.managerId?.toLowerCase().includes('system');
                
                if (isGlobalEnv) {
                    const selection = await vscode.window.showWarningMessage(
                        'Use of global Python environments for Ansible development is strongly discouraged. Please create and select a virtual environment instead.',
                        'Create Virtual Environment',
                        'Use Anyway'
                    );
                    
                    if (selection === 'Create Virtual Environment') {
                        // Trigger the create environment command
                        vscode.commands.executeCommand('ansibleDevToolsEnvManagers.create');
                        return;
                    } else if (selection !== 'Use Anyway') {
                        // User cancelled
                        return;
                    }
                }

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

    // Register Collections search command
    interface PluginQuickPickItem extends vscode.QuickPickItem {
        fullName: string;
        pluginType: string;
    }
    
    const collectionsSearchCommand = vscode.commands.registerCommand(
        'ansibleDevToolsCollections.search',
        async () => {
            const collectionsService = CollectionsService.getInstance();
            
            // Get all plugins from all collections
            const allPlugins: PluginQuickPickItem[] = [];
            
            for (const [, data] of collectionsService.getCollections()) {
                for (const [pluginType, plugins] of data.pluginTypes) {
                    for (const plugin of plugins) {
                        allPlugins.push({
                            label: plugin.fullName,
                            description: `(${pluginType})`,
                            detail: plugin.shortDescription,
                            fullName: plugin.fullName,
                            pluginType: pluginType
                        });
                    }
                }
            }
            
            // Sort alphabetically
            allPlugins.sort((a, b) => a.label.localeCompare(b.label));
            
            const quickPick = vscode.window.createQuickPick<PluginQuickPickItem>();
            quickPick.title = 'Search Plugins';
            quickPick.placeholder = 'Type to search... (e.g., "interface" or "module:config")';
            quickPick.matchOnDescription = true;
            quickPick.matchOnDetail = true;
            quickPick.items = allPlugins;
            
            quickPick.onDidChangeValue(value => {
                // Support typed search: "module:name" or "filter:name"
                const typeMatch = value.match(/^(\w+):(.*)$/);
                if (typeMatch) {
                    const [, pluginType, query] = typeMatch;
                    const lowerQuery = query.toLowerCase();
                    const lowerType = pluginType.toLowerCase();
                    quickPick.items = allPlugins.filter(p => 
                        p.pluginType.toLowerCase() === lowerType &&
                        (p.label.toLowerCase().includes(lowerQuery) || 
                         (p.detail?.toLowerCase().includes(lowerQuery) ?? false))
                    );
                } else {
                    // Regular search - let QuickPick handle matching
                    quickPick.items = allPlugins;
                }
            });
            
            quickPick.onDidAccept(() => {
                const selected = quickPick.selectedItems[0];
                if (selected) {
                    quickPick.hide();
                    // Open plugin documentation
                    vscode.commands.executeCommand(
                        'ansibleDevTools.showPluginDoc',
                        selected.fullName,
                        selected.pluginType
                    );
                }
            });
            
            quickPick.onDidHide(() => quickPick.dispose());
            quickPick.show();
        }
    );

    // Register Execution Environments refresh command
    const eeRefreshCommand = vscode.commands.registerCommand(
        'ansibleExecutionEnvironments.refresh',
        () => {
            eeProvider.refresh();
        }
    );

    // AI Summary Commands - Collections
    const collectionsAiSummaryCommand = vscode.commands.registerCommand(
        'ansibleDevToolsCollections.aiSummary',
        async () => {
            const prompt = `Generate a summary of the installed Ansible collections in this workspace.

Use the \`list_collections\` MCP tool to get the list of installed collections, then provide:
1. A brief overview of the collection categories (networking, cloud, system, etc.)
2. Key capabilities provided by these collections
3. Any recommendations for commonly paired collections that might be missing`;
            
            await vscode.env.clipboard.writeText(prompt);
            vscode.window.showInformationMessage(
                'AI prompt copied to clipboard. Paste it into an agent chat session.',
                'Open Chat'
            ).then(selection => {
                if (selection === 'Open Chat') {
                    vscode.commands.executeCommand('workbench.action.chat.open');
                }
            });
        }
    );

    const collectionsAiCollectionSummaryCommand = vscode.commands.registerCommand(
        'ansibleDevToolsCollections.aiCollectionSummary',
        async (node: { name: string }) => {
            if (!node?.name) {return;}
            const prompt = `Generate a summary of the Ansible collection "${node.name}".

Use the \`list_plugins\` MCP tool with collection="${node.name}" to get all plugins in this collection, then provide:
1. A brief description of what this collection is for
2. The key modules, plugins, and roles it provides
3. Common use cases and example scenarios
4. Any dependencies or requirements`;
            
            await vscode.env.clipboard.writeText(prompt);
            vscode.window.showInformationMessage(
                'AI prompt copied to clipboard. Paste it into an agent chat session.',
                'Open Chat'
            ).then(selection => {
                if (selection === 'Open Chat') {
                    vscode.commands.executeCommand('workbench.action.chat.open');
                }
            });
        }
    );

    const collectionsAiPluginSummaryCommand = vscode.commands.registerCommand(
        'ansibleDevToolsCollections.aiPluginSummary',
        async (node: { fullName: string; pluginType: string }) => {
            if (!node?.fullName) {return;}
            const prompt = `Explain the Ansible ${node.pluginType} plugin "${node.fullName}".

Use the \`get_plugin_documentation\` MCP tool with plugin_name="${node.fullName}" and plugin_type="${node.pluginType}" to get the full documentation, then provide:
1. What this plugin does in plain language
2. The most important parameters and when to use them
3. A practical example task showing common usage
4. Any gotchas or best practices`;
            
            await vscode.env.clipboard.writeText(prompt);
            vscode.window.showInformationMessage(
                'AI prompt copied to clipboard. Paste it into an agent chat session.',
                'Open Chat'
            ).then(selection => {
                if (selection === 'Open Chat') {
                    vscode.commands.executeCommand('workbench.action.chat.open');
                }
            });
        }
    );

    // AI Summary Commands - Execution Environments
    const eeAiSummaryCommand = vscode.commands.registerCommand(
        'ansibleExecutionEnvironments.aiSummary',
        async () => {
            const prompt = `Generate a summary of the available Ansible Execution Environments.

Use the \`list_execution_environments\` MCP tool to get the list of available EEs, then provide:
1. An overview of each execution environment and its purpose
2. Key tools and collections included in each
3. Recommendations for which EE to use for different scenarios`;
            
            await vscode.env.clipboard.writeText(prompt);
            vscode.window.showInformationMessage(
                'AI prompt copied to clipboard. Paste it into an agent chat session.',
                'Open Chat'
            ).then(selection => {
                if (selection === 'Open Chat') {
                    vscode.commands.executeCommand('workbench.action.chat.open');
                }
            });
        }
    );

    const eeAiEESummaryCommand = vscode.commands.registerCommand(
        'ansibleExecutionEnvironments.aiEESummary',
        async (node: { label: string }) => {
            if (!node?.label) {return;}
            const prompt = `Generate a detailed summary of the Ansible Execution Environment "${node.label}".

Provide information about:
1. The container image and its base
2. Python packages installed and their versions
3. Ansible collections included
4. System tools and utilities available
5. Best use cases for this execution environment`;
            
            await vscode.env.clipboard.writeText(prompt);
            vscode.window.showInformationMessage(
                'AI prompt copied to clipboard. Paste it into an agent chat session.',
                'Open Chat'
            ).then(selection => {
                if (selection === 'Open Chat') {
                    vscode.commands.executeCommand('workbench.action.chat.open');
                }
            });
        }
    );

    // AI Summary Commands - Creator
    const creatorAiSummaryCommand = vscode.commands.registerCommand(
        'ansibleCreator.aiSummary',
        async () => {
            const prompt = `Explain the ansible-creator scaffolding tool and summarize its capabilities.

Use the \`get_ansible_creator_schema\` MCP tool to get the full schema, then provide:
1. What ansible-creator is and why it's useful
2. A summary of each content type it can scaffold (collections, playbooks, plugins, etc.)
3. The key parameters for each scaffolding command
4. Best practices for starting new Ansible projects
5. How the generated structure follows Ansible best practices`;
            
            await vscode.env.clipboard.writeText(prompt);
            vscode.window.showInformationMessage(
                'AI prompt copied to clipboard. Paste it into an agent chat session.',
                'Open Chat'
            ).then(selection => {
                if (selection === 'Open Chat') {
                    vscode.commands.executeCommand('workbench.action.chat.open');
                }
            });
        }
    );

    const creatorAiEntrySummaryCommand = vscode.commands.registerCommand(
        'ansibleCreator.aiEntrySummary',
        async (node: { label: string; schema: { description?: string }; commandPath: string[] }) => {
            if (!node?.commandPath) {return;}
            const commandStr = `ansible-creator ${node.commandPath.join(' ')}`;
            const prompt = `Help me use the "${commandStr}" command to scaffold new Ansible content.

${node.schema?.description ? `This command: ${node.schema.description}` : ''}

Please:
1. Explain what this command creates and the resulting directory structure
2. Walk me through the required and optional parameters
3. Suggest best practices for the values I should provide
4. After I provide the details, help me run the command`;
            
            await vscode.env.clipboard.writeText(prompt);
            vscode.window.showInformationMessage(
                'AI prompt copied to clipboard. Paste it into an agent chat session.',
                'Open Chat'
            ).then(selection => {
                if (selection === 'Open Chat') {
                    vscode.commands.executeCommand('workbench.action.chat.open');
                }
            });
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

    // Register Playbooks commands
    const playbooksRefreshCommand = vscode.commands.registerCommand(
        'ansiblePlaybooks.refresh',
        () => {
            playbooksProvider.refresh();
        }
    );

    const playbooksEditConfigCommand = vscode.commands.registerCommand(
        'ansiblePlaybooks.editConfig',
        (node: { playbook: PlaybookInfo }) => {
            if (node && node.playbook) {
                PlaybookConfigPanel.show(context.extensionUri, node.playbook);
            }
        }
    );

    const playbooksEditDefaultsCommand = vscode.commands.registerCommand(
        'ansiblePlaybooks.editDefaults',
        () => {
            PlaybookConfigPanel.show(context.extensionUri);
        }
    );

    const playbooksRunCommand = vscode.commands.registerCommand(
        'ansiblePlaybooks.run',
        async (node: { playbook: PlaybookInfo }) => {
            if (node && node.playbook) {
                const service = PlaybooksService.getInstance();
                const config = service.getPlaybookConfig(node.playbook.relativePath);
                const command = service.buildCommand(node.playbook.relativePath, config);

                log(`Running playbook: ${command}`);

                // Try to use Python environment terminal
                const pythonEnvExtension = vscode.extensions.getExtension<PythonEnvironmentApi>('ms-python.vscode-python-envs');
                
                if (pythonEnvExtension) {
                    if (!pythonEnvExtension.isActive) {
                        await pythonEnvExtension.activate();
                    }
                    
                    const api = pythonEnvExtension.exports;
                    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
                    const environment = await api.getEnvironment(workspaceFolder);

                    if (environment) {
                        const terminal = await api.createTerminal(environment, {
                            name: `ansible-playbook: ${node.playbook.name}`,
                            cwd: workspaceFolder,
                        });
                        terminal.show();
                        terminal.sendText(command);
                        return;
                    }
                }

                // Fallback to regular terminal
                const terminal = vscode.window.createTerminal({
                    name: `ansible-playbook: ${node.playbook.name}`,
                    cwd: vscode.workspace.workspaceFolders?.[0]?.uri,
                });
                terminal.show();
                terminal.sendText(command);
            }
        }
    );

    const playbooksOpenCommand = vscode.commands.registerCommand(
        'ansiblePlaybooks.openPlaybook',
        async (arg: PlaybookInfo | { playbook: PlaybookInfo }) => {
            // Handle both direct PlaybookInfo and node wrapper from context menu
            const playbook = (arg as { playbook: PlaybookInfo }).playbook || arg as PlaybookInfo;
            if (playbook && playbook.path) {
                const doc = await vscode.workspace.openTextDocument(playbook.path);
                await vscode.window.showTextDocument(doc);
            }
        }
    );

    const playbooksGoToPlayCommand = vscode.commands.registerCommand(
        'ansiblePlaybooks.goToPlay',
        async (playbook: PlaybookInfo, play: PlaybookPlay) => {
            if (playbook && play) {
                const doc = await vscode.workspace.openTextDocument(playbook.path);
                const editor = await vscode.window.showTextDocument(doc);
                const line = play.lineNumber - 1;
                const position = new vscode.Position(line, 0);
                editor.selection = new vscode.Selection(position, position);
                editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
            }
        }
    );

    const playbooksAiSummaryCommand = vscode.commands.registerCommand(
        'ansiblePlaybooks.aiSummary',
        async (node: { playbook: PlaybookInfo }) => {
            if (node && node.playbook) {
                const service = PlaybooksService.getInstance();
                const prompt = service.generateAiPrompt(node.playbook);
                
                await vscode.env.clipboard.writeText(prompt);
                vscode.window.showInformationMessage(
                    'AI prompt copied to clipboard. Paste it into an agent chat session.',
                    'Open Chat'
                ).then(selection => {
                    if (selection === 'Open Chat') {
                        vscode.commands.executeCommand('workbench.action.chat.open');
                    }
                });
            }
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
                vscode.window.showInformationMessage(
                    'AI prompt copied to clipboard. Paste it into an agent chat session.',
                    'Open Chat'
                ).then(selection => {
                    if (selection === 'Open Chat') {
                        vscode.commands.executeCommand('workbench.action.chat.open');
                    }
                });
            }
        }
    );

    const mcpToolsConfigureCommand = vscode.commands.registerCommand(
        'ansibleMcpTools.configure',
        async () => {
            await configureCursorMcp(context);
            updateMcpStatusContext();
            mcpToolsProvider.refresh();
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
                    
                    // Run installation with progress indicator
                    vscode.window.withProgress(
                        {
                            location: vscode.ProgressLocation.Notification,
                            title: `Installing ${collectionName}`,
                            cancellable: false
                        },
                        async (progress) => {
                            progress.report({ message: 'Running ade install...' });
                            
                            try {
                                const output = await collectionsService.installCollection(collectionName);
                                vscode.window.showInformationMessage(`Successfully installed ${collectionName}`);
                                log(`Collection install output: ${output}`);
                                
                                // Refresh the collections view
                                collectionsProvider.refresh();
                            } catch (error) {
                                vscode.window.showErrorMessage(`Failed to install collection: ${error}`);
                            }
                        }
                    );
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
        collectionsSearchCommand,
        collectionsInstallCommand,
        collectionsAiSummaryCommand,
        collectionsAiCollectionSummaryCommand,
        collectionsAiPluginSummaryCommand,
        showPluginDocCommand,
        eeRefreshCommand,
        eeAiSummaryCommand,
        eeAiEESummaryCommand,
        galaxyCacheRefreshCommand,
        creatorRefreshCommand,
        creatorOpenFormCommand,
        creatorAiSummaryCommand,
        creatorAiEntrySummaryCommand,
        playbooksRefreshCommand,
        playbooksEditConfigCommand,
        playbooksEditDefaultsCommand,
        playbooksRunCommand,
        playbooksOpenCommand,
        playbooksGoToPlayCommand,
        playbooksAiSummaryCommand,
        configureCursorMcpCommand,
        showMcpStatusCommand,
        mcpToolsRefreshCommand,
        mcpToolsUseInChatCommand,
        mcpToolsCopyPromptCommand,
        mcpToolsConfigureCommand
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
