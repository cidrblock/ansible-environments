/**
 * Ansible Content Designer - Project Init Panel
 * 
 * Simplified webview for creating a new Content Designer project.
 * Just asks for project name - the agent determines project structure during assessment.
 */

import * as vscode from 'vscode';
import { DesignerDatabase } from '../database/DesignerDatabase';
import { getZoomThemeScript } from '../../panels/webviewStyles';

/**
 * ProjectInitPanel - Webview for project creation
 */
export class ProjectInitPanel {
    public static readonly viewType = 'ansibleContentDesigner.projectInit';
    
    private static _currentPanel: ProjectInitPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;

        this._panel.webview.html = this._getHtml();
        
        // Handle messages from webview
        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'createProject':
                        await this._createProject(message.data);
                        break;
                    case 'cancel':
                        this._panel.dispose();
                        break;
                }
            },
            null,
            this._disposables
        );

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    }

    /**
     * Show the project init panel
     */
    public static show(extensionUri: vscode.Uri): ProjectInitPanel {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (ProjectInitPanel._currentPanel) {
            ProjectInitPanel._currentPanel._panel.reveal(column);
            return ProjectInitPanel._currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            ProjectInitPanel.viewType,
            'New Content Designer Project',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        ProjectInitPanel._currentPanel = new ProjectInitPanel(panel, extensionUri);
        return ProjectInitPanel._currentPanel;
    }

    /**
     * Create a new project
     * 
     * Simplified: just project name and description.
     * Agent determines project structure during assessment based on requirements.
     */
    private async _createProject(data: { 
        projectName: string; 
        description: string;
    }): Promise<void> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            vscode.window.showErrorMessage('No workspace folder open');
            return;
        }

        try {
            // Initialize database
            const db = new DesignerDatabase(workspaceRoot);
            await db.initialize();

            // Use project name for both name and namespace initially
            // Agent will refine during assessment
            const projectName = data.projectName.toLowerCase().replace(/[^a-z0-9_]/g, '_');

            // Insert project record with 'playbook_collection' as default
            // The agent will determine actual structure during build
            db.run(`
                INSERT INTO project (id, name, namespace, type, description, phase)
                VALUES (1, ?, ?, 'playbook_collection', ?, 'intake')
            `, projectName, projectName, data.description || '');

            // Log creation
            db.logHistory('project_created', 'project', '1', undefined, {
                name: projectName,
                description: data.description
            });

            // Inject system requirements (SYS-*) - operational guidance for the agent
            // These are ordered logically as a workflow the agent should follow
            // 
            // The agent uses get_project_requirements(include_system: true) to retrieve these
            // and treats them as operational instructions, NOT requirements to generate questions for.
            const systemRequirements = [
                // === Phase 1: Context Gathering (do this FIRST) ===
                {
                    id: 'SYS-001',
                    description: 'FIRST: Call get_project_requirements to retrieve all user requirements (REQ-*) and system guidance (SYS-*) before taking any action',
                    tags: ['system', 'context', 'phase-1']
                },
                {
                    id: 'SYS-002',
                    description: 'Call get_ansible_best_practices to retrieve Ansible conventions and coding standards - use these to inform assessment questions, design decisions, and content generation',
                    tags: ['system', 'context', 'best-practices', 'phase-1']
                },
                {
                    id: 'SYS-003',
                    description: 'Call get_design_decisions to retrieve any existing assessment answers and design choices that inform the current task',
                    tags: ['system', 'context', 'phase-1']
                },

                // === Phase 2: Structure & Planning ===
                {
                    id: 'SYS-004',
                    description: 'Call get_ansible_creator_schema to understand what project types and content structures can be scaffolded (playbook, collection, roles, plugins)',
                    tags: ['system', 'planning', 'phase-2']
                },
                {
                    id: 'SYS-005',
                    description: 'Determine the appropriate project structure (playbook project, collection, or playbook with adjacent collection) based on user requirements before scaffolding',
                    tags: ['system', 'planning', 'architecture', 'phase-2']
                },

                // === Phase 3: Scaffolding ===
                {
                    id: 'SYS-006',
                    description: 'Scaffold the project structure using create_ansible_project with the correct parameters based on the determined structure',
                    tags: ['system', 'scaffolding', 'phase-3']
                },
                {
                    id: 'SYS-007',
                    description: 'After scaffolding, review the workspace structure to identify where new content (roles, tasks, playbooks) should be authored to satisfy user requirements',
                    tags: ['system', 'scaffolding', 'review', 'phase-3']
                },
                {
                    id: 'SYS-008',
                    description: 'Remove any example or sample files generated by scaffolding that are not needed for the actual implementation',
                    tags: ['system', 'scaffolding', 'cleanup', 'phase-3']
                },

                // === Phase 4: Content Development ===
                {
                    id: 'SYS-009',
                    description: 'Use create_ansible_project to add roles, plugins, and other resources as needed to satisfy each user requirement - do not create files manually if creator can scaffold them',
                    tags: ['system', 'content', 'phase-4']
                },
                {
                    id: 'SYS-010',
                    description: 'Call get_plugin_documentation for any module before using it to ensure correct parameter usage and understand available options',
                    tags: ['system', 'content', 'documentation', 'phase-4']
                },
                {
                    id: 'SYS-011',
                    description: 'All tasks must use real Ansible module calls with proper parameters - never use ansible.builtin.debug as a placeholder for real functionality',
                    tags: ['system', 'content', 'quality', 'phase-4']
                },

                // === Phase 5: Assessment Quality ===
                {
                    id: 'SYS-012',
                    description: 'When generating assessment questions, prefer structured types (single_choice, yes_no, multi_choice) over free-text; use actual module parameter choices from plugin documentation as options',
                    tags: ['system', 'quality', 'assessment', 'phase-5']
                },
                {
                    id: 'SYS-013',
                    description: 'Generate 3-5 design questions for EACH user requirement (REQ-*), focusing on impactful design decisions that affect architecture, security, or compatibility',
                    tags: ['system', 'quality', 'assessment', 'phase-5']
                }
            ];

            for (const sysReq of systemRequirements) {
                db.run(`
                    INSERT INTO requirements (id, description, status, created_by)
                    VALUES (?, ?, 'draft', 'system')
                `, sysReq.id, sysReq.description);
                
                // Add tags
                for (const tag of sysReq.tags) {
                    db.run(`
                        INSERT OR IGNORE INTO requirement_tags (requirement_id, tag)
                        VALUES (?, ?)
                    `, sysReq.id, tag);
                }
            }

            db.close();

            vscode.window.showInformationMessage(
                `Content Designer project "${projectName}" created. Add your requirements!`
            );

            // Refresh tree view
            await vscode.commands.executeCommand('ansibleContentDesigner.refresh');

            // Close panel
            this._panel.dispose();

            // Open the Requirements panel automatically
            await vscode.commands.executeCommand('ansibleContentDesigner.openRequirements');

        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to create project: ${message}`);
        }
    }

    /**
     * Generate the HTML for the webview
     * 
     * Simplified: just project name and optional description.
     * The AI agent determines project structure during assessment.
     */
    private _getHtml(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>New Content Designer Project</title>
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
            max-width: 500px;
            margin: 0 auto;
        }
        
        h1 {
            font-size: 1.5em;
            margin-bottom: 8px;
            font-weight: 500;
        }
        
        .subtitle {
            color: var(--vscode-descriptionForeground);
            margin-bottom: 24px;
        }
        
        .form-group {
            margin-bottom: 20px;
        }
        
        label {
            display: block;
            margin-bottom: 6px;
            font-weight: 500;
        }
        
        .hint {
            color: var(--vscode-descriptionForeground);
            font-size: 0.9em;
            margin-top: 4px;
        }
        
        input[type="text"],
        textarea {
            width: 100%;
            max-width: 100%;
            padding: 10px 12px;
            background: var(--input-bg);
            color: var(--input-fg);
            border: 1px solid var(--input-border);
            border-radius: 4px;
            font-family: inherit;
            font-size: inherit;
            box-sizing: border-box;
        }
        
        input:focus,
        textarea:focus {
            outline: none;
            border-color: var(--focus);
        }
        
        textarea {
            min-height: 80px;
            resize: vertical;
        }
        
        .buttons {
            display: flex;
            gap: 12px;
            margin-top: 24px;
        }
        
        button {
            padding: 10px 20px;
            border: none;
            border-radius: 4px;
            font-size: inherit;
            cursor: pointer;
            transition: background 0.2s;
        }
        
        button.primary {
            background: var(--button-bg);
            color: var(--button-fg);
        }
        
        button.primary:hover {
            background: var(--button-hover);
        }
        
        button.primary:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        
        button.secondary {
            background: transparent;
            color: var(--fg);
            border: 1px solid var(--input-border);
        }
        
        button.secondary:hover {
            background: var(--secondary-bg);
        }
        
        .error {
            color: var(--vscode-errorForeground);
            font-size: 0.9em;
            margin-top: 4px;
            display: none;
        }
        
        .view-controls {
            display: flex;
            gap: 4px;
            align-items: center;
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
        
        .header {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            margin-bottom: 16px;
        }
        
        .info-box {
            background: var(--secondary-bg);
            border: 1px solid var(--border);
            border-radius: 6px;
            padding: 16px;
            margin-bottom: 24px;
        }
        
        .info-box h3 {
            font-size: 1em;
            margin: 0 0 8px 0;
            font-weight: 500;
        }
        
        .info-box ul {
            margin: 0;
            padding-left: 20px;
            color: var(--vscode-descriptionForeground);
            font-size: 0.9em;
        }
        
        .info-box li {
            margin: 4px 0;
        }
        
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
            <h1>New Content Designer Project</h1>
            <p class="subtitle">AI-assisted Ansible content design</p>
        </div>
        <div class="view-controls">
            <button id="zoomOutBtn" title="Zoom out">−</button>
            <button id="zoomInBtn" title="Zoom in">+</button>
            <button id="themeBtn" title="Toggle theme">◐</button>
        </div>
    </div>
    
    <div class="info-box">
        <h3>How it works</h3>
        <ul>
            <li>Provide a project name and describe what you want to build</li>
            <li>The AI agent will determine the project structure</li>
            <li>During assessment, you'll answer questions to refine the design</li>
            <li>The agent scaffolds and builds your content automatically</li>
        </ul>
    </div>
    
    <form id="projectForm">
        <div class="form-group">
            <label for="projectName">Project Name *</label>
            <input type="text" id="projectName" name="projectName" 
                placeholder="my_automation" 
                pattern="[a-zA-Z][a-zA-Z0-9_]*"
                required
                minlength="2"
                maxlength="50">
            <div class="hint">Lowercase letters, numbers, and underscores only</div>
            <div class="error" id="nameError">Project name is required</div>
        </div>
        
        <div class="form-group">
            <label for="description">Description (optional)</label>
            <textarea id="description" name="description" 
                placeholder="Brief description of what this automation will accomplish..."></textarea>
            <div class="hint">Describe the goal. You'll add detailed requirements next.</div>
        </div>
        
        <div class="buttons">
            <button type="submit" class="primary" id="createBtn">Create Project</button>
            <button type="button" class="secondary" id="cancelBtn">Cancel</button>
        </div>
    </form>
    
    <script>
        const vscode = acquireVsCodeApi();
        
        // Validate project name on input
        const nameInput = document.getElementById('projectName');
        const nameError = document.getElementById('nameError');
        
        nameInput.addEventListener('input', () => {
            const value = nameInput.value;
            const isValid = /^[a-zA-Z][a-zA-Z0-9_]*$/.test(value) || value === '';
            
            if (!isValid) {
                nameError.textContent = 'Only letters, numbers, and underscores allowed';
                nameError.style.display = 'block';
            } else {
                nameError.style.display = 'none';
            }
        });
        
        // Handle form submission
        document.getElementById('projectForm').addEventListener('submit', (e) => {
            e.preventDefault();
            
            const projectName = document.getElementById('projectName').value.trim();
            const description = document.getElementById('description').value.trim();
            
            if (!projectName) {
                nameError.textContent = 'Project name is required';
                nameError.style.display = 'block';
                return;
            }
            
            if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(projectName)) {
                nameError.textContent = 'Invalid project name';
                nameError.style.display = 'block';
                return;
            }
            
            vscode.postMessage({ 
                command: 'createProject', 
                data: { projectName, description }
            });
        });
        
        // Handle cancel
        document.getElementById('cancelBtn').addEventListener('click', () => {
            vscode.postMessage({ command: 'cancel' });
        });
        
        // Zoom/Theme controls
        ${getZoomThemeScript('projectInit')}
    </script>
    </div>
</body>
</html>`;
    }

    public dispose(): void {
        ProjectInitPanel._currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const disposable = this._disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }
}
