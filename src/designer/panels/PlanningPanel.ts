/**
 * Ansible Content Designer - Planning Panel
 * 
 * Webview for reviewing and approving implementation plans.
 */

import * as vscode from 'vscode';
import type { 
    PlanItem, 
    EnrichedRequirement 
} from '../types/designer';
import { DesignerDatabase } from '../database/DesignerDatabase';
import { PlanningAgent } from '../orchestrator/PlanningAgent';
import { RequirementService } from '../services/RequirementService';
import { ProgressService } from '../services/ProgressService';
import { AgentLogService } from '../services/AgentLogService';
import { 
    getZoomThemeScript,
    AGENT_PROGRESS_STYLES,
    getAgentProgressHtml,
    getAgentProgressScript,
    formatAgentLogMessage
} from '../../panels/webviewStyles';

/**
 * Status colors
 */
const STATUS_STYLES: Record<PlanItem['status'], { bg: string; text: string; label: string }> = {
    proposed: { bg: 'var(--vscode-inputValidation-infoBackground)', text: 'var(--vscode-inputValidation-infoBorder)', label: 'Proposed' },
    needs_clarification: { bg: 'var(--vscode-inputValidation-warningBackground)', text: 'var(--vscode-inputValidation-warningBorder)', label: 'Needs Clarification' },
    revised: { bg: 'var(--vscode-inputValidation-infoBackground)', text: 'var(--vscode-textLink-foreground)', label: 'Revised' },
    approved: { bg: 'color-mix(in srgb, var(--vscode-testing-iconPassed) 20%, transparent)', text: 'var(--vscode-testing-iconPassed)', label: 'Approved' },
    rejected: { bg: 'color-mix(in srgb, var(--vscode-errorForeground) 20%, transparent)', text: 'var(--vscode-errorForeground)', label: 'Rejected' },
    in_progress: { bg: 'color-mix(in srgb, var(--vscode-progressBar-background) 20%, transparent)', text: 'var(--vscode-progressBar-background)', label: 'In Progress' },
    complete: { bg: 'color-mix(in srgb, var(--vscode-testing-iconPassed) 30%, transparent)', text: 'var(--vscode-testing-iconPassed)', label: 'Complete' },
    failed: { bg: 'color-mix(in srgb, var(--vscode-errorForeground) 30%, transparent)', text: 'var(--vscode-errorForeground)', label: 'Failed' }
};

/**
 * PlanningPanel - Webview for plan review
 */
export class PlanningPanel {
    public static readonly viewType = 'ansibleContentDesigner.planning';
    
    private static _currentPanel: PlanningPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private readonly _workspaceRoot: string;
    private _disposables: vscode.Disposable[] = [];
    private _db: DesignerDatabase;
    private _agent: PlanningAgent;
    private _requirementService: RequirementService;
    private _progressService: ProgressService;

    private constructor(
        panel: vscode.WebviewPanel, 
        extensionUri: vscode.Uri,
        workspaceRoot: string
    ) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._workspaceRoot = workspaceRoot;
        this._db = new DesignerDatabase(workspaceRoot);
        this._agent = new PlanningAgent(this._db, workspaceRoot);
        this._requirementService = new RequirementService(this._db);
        this._progressService = new ProgressService(this._db);

        this._initialize();
    }

    private async _initialize(): Promise<void> {
        await this._db.initialize();
        
        // Generate plan if none exists
        const items = this._agent.getPlanItems();
        if (items.length === 0) {
            const requirements = this._requirementService.list();
            if (requirements.length > 0) {
                // Show loading UI first
                this._panel.webview.html = await this._getHtml(true);
                
                // Generate with live progress
                await this._generatePlanWithProgress(requirements);
                return; // _generatePlanWithProgress will refresh the UI
            }
        }

        this._panel.webview.html = await this._getHtml(false);
        
        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'approveItem':
                        this._approveItem(message.id);
                        break;
                    case 'rejectItem':
                        await this._rejectItem(message.id);
                        break;
                    case 'approveAll':
                        this._approveAll();
                        break;
                    case 'deleteItem':
                        await this._deleteItem(message.id);
                        break;
                    case 'addComment':
                        await this._addComment(message.id, message.comment);
                        break;
                    case 'regenerateItem':
                        await this._regenerateItem(message.id);
                        break;
                    case 'regeneratePlan':
                        await this._regeneratePlan();
                        break;
                    case 'completePlanning':
                        await this._completePlanning();
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
     * Show the planning panel
     */
    public static async show(extensionUri: vscode.Uri): Promise<PlanningPanel | undefined> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            vscode.window.showErrorMessage('No workspace folder open');
            return undefined;
        }

        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (PlanningPanel._currentPanel) {
            PlanningPanel._currentPanel._panel.reveal(column);
            return PlanningPanel._currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            PlanningPanel.viewType,
            'Implementation Plan',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        PlanningPanel._currentPanel = new PlanningPanel(panel, extensionUri, workspaceRoot);
        return PlanningPanel._currentPanel;
    }

    /**
     * Approve a plan item
     */
    private _approveItem(id: string): void {
        this._agent.approveItem(id);
        this._updateProgress();
        this._refreshPanel();
    }

    /**
     * Reject a plan item
     */
    private async _rejectItem(id: string): Promise<void> {
        const reason = await vscode.window.showInputBox({
            prompt: 'Reason for rejection',
            placeHolder: 'Why is this item being rejected?'
        });

        if (reason === undefined) return;

        this._agent.rejectItem(id, reason);
        this._updateProgress();
        this._refreshPanel();
    }

    /**
     * Generate plan with live progress updates
     */
    private async _generatePlanWithProgress(requirements: EnrichedRequirement[]): Promise<void> {
        const logService = AgentLogService.getInstance(this._workspaceRoot);
        
        // Set up progress callback for live updates (using centralized formatting)
        logService.setProgressCallback((message: string, type: string) => {
            const displayMessage = formatAgentLogMessage(message, type);
            if (!displayMessage) return; // Skip empty messages
            
            const status = type === 'error' ? 'error' : 'working';
            
            this._panel.webview.postMessage({
                command: 'agentProgress',
                data: { status, message: displayMessage, type }
            });
        });
        
        try {
            await this._agent.generatePlan(requirements);
            
            // Notify completion
            this._panel.webview.postMessage({
                command: 'agentProgress',
                data: { status: 'complete', message: '✓ Plan generation complete!', type: 'info' }
            });
            
            // Wait a moment then refresh
            setTimeout(() => {
                this._refreshPanel();
            }, 1500);
        } catch (error) {
            this._panel.webview.postMessage({
                command: 'agentProgress',
                data: { 
                    status: 'error', 
                    message: `❌ ${error instanceof Error ? error.message : 'Unknown error'}`, 
                    type: 'error' 
                }
            });
        } finally {
            logService.setProgressCallback(undefined);
        }
    }

    /**
     * Add a comment to a plan item
     */
    private async _addComment(id: string, comment: string): Promise<void> {
        if (!comment || !comment.trim()) {
            vscode.window.showWarningMessage('Please enter a comment');
            return;
        }

        try {
            await this._agent.addComment(id, comment.trim());
            this._refreshPanel();
            vscode.window.showInformationMessage('Comment added. Use "Regenerate" to update the plan based on your feedback.');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to add comment: ${message}`);
        }
    }

    /**
     * Regenerate a single plan item based on comments
     */
    private async _regenerateItem(id: string): Promise<void> {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Regenerating ${id}...`,
            cancellable: false
        }, async () => {
            try {
                await this._agent.regenerateItem(id);
                this._refreshPanel();
                vscode.window.showInformationMessage(`${id} has been revised based on your feedback`);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`Failed to regenerate: ${message}`);
            }
        });
    }

    /**
     * Approve all pending items
     */
    private _approveAll(): void {
        const items = this._agent.getPlanItems();
        for (const item of items) {
            if (['proposed', 'needs_clarification', 'revised'].includes(item.status)) {
                this._agent.approveItem(item.id);
            }
        }
        this._updateProgress();
        this._refreshPanel();
        vscode.window.showInformationMessage('All items approved');
    }

    /**
     * Delete a plan item
     */
    private async _deleteItem(id: string): Promise<void> {
        const confirm = await vscode.window.showWarningMessage(
            `Delete plan item ${id}?`,
            { modal: true },
            'Delete'
        );

        if (confirm !== 'Delete') return;

        this._agent.deleteItem(id);
        this._updateProgress();
        this._refreshPanel();
    }

    /**
     * Regenerate the plan
     */
    private async _regeneratePlan(): Promise<void> {
        const confirm = await vscode.window.showWarningMessage(
            'This will regenerate the entire plan. Existing approvals will be lost.',
            { modal: true },
            'Regenerate'
        );

        if (confirm !== 'Regenerate') return;

        // Clear existing items
        this._db.run('DELETE FROM plan_items');

        const requirements = this._requirementService.list();
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Regenerating implementation plan...',
            cancellable: false
        }, async () => {
            await this._agent.generatePlan(requirements);
        });

        this._updateProgress();
        this._refreshPanel();
    }

    /**
     * Complete planning and proceed
     */
    private async _completePlanning(): Promise<void> {
        const items = this._agent.getPlanItems();
        const approved = items.filter(i => i.status === 'approved').length;
        const pending = items.filter(i => ['proposed', 'needs_clarification', 'revised'].includes(i.status)).length;

        if (pending > 0) {
            const proceed = await vscode.window.showWarningMessage(
                `${pending} item(s) are still pending. Approve all or continue anyway?`,
                'Approve All & Continue',
                'Continue Anyway',
                'Cancel'
            );

            if (proceed === 'Cancel' || proceed === undefined) return;
            if (proceed === 'Approve All & Continue') {
                this._approveAll();
            }
        }

        if (approved === 0 && pending === 0) {
            vscode.window.showWarningMessage('No plan items to build');
            return;
        }

        try {
            this._progressService.advancePhase('planning', 'user');
            await vscode.commands.executeCommand('ansibleContentDesigner.refresh');
            
            // Close this panel and open Build panel
            this._panel.dispose();
            await vscode.commands.executeCommand('ansibleContentDesigner.openPhase', 'building');
            
            vscode.window.showInformationMessage('Planning complete! Opening Build...');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Cannot complete planning: ${message}`);
        }
    }

    /**
     * Update progress counts
     */
    private _updateProgress(): void {
        const items = this._agent.getPlanItems();
        const total = items.length;
        const approved = items.filter(i => i.status === 'approved').length;
        const pending = items.filter(i => ['proposed', 'needs_clarification', 'revised'].includes(i.status)).length;

        this._progressService.updatePhaseCounts('planning', total, approved, pending);
    }

    /**
     * Refresh the panel
     */
    private async _refreshPanel(): Promise<void> {
        this._panel.webview.html = await this._getHtml();
    }

    /**
     * Generate the HTML for the webview
     */
    private async _getHtml(showLoading = false): Promise<string> {
        const items = this._agent.getPlanItems();
        const requirements = this._requirementService.list();
        const collections = this._agent.getCollectionsToInstall();
        
        const approved = items.filter(i => i.status === 'approved').length;
        const pending = items.filter(i => ['proposed', 'needs_clarification', 'revised'].includes(i.status)).length;
        const total = items.length;
        const progress = total > 0 ? Math.round((approved / total) * 100) : 0;

        // Sort items by sequence (sequential, not grouped)
        const sortedItems = [...items].sort((a, b) => (a.sequence || 0) - (b.sequence || 0));

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Implementation Plan</title>
    <style>
        :root {
            --bg: var(--vscode-editor-background);
            --fg: var(--vscode-editor-foreground);
            --input-bg: var(--vscode-input-background);
            --input-border: var(--vscode-input-border);
            --button-bg: var(--vscode-button-background);
            --button-fg: var(--vscode-button-foreground);
            --button-hover: var(--vscode-button-hoverBackground);
            --secondary-bg: var(--vscode-sideBar-background);
            --border: var(--vscode-panel-border);
            --success: var(--vscode-testing-iconPassed);
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
            margin-bottom: 24px;
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
        .stat-approved { color: var(--success); }
        .stat-pending { color: var(--vscode-inputValidation-warningBorder); }
        
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
        
        button.small {
            padding: 4px 8px;
            font-size: 0.85em;
        }
        
        /* Step Cards - Sequential Plan Display */
        .plan-steps {
            display: flex;
            flex-direction: column;
            gap: 16px;
        }
        
        .step-card {
            background: var(--secondary-bg);
            border: 1px solid var(--border);
            border-radius: 8px;
            overflow: hidden;
            transition: border-color 0.2s;
        }
        
        .step-card:hover {
            border-color: var(--button-bg);
        }
        
        .step-card.approved {
            border-left: 3px solid var(--success);
        }
        
        .step-card.rejected {
            opacity: 0.6;
            border-left: 3px solid var(--vscode-errorForeground);
        }
        
        .step-header {
            display: flex;
            align-items: stretch;
            background: var(--input-bg);
            border-bottom: 1px solid var(--border);
        }
        
        .step-info {
            flex: 1;
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 12px 16px;
            padding: 12px 16px;
            gap: 12px;
        }
        
        .step-badges {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        
        .step-action {
            font-size: 0.75em;
            font-weight: 600;
            text-transform: uppercase;
            padding: 3px 8px;
            border-radius: 3px;
            background: var(--border);
        }
        
        /* Greyscale action badges - professional look */
        .step-action.scaffold { background: #3a3a3a; color: #a0a0a0; }
        .step-action.generate { background: #3a3a3a; color: #a0a0a0; }
        .step-action.install { background: #3a3a3a; color: #a0a0a0; }
        .step-action.configure { background: #3a3a3a; color: #a0a0a0; }
        
        .step-title {
            font-weight: 500;
            font-size: 0.95em;
        }
        
        .step-status {
            font-size: 0.7em;
            font-weight: 500;
            padding: 3px 10px;
            border-radius: 12px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            white-space: nowrap;
        }
        
        .step-body {
            padding: 16px 20px;
        }
        
        .step-summary {
            font-size: 0.9em;
            line-height: 1.6;
            color: var(--fg);
            margin-bottom: 16px;
        }
        
        .step-addresses {
            display: flex;
            flex-direction: column;
            gap: 8px;
            margin-bottom: 16px;
            padding: 12px;
            background: var(--bg);
            border-radius: 6px;
        }
        
        .address-group {
            display: flex;
            align-items: flex-start;
            gap: 8px;
            font-size: 0.85em;
        }
        
        .address-label {
            color: var(--vscode-descriptionForeground);
            white-space: nowrap;
            min-width: 120px;
        }
        
        .address-items {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
        }
        
        .tag {
            font-size: 0.8em;
            padding: 2px 8px;
            border-radius: 3px;
            background: var(--border);
        }
        
        /* Greyscale tags - professional look */
        .tag.req { background: #2a2a2a; color: #b0b0b0; border: 1px solid #404040; }
        .tag.decision { background: #2a2a2a; color: #909090; border: 1px solid #404040; }
        .tag.practice { background: #2a2a2a; color: #909090; border: 1px solid #404040; font-style: italic; }
        
        /* Tooltips for tags - no cursor change */
        .tag[title]:hover { background: #3a3a3a; }
        
        .step-detail {
            display: flex;
            align-items: flex-start;
            gap: 8px;
            margin-bottom: 8px;
            font-size: 0.85em;
        }
        
        .detail-label {
            color: var(--vscode-descriptionForeground);
            min-width: 80px;
        }
        
        .step-detail code {
            font-family: 'SF Mono', Monaco, 'Cascadia Code', Consolas, monospace;
            font-size: 0.9em;
            background: var(--bg);
            padding: 2px 6px;
            border-radius: 3px;
        }
        
        .step-footer {
            display: flex;
            justify-content: flex-end;
            align-items: center;
            padding: 10px 16px;
            background: var(--bg);
            border-top: 1px solid var(--border);
        }
        
        .step-actions {
            display: flex;
            gap: 8px;
        }
        
        .btn-approve, .btn-secondary, .btn-delete {
            font-size: 0.8em;
            padding: 4px 12px;
            border-radius: 4px;
            border: none;
            cursor: pointer;
            transition: background 0.2s;
        }
        
        .btn-approve {
            background: var(--button-bg);
            color: var(--button-fg);
        }
        
        .btn-approve:hover {
            background: var(--button-hover);
        }
        
        .btn-secondary {
            background: var(--input-bg);
            color: var(--fg);
            border: 1px solid var(--border);
        }
        
        .btn-secondary:hover {
            background: var(--border);
        }
        
        .btn-delete {
            background: transparent;
            color: var(--vscode-descriptionForeground);
            font-size: 1.1em;
            padding: 2px 8px;
        }
        
        .btn-delete:hover {
            color: var(--vscode-errorForeground);
        }
        
        .step-feedback {
            margin-top: 12px;
            padding-top: 12px;
            border-top: 1px solid var(--border);
        }
        
        .feedback-input {
            width: 100%;
            max-width: 100%;
            box-sizing: border-box;
            padding: 8px 12px;
            background: var(--input-bg);
            color: var(--fg);
            border: 1px solid var(--border);
            border-radius: 4px;
            font-size: 0.9em;
        }
        
        .feedback-input:focus {
            outline: none;
            border-color: var(--button-bg);
        }
        
        .feedback-input::placeholder {
            color: var(--vscode-descriptionForeground);
        }
        
        .history-entry.agent {
            background: var(--secondary-bg);
        }
        
        .history-entry.user {
            background: color-mix(in srgb, var(--button-bg) 15%, transparent);
        }
        
        .history-label {
            font-weight: 600;
            margin-right: 8px;
        }
        
        .history-entry.proposed .history-label { color: var(--vscode-textLink-foreground); }
        .history-entry.comment .history-label { color: var(--button-bg); }
        .history-entry.revised .history-label { color: var(--vscode-testing-iconPassed); }
        .history-entry.approved .history-label { color: var(--vscode-testing-iconPassed); }
        .history-entry.rejected .history-label { color: var(--vscode-errorForeground); }
        
        .history-content {
            white-space: pre-wrap;
        }
        
        .plan-item-comment {
            margin: 8px 0;
        }
        
        .comment-input {
            width: 100%;
            padding: 6px 8px;
            background: var(--input-bg);
            color: var(--input-fg);
            border: 1px solid var(--input-border);
            border-radius: 3px;
            font-family: inherit;
            font-size: 0.9em;
            resize: vertical;
            min-height: 40px;
        }
        
        .comment-input:focus {
            outline: none;
            border-color: var(--focus);
        }
        
        .comment-actions {
            display: flex;
            gap: 8px;
            margin-top: 4px;
        }
        
        .plan-item-actions {
            display: flex;
            gap: 8px;
            margin-top: 12px;
            padding-top: 12px;
            border-top: 1px solid var(--border);
        }
        
        .collections-section {
            background: var(--secondary-bg);
            border-radius: 8px;
            padding: 16px;
            margin-bottom: 24px;
        }
        
        .collection-list {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            margin-top: 8px;
        }
        
        .collection-tag {
            background: var(--bg);
            padding: 4px 8px;
            border-radius: 4px;
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
        
        /* Agent Progress Panel - Centralized Styles */
        ${AGENT_PROGRESS_STYLES}
    </style>
</head>
<body>
    <!-- Agent Progress Panel (centralized) -->
    ${getAgentProgressHtml('Generating Implementation Plan...', showLoading)}

    <div class="container">
    <div class="header">
        <div>
            <h1>Implementation Plan</h1>
            <p class="subtitle">Review and approve artifacts to build</p>
        </div>
        <div style="display: flex; align-items: center;">
            <span>${approved}/${total} approved</span>
            <div class="view-controls">
                <button id="zoomOutBtn" title="Zoom out">−</button>
                <button id="zoomInBtn" title="Zoom in">+</button>
                <button id="themeBtn" title="Toggle theme">◐</button>
            </div>
        </div>
    </div>
    
    <div class="progress-bar">
        <div class="progress-fill" style="width: ${progress}%"></div>
    </div>
    
    <div class="stats">
        <span class="stat stat-approved">${approved} approved</span>
        <span class="stat stat-pending">${pending} pending</span>
        <span class="stat">${collections.length} collections</span>
    </div>
    
    <div class="actions">
        <button class="primary" id="approveAllBtn" ${pending === 0 ? 'disabled' : ''}>
            Approve All
        </button>
        <button class="secondary" id="regenerateBtn">
            Regenerate Plan
        </button>
    </div>
    
    ${collections.length > 0 ? `
        <div class="collections-section">
            <h2>Collections to Install</h2>
            <div class="collection-list">
                ${collections.map((c: string) => `<span class="collection-tag">${c}</span>`).join('')}
            </div>
        </div>
    ` : ''}
    
    ${items.length === 0 ? `
        <div class="empty-state">
            <p>No plan items generated yet.</p>
            <button class="primary" id="generateBtn">Generate Plan</button>
        </div>
    ` : `
        <div class="plan-steps">
            ${sortedItems.map((item, idx) => this._renderPlanItem(item, idx + 1, requirements)).join('')}
        </div>
    `}
    
    ${items.length > 0 ? `
        <div class="complete-section">
            <button class="primary" id="completeBtn">
                Complete Planning →
            </button>
        </div>
    ` : ''}
    
    <script>
        const vscode = acquireVsCodeApi();
        
        // Use event delegation for all buttons (more reliable)
        document.addEventListener('click', function(e) {
            const target = e.target;
            if (!target || !target.classList) return;
            
            if (target.classList.contains('approve-btn')) {
                const id = target.getAttribute('data-id');
                if (id) vscode.postMessage({ command: 'approveItem', id: id });
            } else if (target.classList.contains('reject-btn')) {
                const id = target.getAttribute('data-id');
                if (id) vscode.postMessage({ command: 'rejectItem', id: id });
            } else if (target.classList.contains('delete-btn')) {
                const id = target.getAttribute('data-id');
                if (id) vscode.postMessage({ command: 'deleteItem', id: id });
            }
        });
        
        // Feedback input - submit on Enter
        document.querySelectorAll('.feedback-input').forEach(input => {
            input.addEventListener('keypress', (e) => {
                if (e.key === 'Enter' && input.value.trim()) {
                    vscode.postMessage({ 
                        command: 'addComment', 
                        id: input.dataset.id,
                        comment: input.value.trim()
                    });
                    input.value = '';
                }
            });
        });
        
        // Add comment
        document.querySelectorAll('.comment-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const itemDiv = btn.closest('.plan-item');
                const textarea = itemDiv.querySelector('.comment-input');
                vscode.postMessage({ 
                    command: 'addComment', 
                    id: btn.dataset.id,
                    comment: textarea.value
                });
                textarea.value = '';
            });
        });
        
        // Regenerate item
        document.querySelectorAll('.regenerate-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                vscode.postMessage({ command: 'regenerateItem', id: btn.dataset.id });
            });
        });
        
        // Approve all
        const approveAllBtn = document.getElementById('approveAllBtn');
        if (approveAllBtn) {
            approveAllBtn.addEventListener('click', () => {
                vscode.postMessage({ command: 'approveAll' });
            });
        }
        
        // Regenerate
        const regenBtn = document.getElementById('regenerateBtn');
        if (regenBtn) {
            regenBtn.addEventListener('click', () => {
                vscode.postMessage({ command: 'regeneratePlan' });
            });
        }
        
        // Generate
        const genBtn = document.getElementById('generateBtn');
        if (genBtn) {
            genBtn.addEventListener('click', () => {
                vscode.postMessage({ command: 'refresh' });
            });
        }
        
        // Complete
        const completeBtn = document.getElementById('completeBtn');
        if (completeBtn) {
            completeBtn.addEventListener('click', () => {
                vscode.postMessage({ command: 'completePlanning' });
            });
        }
        
        // Zoom/Theme controls
        ${getZoomThemeScript('planning')}
        
        // Handle agent progress messages (centralized)
        ${getAgentProgressScript('Plan Generation Complete!', 2000)}
    </script>
    </div>
</body>
</html>`;
    }

    /**
     * Render a plan item card with structured details
     */
    private _renderPlanItem(item: PlanItem, stepNum: number, requirements: EnrichedRequirement[]): string {
        const statusStyle = STATUS_STYLES[item.status] || STATUS_STYLES.proposed;
        const canComment = !['approved', 'rejected', 'complete', 'failed'].includes(item.status);
        const canApprove = ['proposed', 'revised'].includes(item.status);

        // Parse step details from description (stored as JSON)
        let details: {
            action?: string;
            summary?: string;
            creator_command?: string[];
            creator_args?: Record<string, string>;
            file_path?: string;
            content_description?: string;
            collection?: string;
            addresses?: {
                requirements?: string[];
                design_decisions?: string[];
                best_practices?: string[];
            };
        } = {};
        
        try {
            details = JSON.parse(item.description || '{}');
        } catch {
            details = { summary: item.name };
        }

        // Build short title (action + key info)
        const actionLabel = this._getActionLabel(details.action || item.type);
        const shortTitle = this._getShortTitle(details);
        
        // Get requirement info for tooltips
        const addressedReqsWithTooltips = (details.addresses?.requirements || [item.requirement_id])
            .map(reqId => {
                const req = requirements.find(r => r.id === reqId);
                return {
                    id: reqId,
                    shortText: req ? `${reqId}: ${req.description.substring(0, 40)}${req.description.length > 40 ? '...' : ''}` : reqId,
                    fullText: req ? req.description : reqId
                };
            });
        
        // Get design decision info for tooltips
        const designDecisions = details.addresses?.design_decisions || [];
        const decisionTooltips = this._getDesignDecisionTooltips(designDecisions);

        return `
            <div class="step-card ${item.status}" data-item-id="${item.id}">
                <div class="step-header">
                    <div class="step-info">
                        <span class="step-title">${item.id}: ${this._escapeHtml(shortTitle)}</span>
                        <div class="step-badges">
                            <span class="step-action ${details.action || item.type}">${actionLabel}</span>
                            <span class="step-status" style="background: ${statusStyle.bg}; color: ${statusStyle.text}">
                                ${statusStyle.label}
                            </span>
                        </div>
                    </div>
                </div>
                
                <div class="step-body">
                    <div class="step-summary">
                        ${this._escapeHtml(details.summary || item.name)}
                    </div>
                    
                    ${details.addresses ? `
                        <div class="step-addresses">
                            ${addressedReqsWithTooltips.length > 0 ? `
                                <div class="address-group">
                                    <span class="address-label">Requirements:</span>
                                    <span class="address-items">${addressedReqsWithTooltips.map(r => 
                                        `<span class="tag req" title="${this._escapeHtml(r.fullText)}">${this._escapeHtml(r.shortText)}</span>`
                                    ).join('')}</span>
                                </div>
                            ` : ''}
                            ${designDecisions.length > 0 ? `
                                <div class="address-group">
                                    <span class="address-label">Design Decisions:</span>
                                    <span class="address-items">${designDecisions.map(d => {
                                        const tooltip = decisionTooltips[d] || d;
                                        return `<span class="tag decision" title="${this._escapeHtml(tooltip)}">${d}</span>`;
                                    }).join('')}</span>
                                </div>
                            ` : ''}
                            ${(details.addresses.best_practices?.length || 0) > 0 ? `
                                <div class="address-group">
                                    <span class="address-label">Best Practices:</span>
                                    <span class="address-items">${details.addresses.best_practices?.map(p => `<span class="tag practice">${this._escapeHtml(p)}</span>`).join('')}</span>
                                </div>
                            ` : ''}
                        </div>
                    ` : ''}
                    
                    ${details.creator_command ? `
                        <div class="step-detail">
                            <span class="detail-label">Command:</span>
                            <code>ansible-creator ${details.creator_command.join(' ')}</code>
                        </div>
                    ` : ''}
                    
                    ${details.file_path ? `
                        <div class="step-detail">
                            <span class="detail-label">File:</span>
                            <code>${this._escapeHtml(details.file_path)}</code>
                        </div>
                    ` : ''}
                    
                    ${details.content_description ? `
                        <div class="step-detail">
                            <span class="detail-label">Content:</span>
                            <span class="detail-value">${this._escapeHtml(details.content_description)}</span>
                        </div>
                    ` : ''}
                    
                    ${canApprove ? `
                        <div class="step-feedback">
                            <input type="text" class="feedback-input" data-id="${item.id}" placeholder="Add feedback or clarification..." />
                        </div>
                    ` : ''}
                </div>
                
                <div class="step-footer">
                    <div class="step-actions">
                        ${canApprove ? `
                            <button class="btn-approve approve-btn" data-id="${item.id}">Approve</button>
                            <button class="btn-secondary reject-btn" data-id="${item.id}">Reject</button>
                        ` : ''}
                        <button class="btn-delete delete-btn" data-id="${item.id}">×</button>
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * Get human-readable action label
     */
    private _getActionLabel(action: string): string {
        const labels: Record<string, string> = {
            scaffold: 'Scaffold',
            generate: 'Generate',
            install: 'Install',
            configure: 'Configure'
        };
        return labels[action] || action;
    }

    /**
     * Get short title from step details
     */
    private _getShortTitle(details: Record<string, unknown>): string {
        if (details.creator_command) {
            const cmd = details.creator_command as string[];
            if (cmd.includes('init')) {
                return 'Initialize project structure';
            }
            if (cmd.includes('role')) {
                const args = details.creator_args as Record<string, string>;
                return `Add role: ${args?.role_name || 'role'}`;
            }
        }
        if (details.file_path) {
            return `Write ${details.file_path}`;
        }
        if (details.collection) {
            return `Install ${details.collection}`;
        }
        // Fallback to first ~50 chars of summary
        const summary = (details.summary as string) || '';
        return summary.substring(0, 50) + (summary.length > 50 ? '...' : '');
    }

    /**
     * Render a history entry
     */
    private _renderHistoryEntry(entry: { entry_type: string; content: string; by: string; created_at: string }): string {
        const isAgent = entry.by === 'agent';
        const typeLabels: Record<string, string> = {
            proposed: 'Proposed',
            comment: 'You',
            revised: 'Revised',
            approved: 'Approved',
            rejected: 'Rejected'
        };
        
        return `
            <div class="history-entry ${entry.entry_type} ${isAgent ? 'agent' : 'user'}">
                <span class="history-label">${typeLabels[entry.entry_type] || entry.entry_type}</span>
                <span class="history-content">${this._escapeHtml(entry.content)}</span>
            </div>
        `;
    }

    /**
     * Get design decision tooltips from database
     */
    private _getDesignDecisionTooltips(decisionIds: string[]): Record<string, string> {
        const tooltips: Record<string, string> = {};
        for (const id of decisionIds) {
            try {
                // Use question_id field, not id (which is auto-increment integer)
                const decision = this._db.get<{ question: string; answer: string }>(
                    `SELECT question, answer FROM design_decisions WHERE question_id = ?`, id
                );
                if (decision) {
                    const answer = decision.answer || '(not answered)';
                    tooltips[id] = `${decision.question} → ${answer}`;
                } else {
                    tooltips[id] = `Decision ${id}`;
                }
            } catch (err) {
                console.error(`PlanningPanel: Error looking up decision ${id}:`, err);
                tooltips[id] = `Decision ${id}`;
            }
        }
        return tooltips;
    }

    /**
     * Escape HTML for safe rendering
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
        PlanningPanel._currentPanel = undefined;
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
