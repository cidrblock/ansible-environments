import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import { PythonEnvironmentApi } from '../types/pythonEnvApi';

interface PluginOption {
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

interface PluginDoc {
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

interface PluginReturn {
    [key: string]: {
        description?: string | string[];
        returned?: string;
        type?: string;
        sample?: unknown;
        contains?: { [key: string]: unknown };
    };
}

interface PluginData {
    doc?: PluginDoc;
    examples?: string;
    return?: PluginReturn;
    metadata?: unknown;
}

// Helper to normalize string or string[] to string[]
function toArray(value: string | string[] | undefined): string[] {
    if (!value) {return [];}
    if (Array.isArray(value)) {return value;}
    return [value];
}

export class PluginDocPanel {
    public static currentPanel: PluginDocPanel | undefined;
    public static readonly viewType = 'pluginDocPanel';

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];

    public static async show(
        extensionUri: vscode.Uri,
        pluginFullName: string,
        pluginType: string
    ) {
        const column = vscode.ViewColumn.One;

        // Close existing panel if showing different plugin
        if (PluginDocPanel.currentPanel) {
            PluginDocPanel.currentPanel._panel.dispose();
        }

        const panel = vscode.window.createWebviewPanel(
            PluginDocPanel.viewType,
            `${pluginFullName}`,
            column,
            {
                enableScripts: true,
                localResourceRoots: [extensionUri]
            }
        );

        PluginDocPanel.currentPanel = new PluginDocPanel(panel, extensionUri);
        await PluginDocPanel.currentPanel._loadPluginDoc(pluginFullName, pluginType);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    }

    private async _loadPluginDoc(pluginFullName: string, pluginType: string) {
        this._panel.webview.html = this._getLoadingHtml();

        try {
            const pythonEnvExtension = vscode.extensions.getExtension<PythonEnvironmentApi>('ms-python.vscode-python-envs');
            if (!pythonEnvExtension) {
                this._panel.webview.html = this._getErrorHtml('Python Environments extension not found');
                return;
            }

            if (!pythonEnvExtension.isActive) {
                await pythonEnvExtension.activate();
            }

            const api = pythonEnvExtension.exports;
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
            const environment = await api.getEnvironment(workspaceFolder);

            if (!environment) {
                this._panel.webview.html = this._getErrorHtml('No Python environment selected');
                return;
            }

            const executable = environment.execInfo?.run?.executable;
            if (!executable) {
                this._panel.webview.html = this._getErrorHtml('Could not find Python executable');
                return;
            }

            const envBinDir = path.dirname(executable);
            const ansibleDocPath = path.join(envBinDir, 'ansible-doc');

            // Map plugin types to ansible-doc type flag
            const typeFlag = this._getTypeFlag(pluginType);

            const result = await new Promise<string>((resolve, reject) => {
                cp.exec(
                    `"${ansibleDocPath}" ${typeFlag} "${pluginFullName}" --json`,
                    { maxBuffer: 10 * 1024 * 1024 },
                    (error, stdout, stderr) => {
                        if (error) {
                            reject(error);
                            return;
                        }
                        resolve(stdout);
                    }
                );
            });

            const data = JSON.parse(result);
            const pluginData: PluginData = data[pluginFullName];

            if (!pluginData || !pluginData.doc) {
                this._panel.webview.html = this._getErrorHtml('Plugin documentation not found');
                return;
            }

            this._panel.webview.html = this._getDocHtml(pluginFullName, pluginType, pluginData);
        } catch (error) {
            this._panel.webview.html = this._getErrorHtml(`Failed to load documentation: ${error}`);
        }
    }

    private _getTypeFlag(pluginType: string): string {
        // ansible-doc uses -t for type
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

    private _getLoadingHtml(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Loading...</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            padding: 40px;
            color: var(--vscode-foreground);
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 200px;
        }
        .loader {
            text-align: center;
        }
        .spinner {
            width: 40px;
            height: 40px;
            border: 3px solid var(--vscode-editor-foreground);
            border-top-color: transparent;
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin: 0 auto 16px;
        }
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
    </style>
</head>
<body>
    <div class="loader">
        <div class="spinner"></div>
        <div>Loading documentation...</div>
    </div>
</body>
</html>`;
    }

    private _getErrorHtml(message: string): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Error</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            padding: 40px;
            color: var(--vscode-errorForeground);
        }
    </style>
</head>
<body>
    <h2>Error</h2>
    <p>${this._escapeHtml(message)}</p>
</body>
</html>`;
    }

    private _getDocHtml(pluginFullName: string, pluginType: string, data: PluginData): string {
        const doc = data.doc!;
        const parts = pluginFullName.split('.');
        const namespace = parts[0];
        const collection = parts[1];
        const pluginName = parts.slice(2).join('.');

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${pluginFullName}</title>
    <style>
        :root {
            --bg: #0d0d0d;
            --surface: #161616;
            --surface-light: #1e1e1e;
            --border: #333;
            --text: #e0e0e0;
            --text-muted: #888;
            --text-dim: #666;
            --accent: #fff;
            --code-bg: #0a0a0a;
            --required: #e57373;
            --success: #81c784;
        }
        
        * { box-sizing: border-box; margin: 0; padding: 0; }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            font-size: 13px;
            background: var(--bg);
            color: var(--text);
            line-height: 1.5;
        }
        
        .container { max-width: 960px; margin: 0 auto; padding: 16px; }
        
        /* Breadcrumb */
        .breadcrumb {
            font-size: 11px;
            color: var(--text-dim);
            margin-bottom: 12px;
        }
        .breadcrumb-separator { margin: 0 4px; }
        
        /* Header */
        .header {
            border-bottom: 1px solid var(--border);
            padding-bottom: 12px;
            margin-bottom: 16px;
        }
        .header-title {
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .header-title h1 {
            font-size: 18px;
            font-weight: 600;
            font-family: 'SFMono-Regular', Consolas, monospace;
        }
        .plugin-type-badge {
            background: var(--surface-light);
            border: 1px solid var(--border);
            color: var(--text-muted);
            padding: 2px 8px;
            border-radius: 3px;
            font-size: 10px;
            font-weight: 500;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        .short-desc {
            color: var(--text-muted);
            font-size: 12px;
            margin-top: 6px;
        }
        .version-info {
            font-size: 11px;
            color: var(--text-dim);
            margin-top: 4px;
        }
        
        /* Navigation tabs */
        .nav-tabs {
            display: flex;
            gap: 0;
            border-bottom: 1px solid var(--border);
            margin-bottom: 16px;
        }
        .nav-tab {
            padding: 8px 14px;
            font-size: 12px;
            color: var(--text-muted);
            border-bottom: 2px solid transparent;
            margin-bottom: -1px;
            cursor: pointer;
        }
        .nav-tab:hover { color: var(--text); }
        .nav-tab.active {
            color: var(--accent);
            border-bottom-color: var(--accent);
        }
        
        /* Sections */
        .section { margin-bottom: 20px; }
        .section-title {
            font-size: 14px;
            font-weight: 600;
            margin-bottom: 10px;
            color: var(--text);
        }
        
        /* Synopsis */
        .synopsis {
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 4px;
            padding: 12px;
            font-size: 12px;
        }
        .synopsis ul { margin: 0; padding-left: 16px; }
        .synopsis li { margin-bottom: 4px; }
        
        /* Parameters - Tree Style */
        .param-tree { font-size: 12px; }
        
        .param-item {
            border-bottom: 1px solid var(--border);
            padding: 8px 0;
        }
        .param-item:last-child { border-bottom: none; }
        
        .param-header {
            display: flex;
            align-items: flex-start;
            gap: 8px;
            cursor: pointer;
            user-select: none;
        }
        .param-toggle {
            width: 14px;
            height: 14px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 10px;
            color: var(--text-dim);
            flex-shrink: 0;
            margin-top: 2px;
        }
        .param-toggle:empty { visibility: hidden; }
        
        .param-name {
            font-family: 'SFMono-Regular', Consolas, monospace;
            font-weight: 600;
            color: var(--text);
        }
        .param-type {
            font-size: 11px;
            color: var(--text-dim);
            font-family: monospace;
        }
        .param-required {
            color: var(--required);
            font-size: 10px;
            font-weight: 600;
        }
        
        .param-meta {
            display: flex;
            gap: 12px;
            margin-top: 4px;
            margin-left: 22px;
        }
        .param-desc {
            color: var(--text-muted);
            margin-top: 4px;
            margin-left: 22px;
            font-size: 12px;
        }
        .param-desc p { margin: 0 0 4px 0; }
        
        .param-choices {
            margin-top: 4px;
            margin-left: 22px;
        }
        .param-choice {
            display: inline-block;
            background: var(--code-bg);
            border: 1px solid var(--border);
            padding: 1px 6px;
            border-radius: 3px;
            font-family: monospace;
            font-size: 11px;
            margin-right: 4px;
            margin-bottom: 2px;
        }
        .param-choice.default {
            border-color: var(--success);
            color: var(--success);
        }
        
        .param-default {
            font-size: 11px;
            color: var(--success);
        }
        
        /* Suboptions */
        .suboptions {
            margin-left: 22px;
            margin-top: 8px;
            padding-left: 12px;
            border-left: 1px solid var(--border);
            display: none;
        }
        .suboptions.expanded { display: block; }
        
        /* Notes */
        .notes {
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 4px;
            padding: 12px;
            font-size: 12px;
        }
        .notes ul { margin: 0; padding-left: 16px; }
        .notes li { margin-bottom: 4px; }
        
        /* Examples */
        .example-section {
            margin-bottom: 16px;
        }
        .example-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            background: var(--surface);
            border: 1px solid var(--border);
            border-bottom: none;
            border-radius: 4px 4px 0 0;
            padding: 8px 12px;
        }
        .example-title {
            font-weight: 600;
            font-size: 12px;
            color: var(--text);
        }
        .example-copy-btn {
            background: var(--surface-light);
            border: 1px solid var(--border);
            color: var(--text-muted);
            padding: 4px 10px;
            border-radius: 3px;
            font-size: 11px;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 4px;
        }
        .example-copy-btn:hover {
            background: var(--border);
            color: var(--text);
        }
        .example-copy-btn.copied {
            color: var(--success);
            border-color: var(--success);
        }
        .example-code {
            background: var(--code-bg);
            border: 1px solid var(--border);
            border-radius: 0 0 4px 4px;
            padding: 12px;
            overflow-x: auto;
            margin: 0;
        }
        .example-code pre {
            font-family: 'SFMono-Regular', Consolas, monospace;
            font-size: 12px;
            line-height: 1.5;
            white-space: pre;
            color: var(--text);
            margin: 0;
        }
        .example-context {
            background: var(--surface);
            border: 1px solid var(--border);
            border-top: none;
            padding: 10px 12px;
            font-size: 11px;
            color: var(--text-dim);
            font-family: 'SFMono-Regular', Consolas, monospace;
            white-space: pre-wrap;
        }
        .example-context:first-of-type {
            border-radius: 4px 4px 0 0;
            border-top: 1px solid var(--border);
        }
        .example-context-label {
            font-weight: 600;
            color: var(--text-muted);
            margin-bottom: 4px;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        }
        
        /* YAML Syntax Highlighting */
        .yaml-key { color: #9cdcfe; }
        .yaml-string { color: #ce9178; }
        .yaml-number { color: #b5cea8; }
        .yaml-bool { color: #569cd6; }
        .yaml-null { color: #569cd6; }
        .yaml-comment { color: #6a9955; font-style: italic; }
        .yaml-list-marker { color: #d4d4d4; }
        
        /* Examples view toggle */
        .examples-toolbar {
            display: flex;
            justify-content: flex-end;
            margin-bottom: 12px;
        }
        .view-toggle {
            display: flex;
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 4px;
            overflow: hidden;
        }
        .view-toggle-btn {
            background: transparent;
            border: none;
            color: var(--text-muted);
            padding: 6px 12px;
            font-size: 11px;
            cursor: pointer;
        }
        .view-toggle-btn:hover {
            background: var(--surface-light);
        }
        .view-toggle-btn.active {
            background: var(--border);
            color: var(--text);
        }
        .examples-formatted, .examples-raw {
            display: none;
        }
        .examples-formatted.active, .examples-raw.active {
            display: block;
        }
        .raw-examples {
            background: var(--code-bg);
            border: 1px solid var(--border);
            border-radius: 4px;
            padding: 12px;
            overflow-x: auto;
        }
        .raw-examples pre {
            font-family: 'SFMono-Regular', Consolas, monospace;
            font-size: 12px;
            line-height: 1.5;
            white-space: pre;
            color: var(--text);
            margin: 0;
        }
        
        /* Return values */
        .return-item {
            border-bottom: 1px solid var(--border);
            padding: 8px 0;
        }
        .return-item:last-child { border-bottom: none; }
        .return-name {
            font-family: 'SFMono-Regular', Consolas, monospace;
            font-weight: 600;
        }
        .return-meta {
            font-size: 11px;
            color: var(--text-dim);
            margin-top: 2px;
        }
        .return-desc {
            color: var(--text-muted);
            font-size: 12px;
            margin-top: 4px;
        }
        .return-sample {
            background: var(--code-bg);
            border: 1px solid var(--border);
            padding: 6px 10px;
            border-radius: 3px;
            font-family: monospace;
            font-size: 11px;
            margin-top: 6px;
            overflow-x: auto;
            white-space: pre;
        }
        
        /* Author */
        .author { color: var(--text-dim); font-size: 12px; }
        
        /* Tab content */
        .tab-content { display: none; }
        .tab-content.active { display: block; }
        
        /* Inline code */
        code {
            background: var(--code-bg);
            padding: 1px 4px;
            border-radius: 3px;
            font-family: 'SFMono-Regular', Consolas, monospace;
            font-size: 0.9em;
        }
        
        /* Links */
        a { color: var(--text-muted); text-decoration: underline; }
        a:hover { color: var(--text); }
    </style>
</head>
<body>
    <div class="container">
        <div class="breadcrumb">
            <span>${namespace}</span>
            <span class="breadcrumb-separator">›</span>
            <span>${collection}</span>
            <span class="breadcrumb-separator">›</span>
            <span>${pluginType}</span>
            <span class="breadcrumb-separator">›</span>
            <strong>${pluginName}</strong>
        </div>
        
        <div class="header">
            <div class="header-title">
                <h1>${pluginName}</h1>
                <span class="plugin-type-badge">${pluginType}</span>
            </div>
            <div class="short-desc">${this._escapeHtml(doc.short_description || '')}</div>
            ${doc.version_added ? `<div class="version-info">Added in version ${doc.version_added}</div>` : ''}
        </div>
        
        <div class="nav-tabs">
            <span class="nav-tab active" data-tab="synopsis">Synopsis</span>
            <span class="nav-tab" data-tab="parameters">Parameters</span>
            ${doc.notes ? '<span class="nav-tab" data-tab="notes">Notes</span>' : ''}
            ${data.examples ? '<span class="nav-tab" data-tab="examples">Examples</span>' : ''}
            ${data.return ? '<span class="nav-tab" data-tab="return">Return Values</span>' : ''}
        </div>
        
        <div id="synopsis" class="tab-content active">
            <div class="section">
                <h2 class="section-title">Synopsis</h2>
                <div class="synopsis">
                    <ul>
                        ${toArray(doc.description).map(d => `<li>${this._formatText(d)}</li>`).join('')}
                    </ul>
                </div>
            </div>
            
            ${doc.requirements ? `
            <div class="section">
                <h2 class="section-title">Requirements</h2>
                <div class="synopsis">
                    <ul>
                        ${toArray(doc.requirements).map(r => `<li>${this._escapeHtml(r)}</li>`).join('')}
                    </ul>
                </div>
            </div>
            ` : ''}
            
            ${doc.author ? `
            <div class="section">
                <h2 class="section-title">Author</h2>
                <div class="author">
                    ${Array.isArray(doc.author) ? doc.author.join(', ') : doc.author}
                </div>
            </div>
            ` : ''}
        </div>
        
        <div id="parameters" class="tab-content">
            <div class="section">
                <h2 class="section-title">Parameters</h2>
                ${this._renderParameters(doc.options || {})}
            </div>
        </div>
        
        ${doc.notes ? `
        <div id="notes" class="tab-content">
            <div class="section">
                <h2 class="section-title">Notes</h2>
                <div class="notes">
                    <ul>
                        ${toArray(doc.notes).map(n => `<li>${this._formatText(n)}</li>`).join('')}
                    </ul>
                </div>
            </div>
        </div>
        ` : ''}
        
        ${data.examples ? `
        <div id="examples" class="tab-content">
            <div class="section">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                    <h2 class="section-title" style="margin-bottom: 0;">Examples</h2>
                    <div class="view-toggle">
                        <button class="view-toggle-btn active" id="btn-formatted" onclick="toggleExamplesView('formatted')">Formatted</button>
                        <button class="view-toggle-btn" id="btn-raw" onclick="toggleExamplesView('raw')">Raw</button>
                    </div>
                </div>
                <div class="examples-formatted active" id="examples-formatted">
                    ${this._renderExamples(data.examples)}
                </div>
                <div class="examples-raw" id="examples-raw">
                    <div class="raw-examples">
                        <pre>${this._highlightYaml(data.examples)}</pre>
                    </div>
                </div>
            </div>
        </div>
        ` : ''}
        
        ${data.return ? `
        <div id="return" class="tab-content">
            <div class="section">
                <h2 class="section-title">Return Values</h2>
                ${this._renderReturnValues(data.return)}
            </div>
        </div>
        ` : ''}
    </div>
    
    <script>
        // Tab switching
        document.querySelectorAll('.nav-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
                tab.classList.add('active');
                document.getElementById(tab.dataset.tab).classList.add('active');
            });
        });
        
        // Collapsible suboptions
        function toggleSub(id) {
            const el = document.getElementById(id);
            if (el) {
                el.classList.toggle('expanded');
                const header = el.previousElementSibling?.previousElementSibling?.previousElementSibling;
                if (header) {
                    const toggle = header.querySelector('.param-toggle');
                    if (toggle) {
                        toggle.textContent = el.classList.contains('expanded') ? '▼' : '▶';
                    }
                }
            }
        }
        
        // Copy to clipboard
        function copyExample(id) {
            const el = document.getElementById('task-' + id);
            if (el) {
                const text = el.getAttribute('data-raw');
                navigator.clipboard.writeText(text).then(() => {
                    const btn = document.getElementById('copy-btn-' + id);
                    if (btn) {
                        btn.classList.add('copied');
                        btn.innerHTML = '✓ Copied';
                        setTimeout(() => {
                            btn.classList.remove('copied');
                            btn.innerHTML = '📋 Copy';
                        }, 2000);
                    }
                });
            }
        }
        
        // Toggle between formatted and raw examples view
        function toggleExamplesView(view) {
            const formatted = document.getElementById('examples-formatted');
            const raw = document.getElementById('examples-raw');
            const btnFormatted = document.getElementById('btn-formatted');
            const btnRaw = document.getElementById('btn-raw');
            
            if (view === 'formatted') {
                formatted.classList.add('active');
                raw.classList.remove('active');
                btnFormatted.classList.add('active');
                btnRaw.classList.remove('active');
            } else {
                formatted.classList.remove('active');
                raw.classList.add('active');
                btnFormatted.classList.remove('active');
                btnRaw.classList.add('active');
            }
        }
    </script>
</body>
</html>`;
    }

    private _renderParameters(options: { [key: string]: PluginOption }, depth: number = 0): string {
        if (Object.keys(options).length === 0) {
            return '<p style="color: var(--text-dim);">No parameters</p>';
        }

        const sortedOptions = Object.entries(options).sort((a, b) => a[0].localeCompare(b[0]));
        const items = sortedOptions.map(([name, opt]) => this._renderParamItem(name, opt, depth)).join('');
        
        if (depth === 0) {
            return `<div class="param-tree">${items}</div>`;
        }
        return `<div class="suboptions" id="sub-${Date.now()}-${Math.random().toString(36).substr(2, 9)}">${items}</div>`;
    }

    private _renderParamItem(name: string, opt: PluginOption, depth: number): string {
        const typeStr = opt.type || 'str';
        const elementsStr = opt.elements ? `/${opt.elements}` : '';
        const hasSuboptions = opt.suboptions && Object.keys(opt.suboptions).length > 0;
        const subId = `sub-${name}-${depth}-${Math.random().toString(36).substr(2, 9)}`;
        
        return `
        <div class="param-item">
            <div class="param-header" ${hasSuboptions ? `onclick="toggleSub('${subId}')"` : ''}>
                <span class="param-toggle">${hasSuboptions ? '▶' : ''}</span>
                <span class="param-name">${name}</span>
                <span class="param-type">(${typeStr}${elementsStr})</span>
                ${opt.required ? '<span class="param-required">required</span>' : ''}
            </div>
            ${this._renderChoicesDefaults(opt, depth)}
            <div class="param-desc">
                ${toArray(opt.description).map(d => `<p>${this._formatText(d)}</p>`).join('')}
            </div>
            ${hasSuboptions ? `<div class="suboptions" id="${subId}">${Object.entries(opt.suboptions!).sort((a, b) => a[0].localeCompare(b[0])).map(([n, o]) => this._renderParamItem(n, o, depth + 1)).join('')}</div>` : ''}
        </div>`;
    }

    private _renderChoicesDefaults(opt: PluginOption, depth: number = 0): string {
        let html = '';
        const marginLeft = depth > 0 ? '' : 'margin-left: 22px;';
        
        if (opt.choices && opt.choices.length > 0) {
            html += `<div class="param-choices" style="${marginLeft}">`;
            html += opt.choices.map(c => {
                const isDefault = opt.default === c;
                return `<span class="param-choice${isDefault ? ' default' : ''}">${this._escapeHtml(String(c))}</span>`;
            }).join('');
            html += '</div>';
        } else if (opt.default !== undefined && opt.default !== null) {
            html += `<div class="param-default" style="${marginLeft}">default: <code>${this._escapeHtml(JSON.stringify(opt.default))}</code></div>`;
        }
        
        return html;
    }

    private _renderReturnValues(returnVals: PluginReturn): string {
        const entries = Object.entries(returnVals);
        if (entries.length === 0) {
            return '<p style="color: var(--text-dim);">No return values documented</p>';
        }

        return `<div class="param-tree">
            ${entries.map(([name, val]) => `
            <div class="return-item">
                <div class="return-name">${name}</div>
                <div class="return-meta">${val.type || 'unknown'} — returned: ${val.returned || 'always'}</div>
                <div class="return-desc">${Array.isArray(val.description) ? val.description.join(' ') : (val.description || '')}</div>
                ${val.sample !== undefined ? `<div class="return-sample">${this._escapeHtml(JSON.stringify(val.sample, null, 2))}</div>` : ''}
            </div>
            `).join('')}
        </div>`;
    }

    private _renderExamples(examples: string): string {
        // Parse examples into sections based on the pattern
        const sections = this._parseExamples(examples);
        
        if (sections.length === 0) {
            // Fallback: just show the raw examples with syntax highlighting
            return `<div class="example-section">
                <div class="example-code">
                    <pre>${this._highlightYaml(examples)}</pre>
                </div>
            </div>`;
        }
        
        return sections.map((section, index) => {
            const taskId = `example-${index}`;
            const escapedRaw = this._escapeHtml(section.task).replace(/'/g, '&#39;').replace(/"/g, '&quot;');
            
            let html = `<div class="example-section">`;
            
            // Header with title and copy button
            html += `<div class="example-header">
                <span class="example-title">${this._escapeHtml(section.title)}</span>
                <button class="example-copy-btn" id="copy-btn-${taskId}" onclick="copyExample('${taskId}')">
                    📋 Copy
                </button>
            </div>`;
            
            // Before state context (if present)
            if (section.beforeState) {
                html += `<div class="example-context">
                    <div class="example-context-label">Before state:</div>
${this._escapeHtml(section.beforeState)}</div>`;
            }
            
            // The actual task YAML with syntax highlighting
            html += `<div class="example-code" id="task-${taskId}" data-raw="${escapedRaw}">
                <pre>${this._highlightYaml(section.task)}</pre>
            </div>`;
            
            // Task output context (if present)
            if (section.taskOutput) {
                html += `<div class="example-context">
                    <div class="example-context-label">Task Output:</div>
${this._escapeHtml(section.taskOutput)}</div>`;
            }
            
            // After state context (if present)
            if (section.afterState) {
                html += `<div class="example-context">
                    <div class="example-context-label">After state:</div>
${this._escapeHtml(section.afterState)}</div>`;
            }
            
            html += `</div>`;
            return html;
        }).join('');
    }

    private _parseExamples(examples: string): Array<{
        title: string;
        beforeState?: string;
        task: string;
        taskOutput?: string;
        afterState?: string;
    }> {
        const sections: Array<{
            title: string;
            beforeState?: string;
            task: string;
            taskOutput?: string;
            afterState?: string;
        }> = [];
        
        const lines = examples.split('\n');
        let currentSection: {
            title: string;
            beforeState?: string;
            task: string;
            taskOutput?: string;
            afterState?: string;
        } | null = null;
        
        let currentPart: 'start' | 'before' | 'task' | 'output' | 'after' = 'start';
        let buffer: string[] = [];
        let sectionHeader: string | null = null; // For "# Using merged" style headers
        
        const flushBuffer = () => {
            if (!currentSection) {return;}
            const content = buffer.join('\n').trim();
            if (!content) {
                buffer = [];
                return;
            }
            
            switch (currentPart) {
                case 'before':
                    currentSection.beforeState = content;
                    break;
                case 'task':
                    currentSection.task = (currentSection.task ? currentSection.task + '\n\n' : '') + content;
                    break;
                case 'output':
                    currentSection.taskOutput = content;
                    break;
                case 'after':
                    currentSection.afterState = content;
                    break;
            }
            buffer = [];
        };
        
        const saveCurrentSection = () => {
            if (currentSection) {
                flushBuffer();
                if (currentSection.task) {
                    sections.push(currentSection);
                }
            }
            currentSection = null;
            currentPart = 'start';
        };
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmedLine = line.trim();
            
            // Check for section header (# Using merged, # Using replaced, etc.)
            if (/^#\s*Using\s+\w+/.test(trimmedLine)) {
                saveCurrentSection();
                sectionHeader = trimmedLine.replace(/^#\s*/, '');
                continue;
            }
            
            // Check for state markers
            if (/^#\s*Before\s+state:?\s*$/i.test(trimmedLine)) {
                flushBuffer();
                currentPart = 'before';
                continue;
            }
            
            if (/^#\s*Task\s+[Oo]utput:?\s*$/i.test(trimmedLine)) {
                flushBuffer();
                currentPart = 'output';
                continue;
            }
            
            if (/^#\s*After\s+state:?\s*$/i.test(trimmedLine)) {
                flushBuffer();
                currentPart = 'after';
                continue;
            }
            
            // Check if this is a new task (starts with "- name:")
            if (trimmedLine.startsWith('- name:')) {
                // Save previous section if we have one
                saveCurrentSection();
                
                // Extract task name for title and capitalize it
                const rawTaskName = trimmedLine.replace(/^-\s*name:\s*/, '').replace(/^["']|["']$/g, '');
                const taskName = this._capitalizeTitle(rawTaskName);
                
                // Start new section
                currentSection = {
                    title: sectionHeader ? `${sectionHeader}: ${taskName}` : taskName,
                    task: ''
                };
                sectionHeader = null; // Clear header after use
                currentPart = 'task';
                buffer = [line];
                continue;
            }
            
            // If we're in a task and hit a comment line after yaml content, check if it's output/after
            if (currentPart === 'task' && trimmedLine.startsWith('#') && buffer.length > 0) {
                // Check if the previous lines look like YAML (not all comments)
                const hasYaml = buffer.some(l => !l.trim().startsWith('#') && l.trim().length > 0);
                if (hasYaml) {
                    // Skip divider lines
                    if (/^#\s*-+\s*$/.test(trimmedLine)) {
                        continue;
                    }
                    flushBuffer();
                    currentPart = 'output';
                    buffer = [line];
                    continue;
                }
            }
            
            // Add line to current buffer if we have an active section
            if (currentSection) {
                buffer.push(line);
            }
        }
        
        // Save final section
        saveCurrentSection();
        
        return sections;
    }

    private _capitalizeTitle(text: string): string {
        if (!text) {return text;}
        // Capitalize first letter of each word
        return text
            .split(' ')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
    }

    private _highlightYaml(yaml: string): string {
        const lines = yaml.split('\n');
        return lines.map(line => {
            // Comments
            if (line.trim().startsWith('#')) {
                return `<span class="yaml-comment">${this._escapeHtml(line)}</span>`;
            }
            
            // Empty lines
            if (line.trim() === '') {
                return '';
            }
            
            let result = this._escapeHtml(line);
            
            // List markers
            result = result.replace(/^(\s*)(-\s)/, '$1<span class="yaml-list-marker">$2</span>');
            
            // Key-value pairs
            result = result.replace(/^(\s*)([a-zA-Z_][a-zA-Z0-9_]*)(:)(\s|$)/, 
                '$1<span class="yaml-key">$2</span>$3$4');
            
            // After colon values
            result = result.replace(/:(\s+)(".*?"|'.*?')(\s*)$/, 
                ':$1<span class="yaml-string">$2</span>$3');
            
            // Unquoted strings after colon (simple cases)
            result = result.replace(/:(\s+)(\S.*)$/, (match, space, value) => {
                const trimmedValue = value.trim();
                // Check for booleans
                if (/^(true|false|yes|no|on|off)$/i.test(trimmedValue)) {
                    return `:${space}<span class="yaml-bool">${value}</span>`;
                }
                // Check for null
                if (/^(null|~)$/i.test(trimmedValue)) {
                    return `:${space}<span class="yaml-null">${value}</span>`;
                }
                // Check for numbers
                if (/^-?\d+(\.\d+)?$/.test(trimmedValue)) {
                    return `:${space}<span class="yaml-number">${value}</span>`;
                }
                // String values
                return `:${space}<span class="yaml-string">${value}</span>`;
            });
            
            return result;
        }).join('\n');
    }

    private _formatText(text: string): string {
        // Convert Ansible doc formatting to HTML
        let html = this._escapeHtml(text);
        
        // I(text) -> italic
        html = html.replace(/I\(([^)]+)\)/g, '<em>$1</em>');
        // C(text) -> code
        html = html.replace(/C\(([^)]+)\)/g, '<code>$1</code>');
        // B(text) -> bold
        html = html.replace(/B\(([^)]+)\)/g, '<strong>$1</strong>');
        // U(url) -> link
        html = html.replace(/U\(([^)]+)\)/g, '<a href="$1" target="_blank">$1</a>');
        // :ref:`text <reference>` -> text
        html = html.replace(/:ref:`([^<]+)\s*<[^>]+>`/g, '$1');
        // `text` -> code
        html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
        
        return html;
    }

    private _escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    public dispose() {
        PluginDocPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }
}
