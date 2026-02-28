/**
 * Ansible Content Designer - Build Panel
 * 
 * Webview for monitoring build progress and viewing generated artifacts.
 */

import * as vscode from 'vscode';
import { ContentDesignerAgent, AgentState } from '../orchestrator/ContentDesignerAgent';
import type { 
    PlanItem, 
    Artifact 
} from '../types/designer';
import { DesignerDatabase } from '../database/DesignerDatabase';
import { PlanningAgent } from '../orchestrator/PlanningAgent';
import { ProgressService } from '../services/ProgressService';
import { getZoomThemeScript } from '../../panels/webviewStyles';

/**
 * Action type icons
 */
const ACTION_ICONS: Record<string, string> = {
    scaffold: '🏗️',
    generate: '✨',
    install: '📦',
    configure: '⚙️'
};

/**
 * Step status icons
 */
const STATUS_ICONS: Record<string, string> = {
    pending: '○',
    in_progress: '◐',
    complete: '✓',
    failed: '✗',
    skipped: '⊘'
};

/**
 * BuildPanel - Webview for build progress
 */
export class BuildPanel {
    public static readonly viewType = 'ansibleContentDesigner.build';
    
    private static _currentPanel: BuildPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private readonly _workspaceRoot: string;
    private _disposables: vscode.Disposable[] = [];
    private _db: DesignerDatabase;
    private _agent: ContentDesignerAgent;
    private _planningAgent: PlanningAgent;
    private _progressService: ProgressService;
    private _isBuilding: boolean = false;
    private _cancellationTokenSource: vscode.CancellationTokenSource | undefined;
    private _logMessages: string[] = [];

    private constructor(
        panel: vscode.WebviewPanel, 
        extensionUri: vscode.Uri,
        workspaceRoot: string
    ) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._workspaceRoot = workspaceRoot;
        this._db = new DesignerDatabase(workspaceRoot);
        this._agent = new ContentDesignerAgent(this._db, workspaceRoot);
        this._planningAgent = new PlanningAgent(this._db, workspaceRoot);
        this._progressService = new ProgressService(this._db);

        this._initialize();
    }

    private async _initialize(): Promise<void> {
        await this._db.initialize();

        // Set up progress callback for ContentDesignerAgent
        this._agent.onProgress((state: AgentState, message: string) => {
            this._handleAgentProgress(state, message);
        });

        this._panel.webview.html = await this._getHtml();
        
        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'startBuild':
                        await this._startBuild();
                        break;
                    case 'rebuildAll':
                        await this._rebuildAll();
                        break;
                    case 'undoBuild':
                        await this._undoBuild();
                        break;
                    case 'stopBuild':
                        this._stopBuild();
                        break;
                    case 'buildItem':
                        await this._buildItem(message.id);
                        break;
                    case 'rebuildItem':
                        await this._rebuildItem(message.id);
                        break;
                    case 'openArtifact':
                        await this._openArtifact(message.path);
                        break;
                    case 'completeBuild':
                        await this._completeBuild();
                        break;
                    case 'refresh':
                        this._panel.webview.html = await this._getHtml();
                        break;
                }
            },
            null,
            this._disposables
        );

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    }

    /**
     * Show the build panel
     */
    public static async show(extensionUri: vscode.Uri): Promise<BuildPanel | undefined> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            vscode.window.showErrorMessage('No workspace folder open');
            return undefined;
        }

        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (BuildPanel._currentPanel) {
            BuildPanel._currentPanel._panel.reveal(column);
            return BuildPanel._currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            BuildPanel.viewType,
            'Build Content',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        BuildPanel._currentPanel = new BuildPanel(panel, extensionUri, workspaceRoot);
        return BuildPanel._currentPanel;
    }

    /**
     * Start building all approved items using ContentDesignerAgent
     */
    private async _startBuild(): Promise<void> {
        if (this._isBuilding) {
            return;
        }

        this._isBuilding = true;
        this._logMessages = [];
        this._cancellationTokenSource = new vscode.CancellationTokenSource();
        
        // Refresh UI to show Stop button and clear log
        this._panel.webview.html = await this._getHtml();

        try {
            // Use ContentDesignerAgent for the build - this writes the build log
            await this._agent.execute(this._cancellationTokenSource.token);
            vscode.window.showInformationMessage('Build complete! Check design/build-log.json for details.');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Build failed: ${message}`);
        } finally {
            this._isBuilding = false;
            this._cancellationTokenSource = undefined;
            this._panel.webview.html = await this._getHtml();
        }
    }

    /**
     * Handle progress events from ContentDesignerAgent
     */
    private _handleAgentProgress(state: AgentState, message: string): void {
        // Add message to log
        const timestamp = new Date().toLocaleTimeString();
        this._logMessages.push(`[${timestamp}] ${message}`);
        
        // Keep only last 100 messages
        if (this._logMessages.length > 100) {
            this._logMessages = this._logMessages.slice(-100);
        }
        
        // Update the webview with new log
        this._panel.webview.postMessage({
            type: 'logUpdate',
            log: this._logMessages.join('\n'),
            phase: state.phase,
            currentStep: state.currentStep
        });
    }

    /**
     * Stop the build
     */
    private _stopBuild(): void {
        if (this._cancellationTokenSource) {
            this._cancellationTokenSource.cancel();
            vscode.window.showInformationMessage('Build cancelled');
        }
    }

    /**
     * Rebuild all items - resets statuses and starts fresh
     */
    private async _rebuildAll(): Promise<void> {
        if (this._isBuilding) {
            vscode.window.showWarningMessage('A build is already in progress');
            return;
        }

        const confirm = await vscode.window.showWarningMessage(
            'This will reset all build progress and start fresh. Continue?',
            { modal: true },
            'Rebuild'
        );

        if (confirm !== 'Rebuild') {
            return;
        }

        // Reset all completed/failed items back to approved
        this._db.run(`
            UPDATE plan_items 
            SET status = 'approved' 
            WHERE status IN ('complete', 'failed', 'in_progress')
        `);

        // Clear build steps
        this._db.run(`DELETE FROM build_steps`);

        // Clear artifacts
        this._db.run(`DELETE FROM artifacts`);

        vscode.window.showInformationMessage('Build reset. Starting fresh build...');
        
        // Refresh UI and start build
        this._panel.webview.html = await this._getHtml();
        await this._startBuild();
    }

    /**
     * Undo build - removes files created by the last build
     */
    private async _undoBuild(): Promise<void> {
        if (this._isBuilding) {
            vscode.window.showWarningMessage('Cannot undo while a build is in progress');
            return;
        }

        const confirm = await vscode.window.showWarningMessage(
            'This will remove all files created by the last build. Continue?',
            { modal: true },
            'Undo Build'
        );

        if (confirm !== 'Undo Build') {
            return;
        }

        try {
            const result = this._agent.undoBuild();
            
            if (result.errors.length > 0) {
                vscode.window.showWarningMessage(
                    `Undo completed with errors: Removed ${result.removed.length} files, ${result.errors.length} errors`
                );
            } else if (result.removed.length === 0) {
                vscode.window.showInformationMessage('Nothing to undo');
            } else {
                vscode.window.showInformationMessage(
                    `Undo complete: Removed ${result.removed.length} files/directories`
                );
            }
            
            // Refresh UI
            this._panel.webview.html = await this._getHtml();
            await vscode.commands.executeCommand('ansibleContentDesigner.refresh');
            
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Undo failed: ${message}`);
        }
    }

    /**
     * Rebuild a single item
     */
    private async _rebuildItem(itemId: string): Promise<void> {
        if (this._isBuilding) {
            vscode.window.showWarningMessage('A build is already in progress');
            return;
        }

        // Reset this item to approved
        this._db.run(`
            UPDATE plan_items SET status = 'approved' WHERE id = ?
        `, itemId);

        // Clear its build steps
        this._db.run(`DELETE FROM build_steps WHERE plan_item_id = ?`, itemId);

        // Clear its artifacts
        this._db.run(`DELETE FROM artifacts WHERE plan_item_id = ?`, itemId);

        // Rebuild
        await this._buildItem(itemId);
    }

    /**
     * Build a single item - triggers a full build via ContentDesignerAgent
     */
    private async _buildItem(_itemId: string): Promise<void> {
        // ContentDesignerAgent does full builds; just run the full build
        await this._startBuild();
    }

    /**
     * Open an artifact in the editor
     */
    private async _openArtifact(artifactPath: string): Promise<void> {
        const fullPath = vscode.Uri.joinPath(
            vscode.Uri.file(this._workspaceRoot),
            artifactPath
        );
        
        try {
            await vscode.commands.executeCommand('vscode.open', fullPath);
        } catch {
            vscode.window.showErrorMessage(`Could not open: ${artifactPath}`);
        }
    }

    /**
     * Complete build phase
     */
    private async _completeBuild(): Promise<void> {
        const items = this._planningAgent.getPlanItems();
        const completed = items.filter(i => i.status === 'complete').length;
        const failed = items.filter(i => i.status === 'failed').length;
        const pending = items.filter(i => i.status === 'approved').length;
        const progress = { completed, failed, pending, total: items.length };

        if (progress.failed > 0) {
            const proceed = await vscode.window.showWarningMessage(
                `${progress.failed} step(s) failed. Complete anyway?`,
                'Complete',
                'Cancel'
            );
            if (proceed !== 'Complete') return;
        }

        if (progress.pending > 0) {
            vscode.window.showWarningMessage(`${progress.pending} step(s) still pending`);
            return;
        }

        try {
            this._progressService.advancePhase('building', 'user');
            await vscode.commands.executeCommand('ansibleContentDesigner.refresh');
            
            // Close this panel and open Drift panel
            this._panel.dispose();
            await vscode.commands.executeCommand('ansibleContentDesigner.openPhase', 'drift');
            
            vscode.window.showInformationMessage('Build complete! Opening Drift Assessment...');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Cannot complete build: ${message}`);
        }
    }

    /**
     * Handle build progress event
     */
    /**
     * Generate the HTML for the webview
     */
    private async _getHtml(): Promise<string> {
        const items = this._planningAgent.getPlanItems()
            .filter(item => !['proposed', 'needs_clarification', 'revised', 'rejected'].includes(item.status));
        
        // Get artifacts from database
        const artifacts = this._db.all<Artifact>(`SELECT * FROM artifacts ORDER BY generated_at DESC`);
        
        // Calculate progress from items
        const total = items.length;
        const completed = items.filter(i => i.status === 'complete').length;
        const failed = items.filter(i => i.status === 'failed').length;
        const inProgress = items.filter(i => i.status === 'in_progress').length;
        const pending = items.filter(i => i.status === 'approved').length;
        const progress = { total, completed, failed, pending, inProgress };

        const progressPercent = progress.total > 0 
            ? Math.round((progress.completed / progress.total) * 100) 
            : 0;

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Build Content</title>
    <style>
        :root {
            --bg: var(--vscode-editor-background);
            --fg: var(--vscode-editor-foreground);
            --input-border: var(--vscode-input-border);
            --button-bg: var(--vscode-button-background);
            --button-fg: var(--vscode-button-foreground);
            --button-hover: var(--vscode-button-hoverBackground);
            --secondary-bg: var(--vscode-sideBar-background);
            --border: var(--vscode-panel-border);
            --success: var(--vscode-testing-iconPassed);
            --error: var(--vscode-errorForeground);
            --warning: var(--vscode-inputValidation-warningBorder);
        }
        
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--fg);
            background: var(--bg);
            padding: 20px;
            max-width: 900px;
            margin: 0 auto;
        }
        
        h1 { font-size: 1.5em; margin-bottom: 8px; font-weight: 500; }
        h2 { font-size: 1.2em; margin: 0 0 12px 0; font-weight: 500; }
        
        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 16px;
        }
        
        .subtitle { color: var(--vscode-descriptionForeground); }
        
        .progress-bar {
            height: 8px;
            background: var(--secondary-bg);
            border-radius: 4px;
            margin-bottom: 16px;
            overflow: hidden;
        }
        
        .progress-fill {
            height: 100%;
            background: var(--success);
            transition: width 0.3s;
        }
        
        .stats {
            display: flex;
            gap: 24px;
            margin-bottom: 16px;
            font-size: 0.9em;
        }
        
        .stat { display: flex; align-items: center; gap: 6px; }
        .stat-complete { color: var(--success); }
        .stat-failed { color: var(--error); }
        .stat-pending { color: var(--warning); }
        
        .actions {
            display: flex;
            gap: 12px;
            margin-bottom: 24px;
        }
        
        button {
            padding: 8px 16px;
            border: none;
            border-radius: 4px;
            font-size: inherit;
            cursor: pointer;
        }
        
        button.primary {
            background: var(--button-bg);
            color: var(--button-fg);
        }
        
        button.primary:hover { background: var(--button-hover); }
        button.primary:disabled { opacity: 0.5; cursor: not-allowed; }
        
        button.secondary {
            background: transparent;
            color: var(--fg);
            border: 1px solid var(--input-border);
        }
        
        button.danger {
            background: var(--error);
            color: white;
        }
        
        .section {
            background: var(--secondary-bg);
            border-radius: 8px;
            padding: 20px;
            margin-bottom: 24px;
        }
        
        .item-card {
            background: var(--bg);
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 16px;
            margin-bottom: 12px;
        }
        
        .item-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 12px;
        }
        
        .item-title {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        
        .item-icon { font-size: 1.2em; }
        .item-name { font-weight: 500; }
        
        .item-status {
            font-size: 0.85em;
            padding: 2px 8px;
            border-radius: 4px;
        }
        
        .item-status.complete { background: color-mix(in srgb, var(--success) 20%, transparent); color: var(--success); }
        .item-status.failed { background: color-mix(in srgb, var(--error) 20%, transparent); color: var(--error); }
        .item-status.in_progress { background: color-mix(in srgb, var(--button-bg) 20%, transparent); color: var(--button-bg); }
        .item-status.approved { background: color-mix(in srgb, var(--warning) 20%, transparent); color: var(--warning); }
        
        .steps-list {
            margin-top: 12px;
            padding-left: 20px;
        }
        
        .step {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 4px 0;
            font-size: 0.9em;
        }
        
        .step-icon { width: 16px; text-align: center; }
        .step-icon.complete { color: var(--success); }
        .step-icon.failed { color: var(--error); }
        .step-icon.in_progress { color: var(--button-bg); }
        
        .artifacts-section { margin-top: 16px; }
        
        .artifact {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px;
            background: var(--secondary-bg);
            border-radius: 4px;
            margin-bottom: 8px;
            cursor: pointer;
        }
        
        .artifact:hover { background: var(--input-border); }
        
        .artifact-path {
            font-family: var(--vscode-editor-font-family);
            font-size: 0.9em;
        }
        
        .empty-state {
            text-align: center;
            padding: 40px;
            color: var(--vscode-descriptionForeground);
        }
        
        .complete-section {
            display: flex;
            justify-content: flex-end;
            gap: 12px;
            margin-top: 24px;
            padding-top: 24px;
            border-top: 1px solid var(--border);
        }
        
        .log {
            background: var(--bg);
            border: 1px solid var(--border);
            border-radius: 4px;
            padding: 12px;
            max-height: 200px;
            overflow-y: auto;
            font-family: var(--vscode-editor-font-family);
            font-size: 0.85em;
            margin-top: 16px;
        }
        
        .log-entry { padding: 4px 0; border-bottom: 1px solid var(--border); }
        .log-entry:last-child { border-bottom: none; }
        .log-entry.error, .log-entry.log-error { color: var(--error); }
        .log-entry.success, .log-entry.log-success { color: var(--success); }
        .log-entry.info { color: var(--text-secondary); }
        .log-entry.phase, .log-entry.log-phase { color: var(--text); font-weight: bold; margin-top: 8px; }
        .log-entry.iteration { color: var(--warning); }
        .log-entry.research, .log-entry.log-tool { color: #6b9eff; }
        
        .log-entry {
            display: flex;
            padding: 3px 0;
            line-height: 1.4;
        }
        
        .log-time {
            flex-shrink: 0;
            width: 65px;
            color: var(--vscode-descriptionForeground);
            opacity: 0.6;
        }
        
        .log-prefix {
            flex-shrink: 0;
            width: 50px;
            font-weight: 500;
        }
        
        .log-msg {
            flex: 1;
        }
        
        /* Progress section - prominent when building */
        .progress-section {
            margin-bottom: 16px;
            order: -1;
        }
        .progress-section.active .log {
            max-height: 350px;
            border: 2px solid var(--primary);
        }
        .progress-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
        }
        .progress-header h2 { margin: 0; }
        .current-item {
            font-size: 0.9em;
            color: var(--text-secondary);
            font-style: italic;
        }
        
        /* Collapsible sections */
        .section.collapsible .section-header {
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px 0;
            user-select: none;
        }
        .section.collapsible .section-header:hover {
            opacity: 0.8;
        }
        .section.collapsible .section-header h2 {
            margin: 0;
        }
        .section.collapsible .toggle-icon {
            font-size: 0.8em;
            color: var(--text-secondary);
        }
        .section.collapsible.collapsed .section-content {
            display: none;
        }
        .section.collapsible.collapsed .toggle-icon::before {
            content: '▶';
        }
        
        .view-controls {
            display: flex;
            gap: 4px;
            align-items: center;
            margin-left: 12px;
        }
        
        .view-controls button {
            background: var(--secondary-bg);
            border: 1px solid var(--border);
            color: var(--fg);
            padding: 2px 6px;
            border-radius: 3px;
            cursor: pointer;
        }
        
        .container { zoom: 1; }
        
        body.theme-light {
            --bg: #ffffff;
            --fg: #333333;
            --secondary-bg: #f5f5f5;
            --border: #e0e0e0;
            --input-bg: #ffffff;
            --input-fg: #333333;
            --input-border: #cccccc;
        }
        
        body.theme-dark {
            --bg: #1e1e1e;
            --fg: #cccccc;
            --secondary-bg: #252526;
            --border: #3c3c3c;
            --input-bg: #3c3c3c;
            --input-fg: #cccccc;
            --input-border: #5a5a5a;
        }
    </style>
</head>
<body>
    <div class="container">
    <div class="header">
        <div>
            <h1>Build Content</h1>
            <p class="subtitle">Generate Ansible content from your plan</p>
        </div>
        <div style="display: flex; align-items: center;">
            <span>${progressPercent}% complete</span>
            <div class="view-controls">
                <button id="zoomOutBtn" title="Zoom out">−</button>
                <button id="zoomInBtn" title="Zoom in">+</button>
                <button id="themeBtn" title="Toggle theme">◐</button>
            </div>
        </div>
    </div>
    
    <div class="progress-bar">
        <div class="progress-fill" style="width: ${progressPercent}%"></div>
    </div>
    
    <div class="stats">
        <span class="stat stat-complete">✓ ${progress.completed} complete</span>
        <span class="stat stat-failed">✗ ${progress.failed} failed</span>
        <span class="stat stat-pending">○ ${progress.pending} pending</span>
    </div>
    
    <div class="actions">
        <button class="primary" id="startBuildBtn" ${this._isBuilding ? 'disabled' : ''}>
            ${this._isBuilding ? 'Building...' : 'Start Build'}
        </button>
        ${this._isBuilding ? `
            <button class="danger" id="stopBuildBtn">Stop</button>
        ` : `
            <button class="secondary" id="rebuildAllBtn" title="Reset all progress and rebuild from scratch">
                Rebuild All
            </button>
            <button class="secondary" id="undoBuildBtn" title="Remove all files created by the last build">
                Undo Build
            </button>
        `}
    </div>
    
    <!-- Progress Log (prominent when building) -->
    <div class="progress-section ${this._isBuilding ? 'active' : ''}">
        <div class="progress-header">
            <h2>Build Progress</h2>
            <span class="current-item" id="currentItem"></span>
        </div>
        <div class="log" id="buildLog">
            <div class="log-entry info">Ready to build...</div>
        </div>
    </div>
    
    <!-- Collapsible Build Items -->
    ${items.length === 0 ? `
        <div class="empty-state">
            <p>No approved items to build.</p>
            <p>Complete the Planning phase first.</p>
        </div>
    ` : `
        <div class="section collapsible ${this._isBuilding ? 'collapsed' : ''}" id="itemsSection">
            <div class="section-header" id="itemsToggle">
                <span class="toggle-icon">${this._isBuilding ? '▶' : '▼'}</span>
                <h2>Build Items (${items.length})</h2>
            </div>
            <div class="section-content">
                ${items.map(item => this._renderItemCard(item)).join('')}
            </div>
        </div>
    `}
    
    <!-- Collapsible Artifacts -->
    ${artifacts.length > 0 ? `
        <div class="section collapsible" id="artifactsSection">
            <div class="section-header" id="artifactsToggle">
                <span class="toggle-icon">▼</span>
                <h2>Generated Artifacts (${artifacts.length})</h2>
            </div>
            <div class="section-content">
                ${artifacts.map((a: Artifact) => `
                    <div class="artifact" data-path="${a.path}">
                        <span class="artifact-path">${a.path}</span>
                    </div>
                `).join('')}
            </div>
        </div>
    ` : ''}
    
    ${progress.completed > 0 ? `
        <div class="complete-section">
            <button class="primary" id="completeBtn">
                Complete Build →
            </button>
        </div>
    ` : ''}
    
    <script>
        const vscode = acquireVsCodeApi();
        const log = document.getElementById('buildLog');
        const currentItem = document.getElementById('currentItem');
        
        // Event type to CSS class mapping
        const eventClasses = {
            'phase_started': 'phase',
            'research_started': 'research',
            'research_completed': 'research',
            'generation_started': 'info',
            'generation_iteration': 'iteration',
            'validation_started': 'info',
            'validation_passed': 'success',
            'validation_failed': 'error',
            'step_started': 'info',
            'step_completed': 'success',
            'step_failed': 'error',
            'item_completed': 'phase',
            'build_completed': 'success'
        };
        
        // Handle build events
        window.addEventListener('message', event => {
            const message = event.data;
            
            // Handle log updates from agent progress
            if (message.type === 'logUpdate') {
                log.innerHTML = '';
                const lines = message.log.split('\\n');
                lines.forEach(line => {
                    const entry = document.createElement('div');
                    entry.className = 'log-entry';
                    
                    // Color-code based on content
                    if (line.includes('[ERROR]') || line.includes('failed')) {
                        entry.classList.add('log-error');
                    } else if (line.includes('[SUCCESS]') || line.includes('completed')) {
                        entry.classList.add('log-success');
                    } else if (line.includes('[MCP]') || line.includes('Calling')) {
                        entry.classList.add('log-tool');
                    } else if (line.includes('Step')) {
                        entry.classList.add('log-phase');
                    }
                    
                    const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
                    const parts = line.split(' ');
                    const prefix = parts[0] || '';
                    const rest = parts.slice(1).join(' ');
                    entry.innerHTML = '<span class="log-time">' + time + '</span><span class="log-prefix">' + prefix + '</span><span class="log-msg">' + rest + '</span>';
                    log.insertBefore(entry, log.firstChild);
                });
                
                // Update current step
                if (message.currentStep && currentItem) {
                    currentItem.textContent = 'Step ' + message.currentStep + ': ' + (message.phase || 'building');
                }
                
                // Collapse items section when building
                const itemsSection = document.getElementById('itemsSection');
                if (itemsSection && !itemsSection.classList.contains('collapsed')) {
                    itemsSection.classList.add('collapsed');
                    const icon = itemsSection.querySelector('.toggle-icon');
                    if (icon) icon.textContent = '▶';
                }
            }
            
            // Handle legacy build events
            if (message.type === 'buildEvent') {
                const entry = document.createElement('div');
                const eventType = message.event.type;
                entry.className = 'log-entry ' + (eventClasses[eventType] || '');
                
                // Build message with context
                let text = message.event.message;
                if (message.event.iteration) {
                    text = '[' + message.event.iteration + '/' + message.event.maxIterations + '] ' + text;
                }
                if (message.event.errors && message.event.errors.length > 0) {
                    text += '\\n  - ' + message.event.errors.slice(0, 3).join('\\n  - ');
                }
                
                const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
                const parts = text.split(' ');
                const prefix = parts[0] || '';
                const rest = parts.slice(1).join(' ');
                entry.innerHTML = '<span class="log-time">' + time + '</span><span class="log-prefix">' + prefix + '</span><span class="log-msg">' + rest + '</span>';
                log.insertBefore(entry, log.firstChild);
                
                // Update current item indicator
                if (message.event.itemId && currentItem) {
                    if (eventType === 'item_completed' || eventType === 'build_completed') {
                        currentItem.textContent = '';
                    } else {
                        currentItem.textContent = 'Working on: ' + message.event.itemId;
                    }
                }
                
                // Collapse items section when building starts
                if (eventType === 'phase_started') {
                    const itemsSection = document.getElementById('itemsSection');
                    if (itemsSection && !itemsSection.classList.contains('collapsed')) {
                        itemsSection.classList.add('collapsed');
                        const icon = itemsSection.querySelector('.toggle-icon');
                        if (icon) icon.textContent = '▶';
                    }
                }
            }
        });
        
        // Toggle collapsible sections
        document.querySelectorAll('.section-header').forEach(header => {
            header.addEventListener('click', () => {
                const section = header.parentElement;
                const icon = header.querySelector('.toggle-icon');
                if (section.classList.contains('collapsed')) {
                    section.classList.remove('collapsed');
                    icon.textContent = '▼';
                } else {
                    section.classList.add('collapsed');
                    icon.textContent = '▶';
                }
            });
        });
        
        // Start build
        const startBtn = document.getElementById('startBuildBtn');
        if (startBtn) {
            startBtn.addEventListener('click', () => {
                vscode.postMessage({ command: 'startBuild' });
            });
        }
        
        // Stop build
        const stopBtn = document.getElementById('stopBuildBtn');
        if (stopBtn) {
            stopBtn.addEventListener('click', () => {
                vscode.postMessage({ command: 'stopBuild' });
            });
        }
        
        // Rebuild all
        const rebuildAllBtn = document.getElementById('rebuildAllBtn');
        if (rebuildAllBtn) {
            rebuildAllBtn.addEventListener('click', () => {
                vscode.postMessage({ command: 'rebuildAll' });
            });
        }
        
        const undoBuildBtn = document.getElementById('undoBuildBtn');
        if (undoBuildBtn) {
            undoBuildBtn.addEventListener('click', () => {
                vscode.postMessage({ command: 'undoBuild' });
            });
        }
        
        // Build single item
        document.querySelectorAll('.build-item-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                vscode.postMessage({ command: 'buildItem', id: btn.dataset.id });
            });
        });
        
        // Rebuild single item
        document.querySelectorAll('.rebuild-item-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                vscode.postMessage({ command: 'rebuildItem', id: btn.dataset.id });
            });
        });
        
        // Open artifact
        document.querySelectorAll('.artifact').forEach(el => {
            el.addEventListener('click', () => {
                vscode.postMessage({ command: 'openArtifact', path: el.dataset.path });
            });
        });
        
        // Complete
        const completeBtn = document.getElementById('completeBtn');
        if (completeBtn) {
            completeBtn.addEventListener('click', () => {
                vscode.postMessage({ command: 'completeBuild' });
            });
        }
        
        // Zoom/Theme controls
        ${getZoomThemeScript('build')}
    </script>
    </div>
</body>
</html>`;
    }

    /**
     * Render an item card with build steps
     */
    private _renderItemCard(item: PlanItem): string {
        const icon = ACTION_ICONS[item.type] || '📁';
        
        // Parse step details from description JSON
        let stepDescription = item.name;
        try {
            const details = JSON.parse(item.description || '{}');
            stepDescription = details.description || details.content_description || item.name;
        } catch {
            // Use name as fallback
        }

        return `
            <div class="item-card">
                <div class="item-header">
                    <div class="item-title">
                        <span class="item-icon">${icon}</span>
                        <span class="item-name">${item.type}: ${this._escapeHtml(item.name)}</span>
                    </div>
                    <span class="item-status ${item.status}">${item.status}</span>
                </div>
                
                <div class="step-description">${this._escapeHtml(stepDescription)}</div>
                
                ${['complete', 'failed'].includes(item.status) ? `
                    <button class="secondary rebuild-item-btn" data-id="${item.id}" title="Reset and rebuild this item">
                        Rebuild
                    </button>
                ` : ''}
            </div>
        `;
    }

    /**
     * Escape HTML
     */
    private _escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    public dispose(): void {
        BuildPanel._currentPanel = undefined;
        this._cancellationTokenSource?.cancel();
        this._db.close();
        this._panel.dispose();
        while (this._disposables.length) {
            const disposable = this._disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }
}
