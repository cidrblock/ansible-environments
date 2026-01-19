import * as cp from 'child_process';

// Conditional vscode import - only used when available
let vscode: typeof import('vscode') | undefined;
try {
    vscode = require('vscode');
} catch {
    // Running standalone (not in VS Code)
}

import { PythonEnvironmentApi } from '../types/pythonEnvApi';
import { findExecutableWithCache } from './EnvironmentCache';

// TerminalService is only available in VS Code context - lazy load to avoid
// breaking the MCP server which runs standalone
let TerminalService: typeof import('./TerminalService').TerminalService | undefined;
if (vscode) {
    try {
        TerminalService = require('./TerminalService').TerminalService;
    } catch {
        // Running standalone
    }
}

/**
 * Schema for a command parameter
 */
export interface ParameterSchema {
    type: string;
    description: string;
    default?: unknown;
    enum?: string[];
    aliases?: string[];
}

/**
 * Schema node representing a command or subcommand
 */
export interface SchemaNode {
    name: string;
    description?: string;
    parameters?: {
        type: string;
        properties: Record<string, ParameterSchema>;
        required: string[];
    };
    subcommands?: Record<string, SchemaNode>;
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
 * Find an executable - uses cached environment first, then PATH
 */
async function findExecutable(name: string): Promise<string | null> {
    return findExecutableWithCache(name);
}

/**
 * Service for managing Ansible Creator functionality.
 * This service works both in VS Code and standalone (for MCP server).
 */
export class CreatorService {
    private static _instance: CreatorService | undefined;
    private _pythonEnvApi: PythonEnvironmentApi | undefined;
    private _schema: SchemaNode | null = null;
    private _loading: boolean = false;
    private _loaded: boolean = false;
    private _onDidChange: SimpleEventEmitter<void> | { fire: () => void; event: unknown };
    public readonly onDidChange: unknown;
    private _logFn: (message: string) => void = console.error;

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

    public static getInstance(): CreatorService {
        if (!CreatorService._instance) {
            CreatorService._instance = new CreatorService();
        }
        return CreatorService._instance;
    }

    /**
     * Check if running in VS Code
     */
    public isInVSCode(): boolean {
        return vscode !== undefined;
    }

    /**
     * Set a custom logging function
     */
    public setLogFunction(fn: (message: string) => void): void {
        this._logFn = fn;
    }

    private _log(message: string): void {
        this._logFn(`CreatorService: ${message}`);
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
            this._log(`Failed to get Python Environments API: ${error}`);
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
     * Get the loaded schema
     */
    public getSchema(): SchemaNode | null {
        return this._schema;
    }

    /**
     * Refresh the schema
     */
    public async refresh(): Promise<void> {
        this._schema = null;
        this._loaded = false;
        (this._onDidChange as { fire: () => void }).fire();
        await this.loadSchema();
    }

    /**
     * Load the ansible-creator schema
     */
    public async loadSchema(): Promise<SchemaNode | null> {
        if (this._loading) {
            return this._schema;
        }

        if (this._loaded && this._schema) {
            return this._schema;
        }

        this._loading = true;
        (this._onDidChange as { fire: () => void }).fire();

        try {
            let output: string | null;

            if (vscode && this._pythonEnvApi) {
                // VS Code mode - use Python environment
                await this.initialize();
                const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
                const environment = await this._pythonEnvApi!.getEnvironment(workspaceFolder);

                if (!environment) {
                    this._log('No Python environment selected');
                    return null;
                }

                const executable = environment.execInfo?.run?.executable;
                if (!executable) {
                    this._log('No Python executable found');
                    return null;
                }

                output = await this._runCommand(`"${executable}" -m ansible_creator schema`);
            } else {
                // Standalone mode - find ansible-creator in PATH
                const creatorPath = await findExecutable('ansible-creator');
                if (!creatorPath) {
                    this._log('ansible-creator not found in PATH');
                    return null;
                }

                output = await this._runCommand(`"${creatorPath}" schema`);
            }

            if (output) {
                this._schema = JSON.parse(output);
                this._loaded = true;
                this._log('Schema loaded successfully');
            }

            return this._schema;
        } catch (error) {
            this._log(`Error loading schema: ${error}`);
            throw error;
        } finally {
            this._loading = false;
            (this._onDidChange as { fire: () => void }).fire();
        }
    }

    /**
     * Get available commands at a given path
     */
    public getCommands(path: string[] = []): Array<{ name: string; description?: string; hasSubcommands: boolean }> {
        if (!this._schema) {
            return [];
        }

        let node: SchemaNode | undefined = this._schema;

        // Navigate to the path
        for (const segment of path) {
            if (!node.subcommands?.[segment]) {
                return [];
            }
            node = node.subcommands[segment];
        }

        if (!node.subcommands) {
            return [];
        }

        return Object.entries(node.subcommands).map(([name, schema]) => ({
            name,
            description: schema.description,
            hasSubcommands: !!(schema.subcommands && Object.keys(schema.subcommands).length > 0)
        }));
    }

    /**
     * Get command parameters for a given command path
     */
    public getCommandParameters(path: string[]): { required: string[]; optional: string[]; properties: Record<string, ParameterSchema> } | null {
        if (!this._schema || path.length === 0) {
            return null;
        }

        let node: SchemaNode | undefined = this._schema;

        // Navigate to the command
        for (const segment of path) {
            if (!node.subcommands?.[segment]) {
                return null;
            }
            node = node.subcommands[segment];
        }

        if (!node.parameters) {
            return null;
        }

        const required = node.parameters.required || [];
        const properties = node.parameters.properties || {};
        const optional = Object.keys(properties).filter(key => !required.includes(key));

        return { required, optional, properties };
    }

    /**
     * Get command description for a given path
     */
    public getCommandDescription(path: string[]): string | undefined {
        if (!this._schema || path.length === 0) {
            return undefined;
        }

        let node: SchemaNode | undefined = this._schema;

        for (const segment of path) {
            if (!node.subcommands?.[segment]) {
                return undefined;
            }
            node = node.subcommands[segment];
        }

        return node.description;
    }

    /**
     * Run an ansible-creator command
     * In VS Code: opens a terminal
     * Standalone: executes via child_process and returns output
     */
    public async runCommand(path: string[], args: Record<string, string | boolean>): Promise<string | void> {
        // Build the command
        const commandParts = ['ansible-creator', ...path];

        for (const [key, value] of Object.entries(args)) {
            if (value === true) {
                commandParts.push(`--${key}`);
            } else if (value !== false && value !== '') {
                commandParts.push(`--${key}`, String(value));
            }
        }

        const command = commandParts.join(' ');

        if (vscode && TerminalService) {
            // VS Code mode - use TerminalService for proper venv handling
            const terminalService = TerminalService.getInstance();
            const managed = await terminalService.createActivatedTerminal({
                name: `ansible-creator ${path.join(' ')}`,
                show: true,
            });
            managed.sendCommand(command, { waitForCompletion: false });
        } else {
            // Standalone mode - execute directly
            const output = await this._runCommand(command);
            return output || undefined;
        }
    }

    /**
     * Build the command string for a creator command (useful for MCP)
     */
    public buildCommandString(path: string[], args: Record<string, string | boolean>): string {
        const commandParts = ['ansible-creator', ...path];

        for (const [key, value] of Object.entries(args)) {
            if (value === true) {
                commandParts.push(`--${key}`);
            } else if (value !== false && value !== '') {
                commandParts.push(`--${key}`, String(value));
            }
        }

        return commandParts.join(' ');
    }

    private _runCommand(command: string): Promise<string | null> {
        return new Promise((resolve) => {
            const cwd = vscode?.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();

            cp.exec(command, { cwd, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
                if (error) {
                    this._log(`Command error: ${error.message}`);
                    resolve(null);
                    return;
                }
                resolve(stdout.trim());
            });
        });
    }
}
