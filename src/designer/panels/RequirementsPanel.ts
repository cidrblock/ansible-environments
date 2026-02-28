/**
 * Ansible Content Designer - Requirements Panel
 * 
 * Webview for managing project requirements.
 * Simplified: no priority or implied artifacts (agent determines what to build).
 */

import * as vscode from 'vscode';
import type { EnrichedRequirement } from '../types/designer';
import { DesignerDatabase } from '../database/DesignerDatabase';
import { RequirementService } from '../services/RequirementService';
import { ProgressService } from '../services/ProgressService';
import { ExportService } from '../services/ExportService';
import { getZoomThemeScript } from '../../panels/webviewStyles';

/**
 * RequirementsPanel - Webview for managing requirements
 */
export class RequirementsPanel {
    public static readonly viewType = 'ansibleContentDesigner.requirements';
    
    private static _currentPanel: RequirementsPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private readonly _workspaceRoot: string;
    private _disposables: vscode.Disposable[] = [];
    private _db: DesignerDatabase;
    private _service: RequirementService;
    private _progressService: ProgressService;
    private _exportService: ExportService;

    private constructor(
        panel: vscode.WebviewPanel, 
        extensionUri: vscode.Uri,
        workspaceRoot: string
    ) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._workspaceRoot = workspaceRoot;
        this._db = new DesignerDatabase(workspaceRoot);
        this._service = new RequirementService(this._db);
        this._progressService = new ProgressService(this._db);
        this._exportService = new ExportService(this._db, workspaceRoot);

        this._initialize();
    }

    private async _initialize(): Promise<void> {
        await this._db.initialize();
        this._panel.webview.html = await this._getHtml();
        
        // Handle messages from webview
        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'addRequirement':
                        await this._addRequirement(message.data);
                        break;
                    case 'updateRequirement':
                        await this._updateRequirement(message.data);
                        break;
                    case 'deleteRequirement':
                        await this._deleteRequirement(message.id);
                        break;
                    case 'refresh':
                        this._panel.webview.html = await this._getHtml();
                        break;
                    case 'proceedToAssessment':
                        await this._proceedToAssessment();
                        break;
                }
            },
            null,
            this._disposables
        );

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    }

    /**
     * Show the requirements panel
     */
    public static async show(extensionUri: vscode.Uri): Promise<RequirementsPanel | undefined> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            vscode.window.showErrorMessage('No workspace folder open');
            return undefined;
        }

        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (RequirementsPanel._currentPanel) {
            RequirementsPanel._currentPanel._panel.reveal(column);
            return RequirementsPanel._currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            RequirementsPanel.viewType,
            'Requirements',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        RequirementsPanel._currentPanel = new RequirementsPanel(panel, extensionUri, workspaceRoot);
        return RequirementsPanel._currentPanel;
    }

    /**
     * Add a new requirement
     */
    private async _addRequirement(data: {
        description: string;
        tags: string;
    }): Promise<void> {
        try {
            const tags = data.tags.split(',').map(t => t.trim()).filter(t => t.length > 0);
            
            this._service.create({
                description: data.description,
                tags
            });

            // Auto-export for SCM visibility
            await this._triggerExport();

            vscode.window.showInformationMessage('Requirement added');
            this._panel.webview.html = await this._getHtml();
            await vscode.commands.executeCommand('ansibleContentDesigner.refresh');

        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to add requirement: ${message}`);
        }
    }

    /**
     * Trigger export to keep design docs in sync
     */
    private async _triggerExport(): Promise<void> {
        try {
            await this._exportService.exportAll();
        } catch (error) {
            console.error('Export failed:', error);
        }
    }

    /**
     * Update a requirement
     */
    private async _updateRequirement(data: {
        id: string;
        description: string;
        tags: string;
    }): Promise<void> {
        try {
            const tags = data.tags.split(',').map(t => t.trim()).filter(t => t.length > 0);
            
            this._service.update(data.id, {
                description: data.description,
                tags
            });

            // Auto-export for SCM visibility
            await this._triggerExport();

            vscode.window.showInformationMessage('Requirement updated');
            this._panel.webview.html = await this._getHtml();
            await vscode.commands.executeCommand('ansibleContentDesigner.refresh');

        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to update requirement: ${message}`);
        }
    }

    /**
     * Delete a requirement
     */
    private async _deleteRequirement(id: string): Promise<void> {
        const confirm = await vscode.window.showWarningMessage(
            `Delete requirement ${id}?`,
            { modal: true },
            'Delete'
        );

        if (confirm !== 'Delete') {
            return;
        }

        try {
            this._service.delete(id);
            
            // Auto-export for SCM visibility
            await this._triggerExport();
            
            vscode.window.showInformationMessage('Requirement deleted');
            this._panel.webview.html = await this._getHtml();
            await vscode.commands.executeCommand('ansibleContentDesigner.refresh');

        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to delete requirement: ${message}`);
        }
    }

    /**
     * Proceed to assessment phase
     */
    private async _proceedToAssessment(): Promise<void> {
        const requirements = this._service.list();
        if (requirements.length === 0) {
            vscode.window.showWarningMessage('Add at least one requirement before proceeding');
            return;
        }

        try {
            // Advance from intake to assessment phase
            this._progressService.advancePhase('intake', 'user');
            
            // Refresh the tree view to show updated status
            await vscode.commands.executeCommand('ansibleContentDesigner.refresh');
            
            // Open assessment panel
            await vscode.commands.executeCommand('ansibleContentDesigner.openPhase', 'assessment');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Cannot proceed: ${message}`);
        }
    }

    /**
     * Generate the HTML for the webview
     */
    private async _getHtml(): Promise<string> {
        const allRequirements = this._service.list();
        // Split into user requirements (REQ-*) and system requirements (SYS-*)
        const userRequirements = allRequirements.filter(r => r.id.startsWith('REQ-'));
        const systemRequirements = allRequirements.filter(r => r.id.startsWith('SYS-'));
        const allTags = this._service.getAllTags();

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Requirements</title>
    <style>
        :root {
            --bg: var(--vscode-editor-background);
            --fg: var(--vscode-editor-foreground);
            --input-bg: var(--vscode-input-background);
            --input-fg: var(--vscode-input-foreground);
            --input-border: var(--vscode-input-border);
            --button-bg: var(--vscode-button-background);
            --button-fg: var(--vscode-button-foreground);
            --button-hover: var(--vscode-button-hoverBackground);
            --focus: var(--vscode-focusBorder);
            --secondary-bg: var(--vscode-sideBar-background);
            --border: var(--vscode-panel-border);
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
        
        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 24px;
        }
        
        .subtitle { color: var(--vscode-descriptionForeground); }
        
        .section {
            background: var(--secondary-bg);
            border-radius: 8px;
            padding: 20px;
            margin-bottom: 24px;
        }
        
        .section h2 { font-size: 1.1em; margin-bottom: 16px; font-weight: 500; }
        
        .form-group { margin-bottom: 16px; }
        
        .user-story-builder {
            background: var(--secondary-bg);
            border: 1px solid var(--border);
            border-radius: 6px;
            padding: 16px;
            margin-bottom: 12px;
        }
        
        .story-row {
            display: flex;
            align-items: flex-start;
            gap: 12px;
            margin-bottom: 12px;
        }
        
        .story-row:last-child { margin-bottom: 0; }
        
        .story-label {
            min-width: 60px;
            font-weight: 600;
            color: var(--vscode-textLink-foreground);
            padding-top: 8px;
        }
        
        .persona-select, .story-input {
            flex: 1;
            padding: 8px 10px;
            background: var(--input-bg);
            color: var(--input-fg);
            border: 1px solid var(--input-border);
            border-radius: 4px;
            font-family: inherit;
            font-size: 0.95em;
        }
        
        .story-input {
            resize: vertical;
            min-height: 60px;
        }
        
        .story-input.small { min-height: 40px; }
        
        .story-input:focus, .persona-select:focus {
            outline: none;
            border-color: var(--focus);
        }
        
        label { display: block; margin-bottom: 6px; font-weight: 500; }
        .hint { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin-top: 4px; }
        
        input[type="text"], textarea, select {
            width: 100%;
            padding: 8px;
            background: var(--input-bg);
            color: var(--input-fg);
            border: 1px solid var(--input-border);
            border-radius: 4px;
            font-family: inherit;
            font-size: inherit;
        }
        
        .checkbox-group { display: flex; flex-wrap: wrap; gap: 12px; }
        .checkbox-item { display: flex; align-items: center; gap: 6px; }
        .checkbox-item input[type="checkbox"] { width: auto; }
        
        button {
            padding: 8px 16px;
            border: none;
            border-radius: 4px;
            font-size: inherit;
            cursor: pointer;
            transition: background 0.2s;
        }
        
        button.primary { background: var(--button-bg); color: var(--button-fg); }
        button.primary:hover { background: var(--button-hover); }
        button.secondary { background: transparent; color: var(--fg); border: 1px solid var(--input-border); }
        button.small { padding: 2px 8px; font-size: 0.8em; }
        
        table { width: 100%; border-collapse: collapse; font-size: 0.9em; }
        th { text-align: left; padding: 8px; background: var(--secondary-bg); border-bottom: 1px solid var(--border); font-weight: 500; }
        td { padding: 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
        tr:hover { background: var(--secondary-bg); }
        
        .req-id { font-weight: 600; color: var(--button-bg); }
        .tag-badge { font-size: 0.75em; padding: 1px 4px; border-radius: 2px; background: var(--secondary-bg); margin-right: 4px; }
        
        .icon-btn {
            background: transparent;
            border: none;
            color: var(--vscode-descriptionForeground);
            cursor: pointer;
            padding: 2px 4px;
            font-size: 1em;
        }
        .icon-btn:hover { color: var(--fg); }
        
        .editing-notice {
            background: var(--secondary-bg);
            padding: 8px 12px;
            border-radius: 4px;
            margin-bottom: 12px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        
        .proceed-section {
            display: flex;
            justify-content: flex-end;
            gap: 12px;
            margin-top: 24px;
        }
        
        .view-controls { display: flex; gap: 4px; align-items: center; }
        .view-controls button {
            background: var(--secondary-bg);
            border: 1px solid var(--border);
            color: var(--fg);
            padding: 2px 6px;
            border-radius: 3px;
        }
        
        .container { zoom: 1; }
        
        body.theme-light {
            --bg: #ffffff; --fg: #333333; --secondary-bg: #f5f5f5;
            --border: #e0e0e0; --input-bg: #ffffff; --input-fg: #333333; --input-border: #cccccc;
        }
        
        body.theme-dark {
            --bg: #1e1e1e; --fg: #cccccc; --secondary-bg: #252526;
            --border: #3c3c3c; --input-bg: #3c3c3c; --input-fg: #cccccc; --input-border: #5a5a5a;
        }
        
        /* System Requirements Section */
        .system-section { 
            background: var(--secondary-bg);
            opacity: 0.85;
        }
        .system-section h2 { 
            cursor: pointer; 
            user-select: none;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .sys-hint {
            font-size: 0.75em;
            font-weight: 400;
            color: var(--vscode-descriptionForeground);
            font-style: italic;
        }
        .system-table { font-size: 0.85em; }
        .system-row { color: var(--vscode-descriptionForeground); }
        .sys-id { 
            font-weight: 500; 
            color: var(--vscode-descriptionForeground);
            font-family: monospace;
        }
        .sys-desc { font-style: italic; }
        .sys-category {
            font-size: 0.8em;
            padding: 2px 6px;
            border-radius: 3px;
            background: var(--border);
        }
        .collapsible #sysToggle {
            display: inline-block;
            transition: transform 0.2s;
        }
        .collapsible.expanded #sysToggle {
            transform: rotate(90deg);
        }
    </style>
</head>
<body>
    <div class="container">
    <div class="header">
        <div>
            <h1>Requirements</h1>
            <p class="subtitle">Define what your automation needs to accomplish</p>
        </div>
        <div style="display: flex; align-items: center; gap: 12px;">
            <span>${userRequirements.length} requirement${userRequirements.length !== 1 ? 's' : ''}</span>
            <div class="view-controls">
                <button id="zoomOutBtn" title="Zoom out">−</button>
                <button id="zoomInBtn" title="Zoom in">+</button>
                <button id="themeBtn" title="Toggle theme">◐</button>
            </div>
        </div>
    </div>
    
    <div class="section">
        <div id="editNotice" class="editing-notice" style="display: none;">
            <span>Editing: <strong id="editingId"></strong></span>
            <button type="button" class="secondary small" id="cancelEditBtn">Cancel</button>
        </div>
        <h2 id="formTitle">Add New Requirement</h2>
        <form id="addForm">
            <input type="hidden" id="editId" name="editId" value="">
            
            <div class="user-story-builder">
                <div class="story-row">
                    <span class="story-label">As a</span>
                    <select id="persona" name="persona" class="persona-select">
                        <option value="operator">Platform Operator</option>
                        <option value="developer">Developer</option>
                        <option value="architect">Architect</option>
                        <option value="security">Security Engineer</option>
                        <option value="sre">SRE / DevOps Engineer</option>
                        <option value="admin">System Administrator</option>
                        <option value="other">Other (specify below)</option>
                    </select>
                </div>
                
                <div class="story-row">
                    <span class="story-label">I want</span>
                    <textarea id="description" name="description" class="story-input"
                        placeholder="automation that provisions and configures web servers with proper SSL certificates..."
                        required minlength="20"></textarea>
                </div>
                
                <div class="story-row">
                    <span class="story-label">So that</span>
                    <textarea id="benefit" name="benefit" class="story-input small"
                        placeholder="(optional) I can deploy secure applications without manual configuration..."></textarea>
                </div>
            </div>
            <div class="hint">Describe the outcome you need. The agent will determine what to build.</div>
            
            <div class="form-group">
                <label>Tags</label>
                ${allTags.length > 0 ? `
                    <div class="checkbox-group" style="margin-bottom: 8px;">
                        ${allTags.map(tag => `
                            <label class="checkbox-item">
                                <input type="checkbox" name="existingTags" value="${tag}">
                                #${tag}
                            </label>
                        `).join('')}
                    </div>
                ` : ''}
                <input type="text" id="newTags" name="newTags" placeholder="Add new tags (comma-separated)">
                <div class="hint">Tags help organize requirements</div>
            </div>
            
            <button type="submit" class="primary" id="submitBtn">Add Requirement</button>
        </form>
    </div>
    
    ${userRequirements.length > 0 ? `
    <div class="section">
        <h2>Your Requirements (${userRequirements.length})</h2>
        <table>
            <thead>
                <tr>
                    <th style="width: 80px;">ID</th>
                    <th>Description</th>
                    <th style="width: 120px;">Tags</th>
                    <th style="width: 60px;"></th>
                </tr>
            </thead>
            <tbody>
                ${userRequirements.map(req => this._renderRequirementRow(req)).join('')}
            </tbody>
        </table>
        <div class="proceed-section">
            <button type="button" class="primary" id="proceedBtn">
                Proceed to Assessment →
            </button>
        </div>
    </div>
    ` : ''}
    
    ${systemRequirements.length > 0 ? `
    <div class="section system-section">
        <h2 class="collapsible" onclick="toggleSystemReqs()">
            <span id="sysToggle">▸</span> System Requirements (${systemRequirements.length})
            <span class="sys-hint">Agent operational guidance</span>
        </h2>
        <div id="systemReqsContent" style="display: none;">
            <table class="system-table">
                <thead>
                    <tr>
                        <th style="width: 80px;">ID</th>
                        <th>Guidance</th>
                        <th style="width: 100px;">Category</th>
                    </tr>
                </thead>
                <tbody>
                    ${systemRequirements.map(req => this._renderSystemRequirementRow(req)).join('')}
                </tbody>
            </table>
        </div>
    </div>
    ` : ''}
    
    <script>
        const vscode = acquireVsCodeApi();
        
        const PERSONA_LABELS = {
            'operator': 'Platform Operator',
            'developer': 'Developer',
            'architect': 'Architect',
            'security': 'Security Engineer',
            'sre': 'SRE / DevOps Engineer',
            'admin': 'System Administrator',
            'other': 'Other'
        };
        
        document.getElementById('addForm').addEventListener('submit', (e) => {
            e.preventDefault();
            const formData = new FormData(e.target);
            const editId = formData.get('editId');
            
            // Build full description from user story components
            const persona = formData.get('persona');
            const personaLabel = PERSONA_LABELS[persona] || persona;
            const wantText = formData.get('description')?.trim() || '';
            const benefitText = formData.get('benefit')?.trim() || '';
            
            let fullDescription = 'As a ' + personaLabel + ', I want ' + wantText;
            if (benefitText) {
                fullDescription += ', so that ' + benefitText;
            }
            
            // Collect tags
            const existingTags = formData.getAll('existingTags');
            const newTagsStr = formData.get('newTags') || '';
            const newTags = newTagsStr.split(',').map(t => t.trim()).filter(t => t.length > 0);
            const allTags = [...existingTags, ...newTags].join(',');
            
            if (editId) {
                vscode.postMessage({
                    command: 'updateRequirement',
                    data: { id: editId, description: fullDescription, tags: allTags }
                });
            } else {
                vscode.postMessage({
                    command: 'addRequirement',
                    data: { description: fullDescription, tags: allTags }
                });
            }
        });
        
        // Edit requirement
        document.querySelectorAll('.edit-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const req = JSON.parse(decodeURIComponent(btn.dataset.req));
                
                document.getElementById('editId').value = req.id;
                
                // Parse description back into components
                let persona = 'developer';
                let wantText = req.description;
                let benefitText = '';
                
                const asAMatch = req.description.match(/^As a ([^,]+), I want (.+)/i);
                if (asAMatch) {
                    const personaText = asAMatch[1].trim();
                    let remainder = asAMatch[2];
                    
                    const personaMap = {
                        'platform operator': 'operator',
                        'developer': 'developer',
                        'architect': 'architect',
                        'security engineer': 'security',
                        'sre / devops engineer': 'sre',
                        'system administrator': 'admin'
                    };
                    persona = personaMap[personaText.toLowerCase()] || 'other';
                    
                    const soThatMatch = remainder.match(/(.+),\\s*so that\\s+(.+)/i);
                    if (soThatMatch) {
                        wantText = soThatMatch[1].trim();
                        benefitText = soThatMatch[2].trim();
                    } else {
                        wantText = remainder.trim();
                    }
                }
                
                document.getElementById('persona').value = persona;
                document.getElementById('description').value = wantText;
                document.getElementById('benefit').value = benefitText;
                
                // Check existing tag checkboxes
                document.querySelectorAll('input[name="existingTags"]').forEach(cb => {
                    cb.checked = req.tags.includes(cb.value);
                });
                
                document.getElementById('editNotice').style.display = 'flex';
                document.getElementById('editingId').textContent = req.id;
                document.getElementById('formTitle').textContent = 'Edit Requirement';
                document.getElementById('submitBtn').textContent = 'Update Requirement';
                
                document.getElementById('addForm').scrollIntoView({ behavior: 'smooth' });
            });
        });
        
        // Cancel edit
        document.getElementById('cancelEditBtn')?.addEventListener('click', () => {
            document.getElementById('editId').value = '';
            document.getElementById('addForm').reset();
            document.getElementById('persona').value = 'operator';
            document.getElementById('benefit').value = '';
            document.getElementById('editNotice').style.display = 'none';
            document.getElementById('formTitle').textContent = 'Add New Requirement';
            document.getElementById('submitBtn').textContent = 'Add Requirement';
        });
        
        // Delete requirement
        document.querySelectorAll('.delete-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                vscode.postMessage({ command: 'deleteRequirement', id: btn.dataset.id });
            });
        });
        
        // Proceed to assessment
        document.getElementById('proceedBtn')?.addEventListener('click', () => {
            vscode.postMessage({ command: 'proceedToAssessment' });
        });
        
        // Toggle system requirements section
        function toggleSystemReqs() {
            const content = document.getElementById('systemReqsContent');
            const toggle = document.getElementById('sysToggle');
            const header = toggle?.closest('h2');
            if (content && toggle) {
                const isHidden = content.style.display === 'none';
                content.style.display = isHidden ? 'block' : 'none';
                toggle.textContent = isHidden ? '▾' : '▸';
                header?.classList.toggle('expanded', isHidden);
            }
        }
        // Expose to global scope for onclick
        window.toggleSystemReqs = toggleSystemReqs;
        
        ${getZoomThemeScript('requirements')}
    </script>
    </div>
</body>
</html>`;
    }

    /**
     * Render a requirement as a table row
     */
    private _renderRequirementRow(req: EnrichedRequirement): string {
        const reqData = encodeURIComponent(JSON.stringify({
            id: req.id,
            description: req.description,
            tags: req.tags
        }));
        
        return `
            <tr>
                <td><span class="req-id">${req.id}</span></td>
                <td>${this._escapeHtml(req.description.substring(0, 120))}${req.description.length > 120 ? '...' : ''}</td>
                <td>${req.tags.map(t => `<span class="tag-badge">#${t}</span>`).join('')}</td>
                <td>
                    <button class="icon-btn edit-btn" data-req="${reqData}" title="Edit">✎</button>
                    <button class="icon-btn delete-btn" data-id="${req.id}" title="Delete">✕</button>
                </td>
            </tr>
        `;
    }

    /**
     * Render a system requirement row (read-only, no edit/delete)
     */
    private _renderSystemRequirementRow(req: EnrichedRequirement): string {
        // Extract category from first tag (system tags are like 'system', 'best-practices', etc.)
        const category = req.tags.find(t => t !== 'system') || 'general';
        
        return `
            <tr class="system-row">
                <td><span class="sys-id">${req.id}</span></td>
                <td class="sys-desc">${this._escapeHtml(req.description)}</td>
                <td><span class="sys-category">${category}</span></td>
            </tr>
        `;
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
        RequirementsPanel._currentPanel = undefined;
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
