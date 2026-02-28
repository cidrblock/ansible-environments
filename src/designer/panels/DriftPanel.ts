/**
 * Ansible Content Designer - Drift Panel
 * 
 * Webview for reviewing drift assessments and resolving findings.
 */

import * as vscode from 'vscode';
import type { 
    DriftAssessment,
    DriftFinding,
    DriftStatus,
    DriftResolution,
    DriftReportItem
} from '../types/designer';
import { DesignerDatabase } from '../database/DesignerDatabase';
import { DriftAgent } from '../orchestrator/DriftAgent';
import { getZoomThemeScript } from '../../panels/webviewStyles';

/**
 * Status icons and colors
 */
const STATUS_CONFIG: Record<DriftStatus, { icon: string; color: string; label: string }> = {
    compliant: { icon: '✓', color: 'var(--vscode-testing-iconPassed)', label: 'Compliant' },
    partial: { icon: '◐', color: 'var(--vscode-inputValidation-warningBorder)', label: 'Partial' },
    drifted: { icon: '✗', color: 'var(--vscode-errorForeground)', label: 'Drifted' }
};

/**
 * Resolution labels
 */
const RESOLUTION_LABELS: Record<DriftResolution, string> = {
    pending: 'Pending',
    spec_updated: 'Spec Updated',
    regenerated: 'Regenerated',
    flagged: 'Flagged for Review',
    dismissed: 'Dismissed'
};

/**
 * DriftPanel - Webview for drift assessment
 */
export class DriftPanel {
    public static readonly viewType = 'ansibleContentDesigner.drift';
    
    private static _currentPanel: DriftPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private readonly _workspaceRoot: string;
    private _disposables: vscode.Disposable[] = [];
    private _db: DesignerDatabase;
    private _agent: DriftAgent;

    private constructor(
        panel: vscode.WebviewPanel, 
        extensionUri: vscode.Uri,
        workspaceRoot: string
    ) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._workspaceRoot = workspaceRoot;
        this._db = new DesignerDatabase(workspaceRoot);
        this._agent = new DriftAgent(this._db, workspaceRoot);

        this._initialize();
    }

    private async _initialize(): Promise<void> {
        await this._db.initialize();
        this._panel.webview.html = await this._getHtml();
        
        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'runAssessment':
                        await this._runAssessment();
                        break;
                    case 'resolveFinding':
                        await this._resolveFinding(message.id, message.resolution, message.note);
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
     * Show the drift panel
     */
    public static async show(extensionUri: vscode.Uri): Promise<DriftPanel | undefined> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            vscode.window.showErrorMessage('No workspace folder open');
            return undefined;
        }

        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (DriftPanel._currentPanel) {
            DriftPanel._currentPanel._panel.reveal(column);
            return DriftPanel._currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            DriftPanel.viewType,
            'Drift Assessment',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        DriftPanel._currentPanel = new DriftPanel(panel, extensionUri, workspaceRoot);
        return DriftPanel._currentPanel;
    }

    /**
     * Run a new drift assessment
     */
    private async _runAssessment(): Promise<void> {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Running drift assessment...',
            cancellable: false
        }, async () => {
            try {
                const result = await this._agent.assess();
                vscode.window.showInformationMessage(
                    `Assessment complete: ${result.overall_compliance}% compliance`
                );
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`Assessment failed: ${message}`);
            }
        });

        this._panel.webview.html = await this._getHtml();
    }

    /**
     * Resolve a drift finding
     */
    private async _resolveFinding(id: number, resolution: DriftResolution, note?: string): Promise<void> {
        this._agent.resolveFinding(id, resolution, note);
        vscode.window.showInformationMessage(`Finding resolved: ${RESOLUTION_LABELS[resolution]}`);
        this._panel.webview.html = await this._getHtml();
    }

    /**
     * Generate the HTML for the webview
     */
    private async _getHtml(): Promise<string> {
        const assessment = this._agent.getLatestAssessment();
        const findings = assessment ? this._agent.getFindings(assessment.id) : [];
        const staleArtifacts = this._agent.getStaleArtifacts();

        // Parse report from assessment
        let reportItems: DriftReportItem[] = [];
        if (assessment?.report) {
            try {
                reportItems = JSON.parse(assessment.report);
            } catch {
                // Ignore parse errors
            }
        }

        const pendingFindings = findings.filter(f => f.resolution === 'pending').length;

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Drift Assessment</title>
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
            margin-bottom: 24px;
        }
        
        .subtitle { color: var(--vscode-descriptionForeground); }
        
        .compliance-meter {
            display: flex;
            align-items: center;
            gap: 16px;
            margin-bottom: 24px;
            padding: 16px;
            background: var(--secondary-bg);
            border-radius: 8px;
        }
        
        .compliance-score {
            font-size: 2em;
            font-weight: 600;
        }
        
        .compliance-score.high { color: var(--success); }
        .compliance-score.medium { color: var(--warning); }
        .compliance-score.low { color: var(--error); }
        
        .compliance-bar {
            flex: 1;
            height: 12px;
            background: var(--bg);
            border-radius: 6px;
            overflow: hidden;
        }
        
        .compliance-fill {
            height: 100%;
            transition: width 0.3s;
        }
        
        .compliance-fill.high { background: var(--success); }
        .compliance-fill.medium { background: var(--warning); }
        .compliance-fill.low { background: var(--error); }
        
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
        
        button.secondary {
            background: transparent;
            color: var(--fg);
            border: 1px solid var(--input-border);
        }
        
        .section {
            background: var(--secondary-bg);
            border-radius: 8px;
            padding: 20px;
            margin-bottom: 24px;
        }
        
        .finding-card {
            background: var(--bg);
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 16px;
            margin-bottom: 12px;
        }
        
        .finding-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 12px;
        }
        
        .finding-req {
            font-weight: 600;
            color: var(--button-bg);
        }
        
        .finding-status {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 0.9em;
            padding: 2px 8px;
            border-radius: 4px;
        }
        
        .finding-summary {
            margin-bottom: 12px;
            color: var(--vscode-descriptionForeground);
        }
        
        .finding-details {
            margin-bottom: 12px;
        }
        
        .detail-row {
            display: flex;
            gap: 8px;
            padding: 4px 0;
            font-size: 0.9em;
        }
        
        .detail-icon { width: 16px; }
        .detail-icon.compliant { color: var(--success); }
        .detail-icon.noncompliant { color: var(--error); }
        
        .recommendations {
            background: color-mix(in srgb, var(--warning) 10%, transparent);
            padding: 12px;
            border-radius: 4px;
            margin-bottom: 12px;
        }
        
        .recommendations h4 {
            margin: 0 0 8px 0;
            font-size: 0.9em;
            color: var(--warning);
        }
        
        .recommendations ul {
            margin: 0;
            padding-left: 20px;
            font-size: 0.9em;
        }
        
        .finding-actions {
            display: flex;
            gap: 8px;
            margin-top: 12px;
            padding-top: 12px;
            border-top: 1px solid var(--border);
        }
        
        select {
            padding: 6px 8px;
            background: var(--input-bg);
            color: var(--fg);
            border: 1px solid var(--input-border);
            border-radius: 4px;
            font-size: inherit;
        }
        
        .empty-state {
            text-align: center;
            padding: 40px;
            color: var(--vscode-descriptionForeground);
        }
        
        .stale-warning {
            background: color-mix(in srgb, var(--warning) 15%, transparent);
            border: 1px solid var(--warning);
            border-radius: 8px;
            padding: 16px;
            margin-bottom: 24px;
        }
        
        .stale-warning h3 {
            margin: 0 0 8px 0;
            color: var(--warning);
        }
        
        .timestamp {
            font-size: 0.85em;
            color: var(--vscode-descriptionForeground);
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
            <h1>Drift Assessment</h1>
            <p class="subtitle">Check compliance between design and generated content</p>
        </div>
        <div style="display: flex; align-items: center;">
            ${assessment ? `
                <span class="timestamp">Last assessed: ${new Date(assessment.assessed_at).toLocaleString()}</span>
            ` : ''}
            <div class="view-controls">
                <button id="zoomOutBtn" title="Zoom out">−</button>
                <button id="zoomInBtn" title="Zoom in">+</button>
                <button id="themeBtn" title="Toggle theme">◐</button>
            </div>
        </div>
    </div>
    
    ${assessment ? `
        <div class="compliance-meter">
            <span class="compliance-score ${this._getComplianceClass(assessment.overall_compliance)}">
                ${assessment.overall_compliance}%
            </span>
            <div class="compliance-bar">
                <div class="compliance-fill ${this._getComplianceClass(assessment.overall_compliance)}" 
                     style="width: ${assessment.overall_compliance}%"></div>
            </div>
            <span>${assessment.compliant}/${assessment.total_requirements} compliant</span>
        </div>
    ` : ''}
    
    <div class="actions">
        <button class="primary" id="runAssessmentBtn">
            🔍 Run New Assessment
        </button>
    </div>
    
    ${staleArtifacts.length > 0 ? `
        <div class="stale-warning">
            <h3>⚠️ Stale Artifacts Detected</h3>
            <p>${staleArtifacts.length} artifact(s) may need regeneration:</p>
            <ul>
                ${staleArtifacts.map(a => `<li>${a.path} - ${a.stale_reason || 'Unknown reason'}</li>`).join('')}
            </ul>
        </div>
    ` : ''}
    
    ${!assessment ? `
        <div class="empty-state">
            <p>No drift assessment has been run yet.</p>
            <p>Click "Run New Assessment" to check compliance.</p>
        </div>
    ` : `
        <div class="section">
            <h2>Findings ${pendingFindings > 0 ? `(${pendingFindings} pending)` : ''}</h2>
            ${reportItems.length === 0 ? `
                <div class="empty-state">No findings recorded.</div>
            ` : reportItems.map((item, idx) => this._renderFindingCard(item, findings[idx])).join('')}
        </div>
    `}
    
    <script>
        const vscode = acquireVsCodeApi();
        
        // Run assessment
        document.getElementById('runAssessmentBtn').addEventListener('click', () => {
            vscode.postMessage({ command: 'runAssessment' });
        });
        
        // Resolve finding
        document.querySelectorAll('.resolve-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const select = btn.previousElementSibling;
                vscode.postMessage({ 
                    command: 'resolveFinding',
                    id: parseInt(btn.dataset.id),
                    resolution: select.value
                });
            });
        });
        
        // Zoom/Theme controls
        ${getZoomThemeScript('drift')}
    </script>
    </div>
</body>
</html>`;
    }

    /**
     * Get compliance class for styling
     */
    private _getComplianceClass(compliance: number): string {
        if (compliance >= 80) return 'high';
        if (compliance >= 50) return 'medium';
        return 'low';
    }

    /**
     * Render a finding card
     */
    private _renderFindingCard(item: DriftReportItem, finding?: DriftFinding): string {
        const config = STATUS_CONFIG[item.status];
        const isResolved = finding?.resolution && finding.resolution !== 'pending';

        return `
            <div class="finding-card">
                <div class="finding-header">
                    <span class="finding-req">${item.requirement_id}</span>
                    <span class="finding-status" style="background: color-mix(in srgb, ${config.color} 20%, transparent); color: ${config.color}">
                        ${config.icon} ${config.label}
                    </span>
                </div>
                
                <div class="finding-summary">${this._escapeHtml(item.summary)}</div>
                
                ${item.details.length > 0 ? `
                    <div class="finding-details">
                        ${item.details.map(d => `
                            <div class="detail-row">
                                <span class="detail-icon ${d.compliant ? 'compliant' : 'noncompliant'}">
                                    ${d.compliant ? '✓' : '✗'}
                                </span>
                                <span>${this._escapeHtml(d.decision)}</span>
                            </div>
                        `).join('')}
                    </div>
                ` : ''}
                
                ${item.recommendations.length > 0 ? `
                    <div class="recommendations">
                        <h4>Recommendations</h4>
                        <ul>
                            ${item.recommendations.map(r => `<li>${this._escapeHtml(r)}</li>`).join('')}
                        </ul>
                    </div>
                ` : ''}
                
                ${finding && !isResolved && item.status !== 'compliant' ? `
                    <div class="finding-actions">
                        <select>
                            <option value="spec_updated">Update Specification</option>
                            <option value="regenerated">Regenerate Content</option>
                            <option value="flagged">Flag for Review</option>
                            <option value="dismissed">Dismiss</option>
                        </select>
                        <button class="secondary resolve-btn" data-id="${finding.id}">
                            Resolve
                        </button>
                    </div>
                ` : isResolved ? `
                    <div class="finding-actions">
                        <span>Resolved: ${RESOLUTION_LABELS[finding?.resolution || 'pending']}</span>
                    </div>
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
        DriftPanel._currentPanel = undefined;
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
