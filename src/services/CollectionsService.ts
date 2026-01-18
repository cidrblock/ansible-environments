import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// Conditional vscode import - only used when available
let vscode: typeof import('vscode') | undefined;
let extensionLog: ((message: string) => void) | undefined;
try {
    vscode = require('vscode');
} catch {
    // Running standalone (not in VS Code)
}

/**
 * Set the log function for the service (called from extension.ts)
 */
export function setLogFunction(logFn: (message: string) => void): void {
    extensionLog = logFn;
    logFn('CollectionsService: Log function initialized');
}

// Cache configuration
const CACHE_DIR = '.cache/ansible-environments';
const COLLECTIONS_CACHE_FILE = 'collections-metadata.json';

interface CollectionsCache {
    timestamp: string;
    collections: Array<{
        name: string;
        info: CollectionInfo;
        pluginTypes: Array<{
            type: string;
            plugins: PluginInfo[];
        }>;
    }>;
}

import { PythonEnvironmentApi, PythonEnvironment } from '../types/pythonEnvApi';
import { findExecutableWithCache } from './EnvironmentCache';

/**
 * Information about an Ansible collection
 */
export interface CollectionInfo {
    name: string;
    version: string;
    authors: string[];
    description: string;
    path?: string;
}

/**
 * Information about a plugin within a collection
 */
export interface PluginInfo {
    name: string;
    fullName: string;
    shortDescription: string;
}

/**
 * A collection with its plugins organized by type
 */
export interface CollectionData {
    info: CollectionInfo;
    pluginTypes: Map<string, PluginInfo[]>;
}

/**
 * Plugin documentation option
 */
export interface PluginOption {
    description?: string | string[];
    type?: string;
    default?: unknown;
    choices?: string[];
    required?: boolean;
    elements?: string;
    aliases?: string[];
    suboptions?: { [key: string]: PluginOption };
    version_added?: string;
}

/**
 * Plugin documentation structure
 */
export interface PluginDoc {
    author?: string | string[];
    collection?: string;
    description?: string | string[];
    short_description?: string;
    module?: string;
    plugin_name?: string;
    version_added?: string;
    notes?: string | string[];
    options?: { [key: string]: PluginOption };
    seealso?: Array<{ module?: string; description?: string; link?: string; name?: string }>;
    requirements?: string | string[];
    attributes?: { [key: string]: unknown };
}

/**
 * Plugin return value documentation
 */
export interface PluginReturn {
    [key: string]: {
        description?: string | string[];
        returned?: string;
        type?: string;
        sample?: unknown;
        contains?: { [key: string]: unknown };
    };
}

/**
 * Complete plugin data including documentation, examples, and return values
 */
export interface PluginData {
    doc?: PluginDoc;
    examples?: string;
    return?: PluginReturn;
    metadata?: unknown;
}

// Internal types for parsing
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
    path?: string;
    collection_info: {
        version: string;
        authors: string[];
        description: string;
    };
}

interface AdeInspectOutput {
    [collectionName: string]: AdeCollectionInfo;
}

// Simple EventEmitter for standalone mode
class SimpleEventEmitter<T> {
    private listeners: Array<(e: T) => void> = [];
    
    public event = (listener: (e: T) => void) => {
        this.listeners.push(listener);
        return { dispose: () => {
            const idx = this.listeners.indexOf(listener);
            if (idx >= 0) this.listeners.splice(idx, 1);
        }};
    };
    
    public fire(e: T): void {
        this.listeners.forEach(l => l(e));
    }
}

/**
 * Execute a command and return stdout
 * Note: We return stdout even if there's an error, as ansible-doc often
 * returns non-zero exit codes while still producing valid output
 */
function execCommand(command: string, options?: { maxBuffer?: number; cwd?: string }): Promise<string> {
    return new Promise((resolve, reject) => {
        cp.exec(command, {
            maxBuffer: options?.maxBuffer || 10 * 1024 * 1024,
            cwd: options?.cwd,
        }, (error, stdout, stderr) => {
            // If we have stdout, return it even if there was an error
            // (ansible-doc often exits non-zero but produces valid JSON)
            if (stdout && stdout.trim()) {
                resolve(stdout);
                return;
            }
            if (error) {
                reject(new Error(`Command failed: ${error.message}\nStderr: ${stderr}`));
                return;
            }
            resolve(stdout);
        });
    });
}

/**
 * Find an executable - uses cached environment first, then PATH
 */
async function findExecutable(name: string): Promise<string | null> {
    return findExecutableWithCache(name);
}

/**
 * Get the workspace root directory
 */
function getWorkspaceRoot(): string | null {
    if (vscode?.workspace?.workspaceFolders?.[0]) {
        const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
        console.log(`CollectionsService: Workspace root: ${root}`);
        return root;
    }
    const cwd = process.cwd();
    console.log(`CollectionsService: Using cwd as workspace root: ${cwd}`);
    return cwd;
}

/**
 * Get the collections cache file path
 */
function getCollectionsCachePath(): string | null {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
        return null;
    }
    return path.join(workspaceRoot, CACHE_DIR, COLLECTIONS_CACHE_FILE);
}

/**
 * Ensure the cache directory exists
 */
function ensureCacheDir(): boolean {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
        return false;
    }
    
    const cacheDir = path.join(workspaceRoot, CACHE_DIR);
    try {
        if (!fs.existsSync(cacheDir)) {
            fs.mkdirSync(cacheDir, { recursive: true });
        }
        return true;
    } catch {
        return false;
    }
}

/**
 * Read the collections cache
 */
function readCollectionsCache(): CollectionsCache | null {
    const cachePath = getCollectionsCachePath();
    if (!cachePath) {
        logMessage('No cache path available (no workspace?)');
        return null;
    }
    
    try {
        if (fs.existsSync(cachePath)) {
            const content = fs.readFileSync(cachePath, 'utf8');
            const cache = JSON.parse(content) as CollectionsCache;
            const ageMs = Date.now() - new Date(cache.timestamp).getTime();
            const ageStr = ageMs < 60000 ? 'just now' : 
                          ageMs < 3600000 ? `${Math.round(ageMs/60000)} min ago` :
                          `${Math.round(ageMs/3600000)} hour(s) ago`;
            logMessage(`Cache loaded: ${cache.collections?.length || 0} collections (${ageStr})`);
            return cache;
        } else {
            logMessage(`Cache file not found at ${cachePath}`);
        }
    } catch (error) {
        logMessage(`Failed to read cache: ${error}`);
    }
    
    return null;
}

/**
 * Log a message using the extension log if available
 */
function logMessage(message: string): void {
    const fullMessage = `CollectionsService: ${message}`;
    if (extensionLog) {
        extensionLog(fullMessage);
    } else {
        console.log(fullMessage);
    }
}

/**
 * Write the collections cache
 */
function writeCollectionsCache(collections: Map<string, CollectionData>): boolean {
    if (!ensureCacheDir()) {
        return false;
    }
    
    const cachePath = getCollectionsCachePath();
    if (!cachePath) {
        return false;
    }
    
    try {
        const cache: CollectionsCache = {
            timestamp: new Date().toISOString(),
            collections: Array.from(collections.entries()).map(([name, data]) => ({
                name,
                info: data.info,
                pluginTypes: Array.from(data.pluginTypes.entries()).map(([type, plugins]) => ({
                    type,
                    plugins
                }))
            }))
        };
        
        fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf8');
        return true;
    } catch (error) {
        console.error('Failed to write collections cache:', error);
        return false;
    }
}

/**
 * Convert cached data back to Map structure
 */
function cacheToCollectionsMap(cache: CollectionsCache): Map<string, CollectionData> {
    const collections = new Map<string, CollectionData>();
    
    for (const item of cache.collections) {
        const pluginTypes = new Map<string, PluginInfo[]>();
        for (const pt of item.pluginTypes) {
            pluginTypes.set(pt.type, pt.plugins);
        }
        collections.set(item.name, {
            info: item.info,
            pluginTypes
        });
    }
    
    return collections;
}

/**
 * Service for managing Ansible collections and plugin documentation.
 * This service works both in VS Code and standalone (for MCP server).
 */
export class CollectionsService {
    private static _instance: CollectionsService | undefined;
    private _pythonEnvApi: PythonEnvironmentApi | undefined;
    private _collections: Map<string, CollectionData> = new Map();
    private _loading: boolean = false;
    private _loaded: boolean = false;
    private _backgroundRefreshing: boolean = false;
    private _onDidChange: SimpleEventEmitter<void> | { fire: () => void; event: unknown };
    public readonly onDidChange: unknown;

    private constructor() {
        // Use VS Code EventEmitter if available, otherwise use simple implementation
        if (vscode) {
            const emitter = new vscode.EventEmitter<void>();
            this._onDidChange = emitter;
            this.onDidChange = emitter.event;
        } else {
            const emitter = new SimpleEventEmitter<void>();
            this._onDidChange = emitter;
            this.onDidChange = emitter.event;
        }
    }

    public static getInstance(): CollectionsService {
        if (!CollectionsService._instance) {
            CollectionsService._instance = new CollectionsService();
        }
        return CollectionsService._instance;
    }

    /**
     * Check if running in VS Code
     */
    public isInVSCode(): boolean {
        return vscode !== undefined;
    }

    /**
     * Initialize the service with the Python Environment API (VS Code only)
     */
    public async initialize(): Promise<void> {
        if (this._pythonEnvApi || !vscode) {
            return;
        }

        try {
            const pythonEnvExtension = vscode.extensions.getExtension<PythonEnvironmentApi>('ms-python.vscode-python-envs');
            if (pythonEnvExtension) {
                if (!pythonEnvExtension.isActive) {
                    await pythonEnvExtension.activate();
                }
                this._pythonEnvApi = pythonEnvExtension.exports;
            }
        } catch (error) {
            console.error('CollectionsService: Failed to get Python Environments API:', error);
        }
    }

    /**
     * Check if the service is currently loading data
     */
    public isLoading(): boolean {
        return this._loading;
    }

    /**
     * Check if the service has loaded data
     */
    public isLoaded(): boolean {
        return this._loaded;
    }

    /**
     * Get all loaded collections
     */
    public getCollections(): Map<string, CollectionData> {
        return this._collections;
    }

    /**
     * Get a specific collection by name
     */
    public getCollection(name: string): CollectionData | undefined {
        return this._collections.get(name);
    }

    /**
     * List all collection names
     */
    public listCollectionNames(): string[] {
        return Array.from(this._collections.keys()).sort();
    }

    /**
     * Get plugins for a specific collection and type
     */
    public getPlugins(collectionName: string, pluginType: string): PluginInfo[] {
        const collection = this._collections.get(collectionName);
        if (!collection) {
            return [];
        }
        return collection.pluginTypes.get(pluginType) || [];
    }

    /**
     * List all plugin types for a collection
     */
    public listPluginTypes(collectionName: string): string[] {
        const collection = this._collections.get(collectionName);
        if (!collection) {
            return [];
        }
        return Array.from(collection.pluginTypes.keys()).sort();
    }

    /**
     * Search for plugins across all collections
     */
    public searchPlugins(query: string): Array<{ collection: string; pluginType: string; plugin: PluginInfo }> {
        const results: Array<{ collection: string; pluginType: string; plugin: PluginInfo }> = [];
        const lowerQuery = query.toLowerCase();

        for (const [collectionName, collection] of this._collections) {
            for (const [pluginType, plugins] of collection.pluginTypes) {
                for (const plugin of plugins) {
                    if (
                        plugin.name.toLowerCase().includes(lowerQuery) ||
                        plugin.fullName.toLowerCase().includes(lowerQuery) ||
                        plugin.shortDescription.toLowerCase().includes(lowerQuery)
                    ) {
                        results.push({ collection: collectionName, pluginType, plugin });
                    }
                }
            }
        }

        return results;
    }

    private _log(message: string): void {
        logMessage(message);
    }

    /**
     * Refresh the collections data
     * - If cache exists, load from cache immediately and refresh in background
     * - If no cache, show loading state while fetching
     * - Never blanks the view - keeps existing data visible during refresh
     */
    public async refresh(): Promise<void> {
        if (this._loading) {
            this._log('Refresh skipped - already loading');
            return;
        }

        this._log('Starting refresh');

        // Try to load from cache first for instant UI
        const cache = readCollectionsCache();
        if (cache) {
            this._log(`Cache found with ${cache.collections.length} collections from ${cache.timestamp}`);
            this._collections = cacheToCollectionsMap(cache);
            this._loaded = true;
            (this._onDidChange as { fire: () => void }).fire();
            
            // Background refresh to update cache (don't await)
            this._backgroundRefresh();
            return;
        }

        this._log('No cache found, doing full load');
        
        // No cache - do full load with loading state
        this._loading = true;
        (this._onDidChange as { fire: () => void }).fire();

        try {
            await this._doFullLoad();
            this._loaded = true;
            
            // Save to cache
            writeCollectionsCache(this._collections);
            this._log(`Full load complete, ${this._collections.size} collections cached`);
        } catch (error) {
            this._log(`Full load failed: ${error}`);
        } finally {
            this._loading = false;
            (this._onDidChange as { fire: () => void }).fire();
        }
    }
    
    /**
     * Perform a full load of collections
     */
    private async _doFullLoad(): Promise<void> {
        // Clear and load fresh
        this._collections.clear();
        
        if (vscode) {
            await this.initialize();
        }
        
        if (vscode && this._pythonEnvApi) {
            await this._loadCollectionsVSCode();
        } else {
            await this._loadCollectionsStandalone();
        }
    }
    
    /**
     * Background refresh - updates cache and view if data changed
     * Keeps existing data visible while refreshing
     */
    private async _backgroundRefresh(): Promise<void> {
        // Prevent multiple concurrent background refreshes
        if (this._backgroundRefreshing) {
            this._log('Background refresh already in progress, skipping');
            return;
        }
        this._backgroundRefreshing = true;
        this._log('Starting background refresh');
        
        // Show status bar message if in VS Code
        let statusDisposable: { dispose: () => void } | undefined;
        if (vscode) {
            statusDisposable = vscode.window.setStatusBarMessage('$(sync~spin) Updating collections index...');
        }
        
        try {
            // Load into a temporary map WITHOUT touching this._collections
            const tempCollections = new Map<string, CollectionData>();
            const oldCount = this._collections.size;
            
            if (vscode) {
                await this.initialize();
            }
            
            // Load directly into temp map (this._collections is untouched)
            if (vscode && this._pythonEnvApi) {
                await this._loadCollectionsVSCode(tempCollections);
            } else {
                await this._loadCollectionsStandalone(tempCollections);
            }
            
            // Now swap atomically after load is complete
            const newCount = tempCollections.size;
            this._collections = tempCollections;
            
            this._log(`Background refresh complete: ${oldCount} -> ${newCount} collections`);
            
            // Always update cache with fresh data
            writeCollectionsCache(this._collections);
            
            // Only update UI if data changed
            if (oldCount !== newCount) {
                this._log('Data changed, updating UI');
                (this._onDidChange as { fire: () => void }).fire();
                if (vscode) {
                    vscode.window.setStatusBarMessage(`$(check) Collections updated (${newCount} collections)`, 3000);
                }
            } else {
                this._log('No data change, UI unchanged');
                if (vscode) {
                    vscode.window.setStatusBarMessage(`$(check) Collections index up to date`, 2000);
                }
            }
        } catch (error) {
            this._log(`Background refresh failed: ${error}`);
            if (vscode) {
                vscode.window.setStatusBarMessage(`$(error) Collections refresh failed`, 3000);
            }
            // Don't clear collections on error - keep existing data
        } finally {
            this._backgroundRefreshing = false;
            statusDisposable?.dispose();
        }
    }

    /**
     * Get detailed documentation for a specific plugin
     */
    public async getPluginDocumentation(pluginFullName: string, pluginType: string): Promise<PluginData | null> {
        const typeFlag = this._getTypeFlag(pluginType);
        let ansibleDocPath: string;

        if (vscode && this._pythonEnvApi) {
            // VS Code mode - use Python environment
            await this.initialize();
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
            const environment = await this._pythonEnvApi.getEnvironment(workspaceFolder);

            if (!environment) {
                throw new Error('No Python environment selected');
            }

            const executable = environment.execInfo?.run?.executable;
            if (!executable) {
                throw new Error('Could not find Python executable');
            }

            ansibleDocPath = path.join(path.dirname(executable), 'ansible-doc');
        } else {
            // Standalone mode - find in PATH
            const found = await findExecutable('ansible-doc');
            if (!found) {
                throw new Error('ansible-doc not found in PATH');
            }
            ansibleDocPath = found;
        }

        try {
            const result = await execCommand(
                `ANSIBLE_NOCOLOR=1 "${ansibleDocPath}" ${typeFlag} "${pluginFullName}" --json 2>/dev/null`,
                { maxBuffer: 10 * 1024 * 1024 }
            );

            // Find the start of JSON (ansible-doc might output warnings before the JSON)
            const jsonStart = result.indexOf('{');
            if (jsonStart === -1) {
                console.error(`No JSON found in ansible-doc output for ${pluginFullName}`);
                return null;
            }
            
            const jsonStr = result.substring(jsonStart);
            const data = JSON.parse(jsonStr);
            return data[pluginFullName] as PluginData || null;
        } catch (error) {
            console.error(`Failed to get plugin documentation: ${error}`);
            return null;
        }
    }

    /**
     * Install a collection using ade install
     * Runs as a background process and returns output when complete
     */
    public async installCollection(collectionName: string): Promise<string> {
        // Initialize first to get the Python environment API
        await this.initialize();
        
        let adePath: string;
        let cwd: string | undefined;
        
        if (vscode && this._pythonEnvApi) {
            // VS Code mode - get ade from the venv
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
            const environment = await this._pythonEnvApi.getEnvironment(workspaceFolder);

            if (!environment) {
                throw new Error('No Python environment selected');
            }

            const executable = environment.execInfo?.run?.executable;
            if (!executable) {
                throw new Error('Could not find Python executable');
            }

            const envBinDir = path.dirname(executable);
            adePath = path.join(envBinDir, 'ade');
            cwd = workspaceFolder?.fsPath;
        } else {
            // Standalone mode - find ade in PATH
            const found = await findExecutable('ade');
            if (!found) {
                throw new Error('ade not found. Install ansible-dev-tools first.');
            }
            adePath = found;
        }

        // Run ade install as a background process
        try {
            const output = await execCommand(
                `"${adePath}" install ${collectionName}`,
                { maxBuffer: 10 * 1024 * 1024, cwd }
            );
            return output || `Successfully installed ${collectionName}`;
        } catch (error) {
            throw new Error(`Failed to install ${collectionName}: ${error}`);
        }
    }

    private _getTypeFlag(pluginType: string): string {
        const typeMap: { [key: string]: string } = {
            'module': '-t module',
            'become': '-t become',
            'cache': '-t cache',
            'callback': '-t callback',
            'cliconf': '-t cliconf',
            'connection': '-t connection',
            'filter': '-t filter',
            'httpapi': '-t httpapi',
            'inventory': '-t inventory',
            'lookup': '-t lookup',
            'netconf': '-t netconf',
            'shell': '-t shell',
            'strategy': '-t strategy',
            'test': '-t test',
            'vars': '-t vars',
            'role': '-t role',
            'keyword': '-t keyword'
        };
        return typeMap[pluginType] || '';
    }

    /**
     * Load collections in VS Code mode (uses Python Envs API)
     * @param targetMap - Optional map to load into (for background refresh)
     */
    private async _loadCollectionsVSCode(targetMap?: Map<string, CollectionData>): Promise<void> {
        await this.initialize();

        if (!this._pythonEnvApi || !vscode) {
            return;
        }

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
        const envPath = path.dirname(envBinDir);
        const ansibleDocPath = path.join(envBinDir, 'ansible-doc');
        const adePath = path.join(envBinDir, 'ade');

        await this._loadCollectionsWithPaths(ansibleDocPath, adePath, envPath, targetMap);
    }

    /**
     * Load collections in standalone mode (finds tools in PATH)
     * @param targetMap - Optional map to load into (for background refresh)
     */
    private async _loadCollectionsStandalone(targetMap?: Map<string, CollectionData>): Promise<void> {
        const ansibleDocPath = await findExecutable('ansible-doc');
        if (!ansibleDocPath) {
            console.error('ansible-doc not found in PATH');
            return;
        }

        const adePath = await findExecutable('ade');
        // ade is optional for basic functionality

        await this._loadCollectionsWithPaths(ansibleDocPath, adePath || undefined, undefined, targetMap);
    }

    /**
     * Common collection loading logic
     * @param targetMap - Optional map to load into (defaults to this._collections)
     */
    private async _loadCollectionsWithPaths(
        ansibleDocPath: string, 
        adePath?: string, 
        envPath?: string,
        targetMap?: Map<string, CollectionData>
    ): Promise<void> {
        const collections = targetMap ?? this._collections;
        try {
            // Run ade inspect and ansible-doc in parallel for speed
            const adePromise = adePath ? (async () => {
                try {
                    const adeCmd = envPath 
                        ? `"${adePath}" inspect --venv "${envPath}" --no-ansi`
                        : `"${adePath}" inspect --no-ansi`;
                    
                    const adeResult = await execCommand(adeCmd, { maxBuffer: 10 * 1024 * 1024 });
                    return JSON.parse(adeResult) as AdeInspectOutput;
                } catch (error) {
                    console.error('CollectionsService: ade inspect not available, collection metadata will be limited');
                    return null;
                }
            })() : Promise.resolve(null);

            // Set ANSIBLE_COLLECTIONS_PATH=. to isolate to workspace
            // ansible-doc still finds venv site-packages collections via Python's sys.path
            // This prevents picking up stray collections from ~/.ansible/collections
            const ansibleDocPromise = execCommand(
                `ANSIBLE_COLLECTIONS_PATH=. ANSIBLE_WARNINGS=false ANSIBLE_NOCOLOR=1 "${ansibleDocPath}" --metadata-dump --no-fail-on-errors 2>/dev/null`,
                { maxBuffer: 50 * 1024 * 1024 }
            );

            // Wait for both to complete
            const [adeData, result] = await Promise.all([adePromise, ansibleDocPromise]);

            // Build collection info map from ade data
            const collectionInfoMap = new Map<string, CollectionInfo>();
            if (adeData) {
                for (const [collName, collData] of Object.entries(adeData)) {
                    if (collData.collection_info) {
                        collectionInfoMap.set(collName, {
                            name: collName,
                            version: collData.collection_info.version || '',
                            authors: collData.collection_info.authors || [],
                            description: collData.collection_info.description || '',
                            path: collData.path
                        });
                    }
                }
            }

            // Find the start of JSON (ansible-doc might output warnings before the JSON)
            let jsonStart = result.indexOf('{');
            if (jsonStart === -1) {
                console.error('CollectionsService: No JSON found in ansible-doc output');
                console.error('Output starts with:', result.substring(0, 100));
                return;
            }
            
            const jsonStr = result.substring(jsonStart);

            // Parse the JSON output
            let metadata: MetadataDump;
            try {
                metadata = JSON.parse(jsonStr);
            } catch (parseError) {
                console.error('CollectionsService: Failed to parse ansible-doc JSON');
                console.error('JSON starts with:', jsonStr.substring(0, 200));
                throw parseError;
            }

            if (!metadata.all) {
                return;
            }

            // Use a Set to track unique plugins globally
            const seenPlugins = new Set<string>();

            // Process each plugin type
            for (const [pluginType, plugins] of Object.entries(metadata.all)) {
                for (const [fullName, pluginData] of Object.entries(plugins)) {
                    const doc = pluginData.doc;
                    if (!doc) { continue; }

                    const collectionName = doc.collection || 'unknown';
                    const pluginName = doc.plugin_name?.split('.').pop() || fullName.split('.').pop() || fullName;
                    const shortDescription = doc.short_description || '';

                    // Create unique key to prevent duplicates
                    const uniqueKey = `${collectionName}:${pluginType}:${fullName}`;
                    if (seenPlugins.has(uniqueKey)) {
                        continue;
                    }
                    seenPlugins.add(uniqueKey);

                    // Get or create collection
                    if (!collections.has(collectionName)) {
                        const info = collectionInfoMap.get(collectionName) || {
                            name: collectionName,
                            version: '',
                            authors: [],
                            description: ''
                        };
                        collections.set(collectionName, {
                            info,
                            pluginTypes: new Map()
                        });
                    }
                    const collection = collections.get(collectionName)!;

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
            for (const collection of collections.values()) {
                for (const plugins of collection.pluginTypes.values()) {
                    plugins.sort((a, b) => a.name.localeCompare(b.name));
                }
            }
        } catch (error) {
            console.error('CollectionsService: Failed to load collections:', error);
            throw error;
        }
    }
}
