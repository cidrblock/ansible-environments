/**
 * Ansible Content Designer - Agent Log Service
 * 
 * Unified logging for all agent interactions across phases.
 * Logs are written to the design/ directory for review and prompt refinement.
 */

import * as fs from 'fs';
import * as path from 'path';

export type AgentPhase = 'dependency_assessment' | 'content_assessment' | 'planning' | 'build';

export interface AgentLogEntry {
    timestamp: string;
    type: 'prompt' | 'response' | 'parsed' | 'error' | 'info' | 'debug' | 'tool_call' | 'tool_result';
    message: string;
    data?: Record<string, unknown>;
}

export interface AgentInteractionLog {
    id: string;
    phase: AgentPhase;
    started_at: string;
    completed_at?: string;
    status: 'in_progress' | 'success' | 'failed';
    model_used?: string;
    prompt_template?: string;
    prompt_rendered?: string;
    prompt_length?: number;
    response_raw?: string;
    response_length?: number;
    parsed_result?: unknown;
    entries: AgentLogEntry[];
    statistics: {
        llm_calls: number;
        tool_calls: number;
        retries: number;
        errors: number;
    };
}

export interface PhaseLog {
    phase: AgentPhase;
    started_at: string;
    completed_at?: string;
    interactions: AgentInteractionLog[];
    summary?: string;
}

/**
 * AgentLogService - Singleton for logging agent interactions
 */
export class AgentLogService {
    private static _instance: AgentLogService | undefined;
    
    private _workspaceRoot: string;
    private _currentPhase?: AgentPhase;
    private _currentInteraction?: AgentInteractionLog;
    private _phaseLogs: Map<AgentPhase, PhaseLog> = new Map();
    private _interactionCounter = 0;
    private _progressCallback?: (message: string, type: string) => void;

    private constructor(workspaceRoot: string) {
        this._workspaceRoot = workspaceRoot;
        this._ensureLogDirectory();
    }

    /**
     * Set a callback for real-time progress updates
     * This allows the UI to show live agent activity
     */
    public setProgressCallback(callback: ((message: string, type: string) => void) | undefined): void {
        this._progressCallback = callback;
    }

    public static getInstance(workspaceRoot?: string): AgentLogService {
        if (!AgentLogService._instance) {
            if (!workspaceRoot) {
                throw new Error('AgentLogService requires workspaceRoot on first initialization');
            }
            AgentLogService._instance = new AgentLogService(workspaceRoot);
        }
        return AgentLogService._instance;
    }

    public static reset(): void {
        AgentLogService._instance = undefined;
    }

    // ========================================================================
    // Phase Management
    // ========================================================================

    /**
     * Start logging a new phase
     */
    public startPhase(phase: AgentPhase): void {
        this._currentPhase = phase;
        
        if (!this._phaseLogs.has(phase)) {
            this._phaseLogs.set(phase, {
                phase,
                started_at: new Date().toISOString(),
                interactions: []
            });
        }
        
        console.log(`AgentLogService: Started phase ${phase}`);
    }

    /**
     * Complete the current phase
     */
    public completePhase(summary?: string): void {
        if (!this._currentPhase) return;
        
        const phaseLog = this._phaseLogs.get(this._currentPhase);
        if (phaseLog) {
            phaseLog.completed_at = new Date().toISOString();
            phaseLog.summary = summary;
            this._writePhaseLog(phaseLog);
        }
        
        console.log(`AgentLogService: Completed phase ${this._currentPhase}`);
        this._currentPhase = undefined;
    }

    // ========================================================================
    // Interaction Management
    // ========================================================================

    /**
     * Start a new LLM interaction within the current phase
     */
    public startInteraction(description: string): string {
        const phase = this._currentPhase || 'build';
        const id = `${phase}-${++this._interactionCounter}`;
        
        this._currentInteraction = {
            id,
            phase,
            started_at: new Date().toISOString(),
            status: 'in_progress',
            entries: [],
            statistics: {
                llm_calls: 0,
                tool_calls: 0,
                retries: 0,
                errors: 0
            }
        };
        
        this.log('info', description);
        
        // Write initial log immediately
        this._writeInteractionLog(this._currentInteraction);
        
        return id;
    }

    /**
     * Complete the current interaction
     */
    public completeInteraction(success: boolean): void {
        if (!this._currentInteraction) return;
        
        this._currentInteraction.completed_at = new Date().toISOString();
        this._currentInteraction.status = success ? 'success' : 'failed';
        
        // Add to phase log
        const phaseLog = this._phaseLogs.get(this._currentInteraction.phase);
        if (phaseLog) {
            phaseLog.interactions.push(this._currentInteraction);
        }
        
        // Write incrementally
        this._writeInteractionLog(this._currentInteraction);
        
        this._currentInteraction = undefined;
    }

    // ========================================================================
    // Logging Methods
    // ========================================================================

    /**
     * Log a prompt being sent to the LLM
     */
    public logPrompt(template: string, rendered: string, model?: string): void {
        if (!this._currentInteraction) return;
        
        this._currentInteraction.prompt_template = template;
        this._currentInteraction.prompt_rendered = rendered;
        this._currentInteraction.prompt_length = rendered.length;
        this._currentInteraction.model_used = model;
        this._currentInteraction.statistics.llm_calls++;
        
        this.log('prompt', `Sending prompt to ${model || 'LLM'}`, {
            template_name: template,
            prompt_length: rendered.length
        });
    }

    /**
     * Log a response from the LLM
     */
    public logResponse(response: string): void {
        if (!this._currentInteraction) return;
        
        this._currentInteraction.response_raw = response;
        this._currentInteraction.response_length = response.length;
        
        // Extract meaningful reasoning from the response
        const trimmed = response.trim();
        if (trimmed.length > 0) {
            // Split into sentences and show first 2-3 for context
            const sentences = trimmed.split(/(?<=[.!?])\s+/).slice(0, 3);
            const preview = sentences.join(' ');
            
            if (preview.length > 10) {
                this.log('response', preview.substring(0, 300) + (preview.length > 300 ? '...' : ''), {
                    response_length: response.length
                });
            }
        }
    }
    
    /**
     * Log agent thinking/reasoning
     */
    public logThinking(thinking: string): void {
        if (thinking.trim().length > 0) {
            this.log('info', `💭 ${thinking.substring(0, 200)}${thinking.length > 200 ? '...' : ''}`, {
                thinking_length: thinking.length
            });
        }
    }

    /**
     * Log parsed result from LLM response
     */
    public logParsed(result: unknown, description?: string): void {
        if (!this._currentInteraction) return;
        
        this._currentInteraction.parsed_result = result;
        
        this.log('parsed', description || 'Parsed LLM response', {
            result_type: typeof result,
            result_count: Array.isArray(result) ? result.length : undefined
        });
    }

    /**
     * Log a tool call
     */
    public logToolCall(toolName: string, args: Record<string, unknown>): void {
        if (this._currentInteraction) {
            this._currentInteraction.statistics.tool_calls++;
        }
        
        this.log('tool_call', `Calling tool: ${toolName}`, { args });
    }

    /**
     * Log a tool result
     */
    public logToolResult(toolName: string, success: boolean, result?: unknown): void {
        this.log('tool_result', `Tool ${toolName} ${success ? 'succeeded' : 'failed'}`, {
            success,
            result_preview: typeof result === 'string' 
                ? result.substring(0, 200) 
                : JSON.stringify(result)?.substring(0, 200)
        });
    }

    /**
     * Log an error
     */
    public logError(message: string, error?: Error | unknown): void {
        if (this._currentInteraction) {
            this._currentInteraction.statistics.errors++;
        }
        
        this.log('error', message, {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined
        });
    }

    /**
     * Log a retry attempt
     */
    public logRetry(reason: string, attempt: number): void {
        if (this._currentInteraction) {
            this._currentInteraction.statistics.retries++;
        }
        
        this.log('info', `Retry attempt ${attempt}: ${reason}`);
    }

    /**
     * Generic log entry - writes incrementally to disk
     */
    public log(type: AgentLogEntry['type'], message: string, data?: Record<string, unknown>): void {
        const entry: AgentLogEntry = {
            timestamp: new Date().toISOString(),
            type,
            message,
            data
        };
        
        if (this._currentInteraction) {
            this._currentInteraction.entries.push(entry);
            // Write incrementally so we don't lose logs on errors
            this._writeInteractionLog(this._currentInteraction);
        }
        
        // Send real-time progress to UI (skip debug type)
        if (this._progressCallback && type !== 'debug') {
            this._progressCallback(message, type);
        }
        
        // Also log to console for debugging (skip 'debug' type to reduce noise)
        if (type !== 'debug') {
            const prefix = `[AgentLog:${this._currentPhase || 'unknown'}]`;
            if (type === 'error') {
                console.error(prefix, message, data || '');
            } else {
                console.log(prefix, message);
            }
        }
    }

    // ========================================================================
    // File Operations
    // ========================================================================

    private _ensureLogDirectory(): void {
        const logDir = path.join(this._workspaceRoot, 'design', 'agent-logs');
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
    }

    private _writePhaseLog(phaseLog: PhaseLog): void {
        try {
            this._ensureLogDirectory();
            const logDir = path.join(this._workspaceRoot, 'design', 'agent-logs');
            const filename = `${phaseLog.phase}-summary.json`;
            const filepath = path.join(logDir, filename);
            
            fs.writeFileSync(filepath, JSON.stringify(phaseLog, null, 2));
            console.log(`AgentLogService: Wrote phase log to ${filename}`);
        } catch (error) {
            console.error('AgentLogService: Failed to write phase log:', error);
        }
    }

    private _writeInteractionLog(interaction: AgentInteractionLog): void {
        try {
            this._ensureLogDirectory();
            const logDir = path.join(this._workspaceRoot, 'design', 'agent-logs');
            const filename = `${interaction.id}.json`;
            const filepath = path.join(logDir, filename);
            
            fs.writeFileSync(filepath, JSON.stringify(interaction, null, 2));
        } catch (error) {
            console.error('AgentLogService: Failed to write interaction log:', error);
        }
    }

    /**
     * Get all logs for a phase
     */
    public getPhaseLog(phase: AgentPhase): PhaseLog | undefined {
        return this._phaseLogs.get(phase);
    }

    /**
     * Get the current interaction
     */
    public getCurrentInteraction(): AgentInteractionLog | undefined {
        return this._currentInteraction;
    }
}

/**
 * Helper to get the agent log service instance
 */
export function getAgentLogService(workspaceRoot?: string): AgentLogService {
    return AgentLogService.getInstance(workspaceRoot);
}
