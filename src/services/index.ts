/**
 * Service layer exports
 * 
 * These services contain the core business logic for the Ansible Environments extension.
 * They are designed to be independent of VS Code UI components and can be used by:
 * - TreeView providers (for UI rendering)
 * - Commands (for user actions)
 * - MCP tools (for AI/automation integration)
 */

export { CollectionsService } from './CollectionsService';
export type { 
    CollectionInfo, 
    PluginInfo, 
    CollectionData, 
    PluginOption, 
    PluginDoc, 
    PluginReturn, 
    PluginData 
} from './CollectionsService';

export { DevToolsService } from './DevToolsService';
export type { DevToolPackage } from './DevToolsService';

export { ExecutionEnvService } from './ExecutionEnvService';
export type { ExecutionEnvironment, EEDetails } from './ExecutionEnvService';

export { CreatorService } from './CreatorService';
export type { ParameterSchema, SchemaNode } from './CreatorService';

export { GalaxyCollectionCache } from './GalaxyCollectionCache';
export type { GalaxyCollection } from './GalaxyCollectionCache';

export { TerminalService } from './TerminalService';
export type { CommandResult, ManagedTerminal, SendCommandOptions, CreateTerminalOptions } from './TerminalService';
