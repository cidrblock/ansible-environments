/**
 * Ansible Content Designer - Assessment Panel
 * 
 * Webview for answering design assessment questions.
 */

import * as vscode from 'vscode';
import type { 
    AssessmentQuestion, 
    QuestionCategory,
    EnrichedRequirement,
    AssessmentStage
} from '../types/designer';
import { DesignerDatabase } from '../database/DesignerDatabase';
import { AssessmentAgent } from '../orchestrator/AssessmentAgent';
import { DependencyAssessmentAgent } from '../orchestrator/DependencyAssessmentAgent';
import { RequirementService } from '../services/RequirementService';
import { ProgressService } from '../services/ProgressService';
import { ExportService } from '../services/ExportService';
import { 
    getFullStyles, 
    getZoomThemeControls, 
    getZoomThemeScript,
    AGENT_PROGRESS_STYLES,
    getAgentProgressHtml,
    getAgentProgressScript,
    formatAgentLogMessage
} from '../../panels/webviewStyles';

/**
 * Category labels
 */
const CATEGORY_CONFIG: Record<QuestionCategory, { label: string }> = {
    architecture: { label: 'Architecture' },
    security: { label: 'Security' },
    compatibility: { label: 'Compatibility' },
    error_handling: { label: 'Error Handling' },
    idempotency: { label: 'Idempotency' },
    naming: { label: 'Naming' },
    testing: { label: 'Testing' },
    dependencies: { label: 'Dependencies' }
};

/**
 * AssessmentPanel - Webview for Q&A
 */
export class AssessmentPanel {
    public static readonly viewType = 'ansibleContentDesigner.assessment';
    
    private static _currentPanel: AssessmentPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private readonly _workspaceRoot: string;
    private _disposables: vscode.Disposable[] = [];
    private _db: DesignerDatabase;
    private _agent: AssessmentAgent;
    private _dependencyAgent: DependencyAssessmentAgent;
    private _requirementService: RequirementService;
    private _progressService: ProgressService;
    private _exportService: ExportService;
    private _currentStage: AssessmentStage = 'dependencies';

    private constructor(
        panel: vscode.WebviewPanel, 
        extensionUri: vscode.Uri,
        workspaceRoot: string
    ) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._workspaceRoot = workspaceRoot;
        this._db = new DesignerDatabase(workspaceRoot);
        this._agent = new AssessmentAgent(this._db, workspaceRoot);
        this._dependencyAgent = new DependencyAssessmentAgent(this._db, workspaceRoot);
        this._requirementService = new RequirementService(this._db);
        this._progressService = new ProgressService(this._db);
        this._exportService = new ExportService(this._db, workspaceRoot);

        this._initialize();
    }

    private async _initialize(): Promise<void> {
        await this._db.initialize();
        
        // Determine current assessment stage
        this._currentStage = this._dependencyAgent.getCurrentStage();
        
        // IMMEDIATELY render UI with loading state if needed
        const requirements = this._requirementService.list();
        const existingQuestions = this._getQuestionsFromDb(this._currentStage);
        const needsGeneration = existingQuestions.length === 0 && requirements.length > 0;
        
        // Show UI immediately - with loading indicator if generation needed
        this._panel.webview.html = await this._getHtml(needsGeneration);
        
        // Handle messages from webview
        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'saveAnswer':
                        await this._saveAnswer(message.data);
                        break;
                    case 'saveAnswerQuiet':
                        await this._saveAnswerQuiet(message.data);
                        break;
                    case 'saveAllAnswers':
                        await this._saveAllAnswers(message.data);
                        break;
                    case 'useDefault':
                        this._useDefault(message.data);
                        break;
                    case 'useAllDefaults':
                        await this._useAllDefaults();
                        break;
                    case 'completeAssessment':
                        await this._completeAssessment();
                        break;
                    case 'agentReview':
                        await this._requestAgentReview();
                        break;
                    case 'refresh':
                        this._panel.webview.html = await this._getHtml();
                        break;
                    case 'regenerateQuestions':
                        await this._regenerateQuestions();
                        break;
                    case 'installDependencies':
                        await this._installDependencies();
                        break;
                    case 'proceedToContentAssessment':
                        await this._proceedToContentAssessment();
                        break;
                }
            },
            null,
            this._disposables
        );

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        
        // NOW generate questions in background if needed
        if (needsGeneration) {
            this._generateQuestionsWithProgress(requirements);
        }
    }
    
    /**
     * Generate questions with progress feedback sent to the webview
     */
    private async _generateQuestionsWithProgress(requirements: EnrichedRequirement[]): Promise<void> {
        const stage = this._currentStage;
        
        // Set up real-time progress callback
        const { getAgentLogService } = await import('../services/AgentLogService');
        const logService = getAgentLogService(this._workspaceRoot);
        
        logService.setProgressCallback((message: string, type: string) => {
            // Use centralized formatting (no emojis)
            const displayMessage = formatAgentLogMessage(message, type);
            if (!displayMessage) return; // Skip empty messages
            
            const status = type === 'error' ? 'error' : 'working';
            
            this._panel.webview.postMessage({
                command: 'agentProgress',
                data: { status, message: displayMessage, type }
            });
        });
        
        try {
            // Send initial status
            this._panel.webview.postMessage({
                command: 'agentProgress',
                data: { 
                    status: 'starting',
                    message: stage === 'dependencies' 
                        ? '🚀 Starting dependency assessment...'
                        : '🚀 Starting content assessment...'
                }
            });
            
            if (stage === 'dependencies') {
                await this._dependencyAgent.generateDependencyQuestions(requirements);
            } else {
                await this._agent.generateQuestions(requirements);
            }
            
            // Send completion and refresh UI
            this._panel.webview.postMessage({
                command: 'agentProgress',
                data: { status: 'complete', message: '✅ Questions generated successfully!' }
            });
            
            // Clear the callback
            logService.setProgressCallback(undefined);
            
            // Small delay for user to see completion, then refresh
            setTimeout(async () => {
                this._panel.webview.html = await this._getHtml(false);
            }, 1000);
            
        } catch (error) {
            console.error('AssessmentPanel: Question generation failed:', error);
            logService.setProgressCallback(undefined);
            
            this._panel.webview.postMessage({
                command: 'agentProgress',
                data: { 
                    status: 'error', 
                    message: `[ERROR] ${error instanceof Error ? error.message : String(error)}`,
                    type: 'error'
                }
            });
        }
    }

    /**
     * Install confirmed dependencies and refresh
     */
    private async _installDependencies(): Promise<void> {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Installing collections...',
            cancellable: false
        }, async (progress) => {
            const results = await this._dependencyAgent.installConfirmedCollections((collection, status, message) => {
                progress.report({ message: `${status}: ${collection}${message ? ` - ${message}` : ''}` });
            });

            const succeeded = results.filter(r => r.success).length;
            const failed = results.filter(r => !r.success).length;

            if (failed > 0) {
                vscode.window.showWarningMessage(`Installed ${succeeded} collections, ${failed} failed.`);
            } else if (succeeded > 0) {
                vscode.window.showInformationMessage(`Successfully installed ${succeeded} collection(s).`);
            }
        });

        // Refresh the panel
        this._panel.webview.html = await this._getHtml();
    }

    /**
     * Move from dependency stage to content stage
     */
    private async _proceedToContentAssessment(): Promise<void> {
        // First, mark "Use existing version" selections as installed
        this._dependencyAgent.markUseExistingAsInstalled();
        
        // Advance stage
        this._dependencyAgent.advanceToContentStage();
        this._currentStage = 'content';
        
        // Refresh panel with loading state - questions will generate in background
        const requirements = this._requirementService.list();
        this._panel.webview.html = await this._getHtml(true);
        
        // Generate content questions with progress feedback
        this._generateQuestionsWithProgress(requirements);
    }

    /**
     * Show the assessment panel
     */
    public static async show(extensionUri: vscode.Uri): Promise<AssessmentPanel | undefined> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            vscode.window.showErrorMessage('No workspace folder open');
            return undefined;
        }

        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (AssessmentPanel._currentPanel) {
            AssessmentPanel._currentPanel._panel.reveal(column);
            return AssessmentPanel._currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            AssessmentPanel.viewType,
            'Design Assessment',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        AssessmentPanel._currentPanel = new AssessmentPanel(panel, extensionUri, workspaceRoot);
        return AssessmentPanel._currentPanel;
    }

    /**
     * Save an answer (with page refresh)
     */
    private async _saveAnswer(data: { requirementId: string; questionId: string; answer: string }): Promise<void> {
        this._agent.saveAnswer(data.requirementId, data.questionId, data.answer, false);
        this._updateProgress();
        await this._triggerExport();
        this._panel.webview.html = await this._getHtml();
    }

    /**
     * Save an answer quietly (no page refresh, for autosave on blur)
     */
    private async _saveAnswerQuiet(data: { requirementId: string; questionId: string; answer: string; usedDefault?: boolean }): Promise<void> {
        this._agent.saveAnswer(data.requirementId, data.questionId, data.answer, data.usedDefault || false);
        this._updateProgress();
        await this._triggerExport();
        
        // Send progress update to webview
        const questions = this._getQuestionsFromDb();
        const answered = questions.filter(q => q.answer !== null).length;
        const total = questions.length;
        const progress = total > 0 ? Math.round((answered / total) * 100) : 0;
        const isComplete = this._agent.isAssessmentComplete();
        
        // For dependencies stage, also check if dependencies are complete
        const dependenciesComplete = this._currentStage === 'dependencies'
            ? this._dependencyAgent.isDependencyAssessmentComplete()
            : true;
        
        this._panel.webview.postMessage({
            command: 'progressUpdate',
            data: { answered, total, progress, isComplete, dependenciesComplete }
        });
    }
    
    /**
     * Save all answers at once
     */
    private async _saveAllAnswers(answers: Array<{ requirementId: string; questionId: string; answer: string }>): Promise<void> {
        let saved = 0;
        for (const data of answers) {
            if (data.answer && data.answer.trim()) {
                this._agent.saveAnswer(data.requirementId, data.questionId, data.answer, false);
                saved++;
            }
        }
        this._updateProgress();
        await this._triggerExport();
        this._panel.webview.html = await this._getHtml();
        if (saved > 0) {
            vscode.window.showInformationMessage(`Saved ${saved} answer(s)`);
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
     * Use default answer
     */
    private _useDefault(data: { requirementId: string; questionId: string; defaultValue: string }): void {
        this._agent.saveAnswer(data.requirementId, data.questionId, data.defaultValue, true);
        this._updateProgress();
    }

    /**
     * Use all defaults
     */
    private async _useAllDefaults(): Promise<void> {
        const pending = this._agent.getPendingQuestions();
        
        for (const q of pending) {
            if (q.suggested_default) {
                this._agent.saveAnswer(q.requirement_ref, q.id, q.suggested_default, true);
            }
        }

        this._updateProgress();
        this._panel.webview.html = await this._getHtml();
        vscode.window.showInformationMessage('Applied all default answers');
    }

    /**
     * Request agent review of answers for follow-up questions
     */
    private async _requestAgentReview(): Promise<void> {
        // Check review count to prevent infinite loops
        const reviewCount = this._db.get<{ count: number }>(`
            SELECT COUNT(*) as count FROM design_decisions 
            WHERE question LIKE '[Follow-up%'
        `)?.count || 0;
        
        if (reviewCount >= 6) {  // Max ~2 rounds of 3 questions each
            vscode.window.showInformationMessage(
                'Maximum follow-up rounds reached. Click "Complete Assessment" to proceed.'
            );
            return;
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Agent reviewing your answers...',
            cancellable: false
        }, async () => {
            const newQuestions = await this._agent.reviewAnswersForFollowUp();
            
            if (newQuestions.length === 0) {
                vscode.window.showInformationMessage(
                    'Agent review complete. No additional clarifications needed!'
                );
            } else {
                vscode.window.showInformationMessage(
                    `Agent has ${newQuestions.length} follow-up question(s) for you.`
                );
                // Refresh to show new questions
                this._panel.webview.html = await this._getHtml();
            }
        });
    }

    /**
     * Complete assessment and proceed
     */
    private async _completeAssessment(): Promise<void> {
        if (!this._agent.isAssessmentComplete()) {
            const pending = this._agent.getPendingQuestions();
            vscode.window.showWarningMessage(
                `${pending.length} question(s) still need answers`
            );
            return;
        }

        try {
            this._progressService.advancePhase('assessment', 'user');
            await vscode.commands.executeCommand('ansibleContentDesigner.refresh');
            
            // Close this panel and open Planning panel
            this._panel.dispose();
            await vscode.commands.executeCommand('ansibleContentDesigner.openPhase', 'planning');
            
            vscode.window.showInformationMessage('Assessment complete! Opening Planning...');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Cannot complete assessment: ${message}`);
        }
    }

    /**
     * Regenerate questions
     */
    private async _regenerateQuestions(): Promise<void> {
        const confirm = await vscode.window.showWarningMessage(
            'This will regenerate all questions. Existing answers will be preserved.',
            { modal: true },
            'Regenerate'
        );

        if (confirm !== 'Regenerate') {
            return;
        }

        const requirements = this._requirementService.list();
        
        // Show loading state and generate with progress feedback
        this._panel.webview.html = await this._getHtml(true);
        this._generateQuestionsWithProgress(requirements);
    }

    /**
     * Update progress counts
     */
    private _updateProgress(): void {
        const questions = this._getQuestionsFromDb();
        const total = questions.length;
        const answered = questions.filter(q => q.answer !== null).length;
        const pending = total - answered;

        this._progressService.updatePhaseCounts('assessment', total, answered, pending);
    }

    /**
     * Question row type for display
     */
    private _getQuestionsFromDb(stage?: AssessmentStage): Array<{
        question_id: string;
        requirement_id: string;
        category: QuestionCategory;
        question: string;
        question_type: string;
        choices: string | null;
        suggested_default: string | null;
        answer: string | null;
        rationale: string;
        stage: string;
    }> {
        if (stage) {
            return this._db.all(`
                SELECT question_id, requirement_id, category, question, 
                       question_type, choices, suggested_default, answer, rationale, stage
                FROM design_decisions
                WHERE stage = ?
                ORDER BY requirement_id, question_id
            `, stage);
        }
        return this._db.all(`
            SELECT question_id, requirement_id, category, question, 
                   question_type, choices, suggested_default, answer, rationale, 
                   COALESCE(stage, 'content') as stage
            FROM design_decisions
            ORDER BY requirement_id, question_id
        `);
    }

    /**
     * Generate the HTML for the webview
     */
    private async _getHtml(showLoading: boolean = false): Promise<string> {
        // Get current stage
        this._currentStage = this._dependencyAgent.getCurrentStage();
        
        // Get questions for current stage
        const questions = this._getQuestionsFromDb(this._currentStage);
        const requirements = this._requirementService.list();
        
        const answered = questions.filter(q => q.answer !== null).length;
        const total = questions.length;
        const progress = total > 0 ? Math.round((answered / total) * 100) : 0;

        // For dependencies stage, also get install status
        const collectionsToInstall = this._currentStage === 'dependencies' 
            ? this._dependencyAgent.getCollectionsToInstallCount() 
            : 0;
        const dependenciesComplete = this._currentStage === 'dependencies' 
            ? this._dependencyAgent.isDependencyAssessmentComplete()
            : true;

        // Group questions by requirement and sort by category
        const byRequirement = new Map<string, typeof questions>();
        for (const q of questions) {
            const list = byRequirement.get(q.requirement_id) || [];
            list.push(q);
            byRequirement.set(q.requirement_id, list);
        }
        
        // Sort each group by category alphabetically
        for (const [reqId, qs] of byRequirement) {
            qs.sort((a, b) => a.category.localeCompare(b.category));
            byRequirement.set(reqId, qs);
        }

        // Build stage-specific header
        const stageHeader = this._currentStage === 'dependencies'
            ? `<div class="stage-indicator">
                <span class="stage-badge current">1. Dependencies</span>
                <span class="stage-arrow">→</span>
                <span class="stage-badge">2. Content</span>
               </div>
               <p class="subtitle">Identify and install Ansible collections needed for your requirements.</p>`
            : `<div class="stage-indicator">
                <span class="stage-badge complete">1. Dependencies ✓</span>
                <span class="stage-arrow">→</span>
                <span class="stage-badge current">2. Content</span>
               </div>
               <p class="subtitle">Answer design questions to guide content generation. Collections are now installed for informed questions.</p>`;

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Design Assessment</title>
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
            --success: var(--vscode-testing-iconPassed);
        }
        
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--fg);
            background: var(--bg);
            padding: 16px;
            max-width: 1100px;
            margin: 0 auto;
        }
        
        h1 { font-size: 1.3em; margin-bottom: 4px; font-weight: 500; }
        
        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 12px;
        }
        
        .subtitle { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
        
        .stage-indicator {
            display: flex;
            align-items: center;
            gap: 8px;
            margin: 8px 0;
        }
        
        .stage-badge {
            padding: 4px 10px;
            border-radius: 12px;
            font-size: 0.8em;
            background: var(--secondary-bg);
            color: var(--vscode-descriptionForeground);
        }
        
        .stage-badge.current {
            background: var(--button-bg);
            color: var(--button-fg);
            font-weight: 500;
        }
        
        .stage-badge.complete {
            background: var(--success);
            color: var(--bg);
        }
        
        .stage-arrow {
            color: var(--vscode-descriptionForeground);
        }
        
        .progress-bar {
            height: 4px;
            background: var(--secondary-bg);
            border-radius: 2px;
            margin-bottom: 12px;
            overflow: hidden;
        }
        
        .progress-fill {
            height: 100%;
            background: var(--success);
            transition: width 0.3s;
        }
        
        .toolbar {
            display: flex;
            gap: 8px;
            margin-bottom: 12px;
        }
        
        button {
            padding: 4px 10px;
            border: none;
            border-radius: 3px;
            font-size: 0.9em;
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
            padding: 2px 6px;
            font-size: 0.8em;
        }
        
        table {
            width: 100%;
            border-collapse: collapse;
            font-size: 0.9em;
        }
        
        th {
            text-align: left;
            padding: 8px;
            background: var(--secondary-bg);
            border-bottom: 1px solid var(--border);
            font-weight: 500;
        }
        
        td {
            padding: 8px;
            border-bottom: 1px solid var(--border);
            vertical-align: top;
        }
        
        tr:hover {
            background: var(--secondary-bg);
        }
        
        .category-badge {
            display: inline-block;
            font-size: 0.75em;
            padding: 1px 6px;
            border-radius: 3px;
            background: var(--secondary-bg);
            white-space: nowrap;
        }
        
        .question-text {
            font-weight: 500;
        }
        
        .rationale {
            color: var(--vscode-descriptionForeground);
            font-size: 0.85em;
            margin-top: 2px;
        }
        
        .answer-cell {
            min-width: 250px;
        }
        
        .choice-input, .text-input {
            display: flex;
            flex-direction: column;
            gap: 6px;
        }
        
        .answer-select {
            width: 100%;
            padding: 4px 6px;
            background: var(--input-bg);
            color: var(--input-fg);
            border: 1px solid var(--input-border);
            border-radius: 3px;
            font-family: inherit;
            font-size: 0.9em;
        }
        
        .answer-select:focus {
            outline: none;
            border-color: var(--focus);
        }
        
        .multi-choice-input {
            display: flex;
            flex-direction: column;
            gap: 4px;
        }
        
        .checkbox-label {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 0.9em;
            cursor: pointer;
        }
        
        .checkbox-label input[type="checkbox"] {
            margin: 0;
        }
        
        .accept-default-btn {
            padding: 2px 8px;
            font-size: 0.8em;
            background: color-mix(in srgb, var(--vscode-testing-iconPassed) 20%, transparent);
            color: var(--vscode-testing-iconPassed);
            border: 1px solid var(--vscode-testing-iconPassed);
            border-radius: 3px;
            cursor: pointer;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            max-width: 100%;
        }
        
        .accept-default-btn:hover {
            background: color-mix(in srgb, var(--vscode-testing-iconPassed) 30%, transparent);
        }
        
        .answer-input {
            width: 100%;
            padding: 4px 6px;
            background: var(--input-bg);
            color: var(--input-fg);
            border: 1px solid var(--input-border);
            border-radius: 3px;
            font-family: inherit;
            font-size: inherit;
            resize: vertical;
            min-height: 28px;
        }
        
        .answer-input:focus {
            outline: none;
            border-color: var(--focus);
        }
        
        .saved-answer {
            color: var(--vscode-descriptionForeground);
            font-style: italic;
        }
        
        .filter-select {
            padding: 4px 8px;
            background: var(--input-bg);
            color: var(--input-fg);
            border: 1px solid var(--input-border);
            border-radius: 3px;
            font-size: 0.9em;
        }
        
        .requirements-list {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        
        .req-section {
            border: 1px solid var(--border);
            border-radius: 4px;
            overflow: hidden;
        }
        
        .req-section.complete {
            opacity: 0.8;
        }
        
        .req-header-row {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px 12px;
            background: var(--secondary-bg);
            cursor: pointer;
            user-select: none;
        }
        
        .req-header-row:hover {
            background: color-mix(in srgb, var(--secondary-bg) 80%, var(--fg));
        }
        
        .req-toggle {
            font-size: 0.8em;
            color: var(--vscode-descriptionForeground);
            width: 12px;
        }
        
        .req-title {
            flex: 1;
            font-weight: 500;
            color: var(--fg);
        }
        
        .req-badge {
            padding: 2px 8px;
            font-size: 0.8em;
            background: var(--input-bg);
            border-radius: 10px;
            color: var(--vscode-descriptionForeground);
        }
        
        .req-badge.complete {
            background: color-mix(in srgb, var(--vscode-testing-iconPassed) 20%, transparent);
            color: var(--vscode-testing-iconPassed);
        }
        
        .req-content {
            padding: 0;
        }
        
        .req-content table {
            margin: 0;
            border-radius: 0;
        }
        
        .empty-state {
            text-align: center;
            padding: 24px;
            color: var(--vscode-descriptionForeground);
        }
        
        .footer {
            display: flex;
            justify-content: flex-end;
            margin-top: 12px;
        }
        
        .view-controls {
            display: flex;
            gap: 4px;
            align-items: center;
            margin-left: 8px;
        }
        
        .view-controls button {
            background: var(--secondary-bg);
            border: 1px solid var(--border);
            padding: 2px 6px;
        }
        
        .container { zoom: 1; }
        
        /* Agent Progress Panel - Full mode when loading */
        .agent-progress-panel {
            background: var(--secondary-bg);
            border: 1px solid var(--border);
            border-radius: 6px;
            overflow: hidden;
            margin: 24px auto;
            max-width: 800px;
        }
        
        .agent-progress-panel.floating {
            position: fixed;
            bottom: 16px;
            right: 16px;
            width: 400px;
            max-height: 250px;
            margin: 0;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            z-index: 1000;
        }
        
        .agent-progress-panel.minimized {
            max-height: 36px;
        }
        
        .agent-progress-panel.minimized .progress-content {
            display: none;
        }
        
        .agent-progress-panel.complete {
            border-color: var(--success);
        }
        
        .agent-progress-panel.error {
            border-color: var(--vscode-errorForeground);
        }
        
        .progress-header {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px 12px;
            background: var(--input-bg);
            border-bottom: 1px solid var(--border);
        }
        
        .progress-spinner {
            animation: spin 1s linear infinite;
            font-size: 1.1em;
        }
        
        .agent-progress-panel.complete .progress-spinner,
        .agent-progress-panel.error .progress-spinner {
            animation: none;
        }
        
        .agent-progress-panel.complete .progress-spinner::before {
            content: '✓';
        }
        
        .agent-progress-panel.error .progress-spinner::before {
            content: '✕';
        }
        
        @keyframes spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
        }
        
        .progress-title {
            flex: 1;
            font-weight: 500;
            font-size: 0.9em;
        }
        
        .collapse-btn {
            background: transparent;
            border: none;
            color: var(--fg);
            cursor: pointer;
            font-size: 1.2em;
            padding: 0 4px;
        }
        
        .progress-content {
            padding: 12px 16px;
            max-height: 400px;
            overflow-y: auto;
        }
        
        .agent-progress-panel.floating .progress-content {
            max-height: 200px;
        }
        
        .progress-log {
            font-size: 0.85em;
            color: var(--vscode-descriptionForeground);
        }
        
        .log-entry {
            padding: 6px 8px;
            border-bottom: 1px solid var(--border);
            font-family: 'SF Mono', Monaco, 'Cascadia Code', Consolas, monospace;
            font-size: 0.85em;
            line-height: 1.4;
            animation: fadeIn 0.2s ease-in;
        }
        
        @keyframes fadeIn {
            from { opacity: 0; transform: translateX(-8px); }
            to { opacity: 1; transform: translateX(0); }
        }
        
        .log-entry:last-child {
            border-bottom: none;
        }
        
        .log-entry.tool-call, .log-entry.tool_call {
            color: var(--vscode-textLink-foreground);
            background: rgba(0, 122, 204, 0.1);
            border-radius: 3px;
        }
        
        .log-entry.tool_result {
            color: var(--success);
            padding-left: 20px;
        }
        
        .log-entry.success, .log-entry.parsed {
            color: var(--success);
        }
        
        .log-entry.error {
            color: var(--vscode-errorForeground);
            background: rgba(255, 0, 0, 0.1);
            border-radius: 3px;
        }
        
        .log-entry.info {
            color: var(--fg);
            opacity: 0.9;
        }
        
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
        
        .log-entry.tool_call .log-prefix,
        .log-entry.tool_call .log-msg { color: var(--vscode-textLink-foreground); }
        .log-entry.tool_result .log-prefix,
        .log-entry.tool_result .log-msg { color: var(--vscode-descriptionForeground); }
        .log-entry.response .log-msg { font-style: italic; }
        .log-entry.error .log-prefix,
        .log-entry.error .log-msg { color: var(--vscode-errorForeground); }
        
        .log-entry.response {
            color: var(--fg);
            background: rgba(100, 100, 100, 0.1);
            border-radius: 4px;
            padding: 8px 12px;
            margin: 4px 0;
            font-style: italic;
            line-height: 1.5;
        }
        
        .log-entry.prompt {
            color: var(--vscode-descriptionForeground);
            font-size: 0.9em;
        }
        
        /* Loading State */
        .loading-state {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 12px;
        }
        
        .loading-spinner {
            width: 40px;
            height: 40px;
            border: 3px solid var(--border);
            border-top-color: var(--button-bg);
            border-radius: 50%;
            animation: spin 1s linear infinite;
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
            <h1>Design Assessment</h1>
            ${stageHeader}
            <span class="subtitle">${answered}/${total} answered</span>
        </div>
        <div class="toolbar">
            <select id="filterSelect" class="filter-select">
                <option value="all">All questions</option>
                <option value="unanswered">Unanswered only</option>
            </select>
            <button class="secondary small" id="useAllDefaultsBtn" ${total === answered ? 'disabled' : ''}>
                Use Defaults
            </button>
            ${this._currentStage === 'content' ? `
            <button class="secondary small" id="regenerateBtn">
                Regenerate
            </button>` : ''}
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
    
    <!-- Agent Progress Panel - Full mode when loading, floating when done -->
    <div id="agentProgressPanel" class="agent-progress-panel ${showLoading ? '' : 'floating'}" style="display: ${showLoading ? 'block' : 'none'}">
        <div class="progress-header">
            <span class="progress-spinner">◐</span>
            <span class="progress-title">AI Agent Working...</span>
            <button class="collapse-btn" id="collapseProgressBtn" title="Minimize">−</button>
        </div>
        <div class="progress-content" id="progressContent">
            <div class="progress-log" id="progressLog">
                <div class="log-entry info">Initializing ${this._currentStage === 'dependencies' ? 'dependency' : 'content'} assessment agent...</div>
            </div>
        </div>
    </div>
    
    ${showLoading ? `
        <!-- During loading, the agent progress panel IS the main content -->
    ` : questions.length === 0 ? `
        <div class="empty-state">
            <p>No questions yet.</p>
            <button class="primary" id="generateBtn">Generate Questions</button>
        </div>
    ` : `
        <div class="requirements-list">
            ${Array.from(byRequirement.entries()).map(([reqId, qs], idx) => {
                const req = requirements.find(r => r.id === reqId);
                const answeredCount = qs.filter(q => q.answer !== null).length;
                const totalCount = qs.length;
                const isComplete = answeredCount === totalCount;
                // First incomplete requirement starts expanded; if all complete, all start collapsed
                const firstIncompleteIdx = Array.from(byRequirement.entries()).findIndex(([, questions]) => 
                    questions.some(q => q.answer === null)
                );
                const isExpanded = idx === firstIncompleteIdx; // Only expand if this is the first incomplete
                
                return `
                    <div class="req-section ${isComplete ? 'complete' : ''}" data-req-id="${reqId}">
                        <div class="req-header-row" data-req-id="${reqId}">
                            <span class="req-toggle">${isExpanded ? '▼' : '▶'}</span>
                            <span class="req-title">${reqId}: ${this._escapeHtml((req?.description || '').substring(0, 60))}${(req?.description?.length || 0) > 60 ? '...' : ''}</span>
                            <span class="req-badge ${isComplete ? 'complete' : ''}">${answeredCount}/${totalCount}</span>
                        </div>
                        <div class="req-content" style="display: ${isExpanded ? 'block' : 'none'}">
                            <table>
                                <thead>
                                    <tr>
                                        <th style="width: 100px;">Category</th>
                                        <th>Question</th>
                                        <th style="width: 280px;">Answer</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${qs.map(q => this._renderQuestionRow(q)).join('')}
                                </tbody>
                            </table>
                        </div>
                    </div>
                `;
            }).join('')}
        </div>
    `}
    
    ${questions.length > 0 ? `
        <div class="footer">
            ${this._currentStage === 'dependencies' ? `
                <!-- Dependencies stage: show install and proceed buttons -->
                ${collectionsToInstall > 0 ? `
                    <button class="secondary" id="installDepsBtn">
                        Install ${collectionsToInstall} Collection(s)
                    </button>
                ` : ''}
                <button class="primary" id="proceedToContentBtn" ${!dependenciesComplete ? 'disabled' : ''}>
                    ${collectionsToInstall > 0 ? 'Skip & Proceed →' : 'Proceed to Content Assessment →'}
                </button>
            ` : `
                <!-- Content stage: show agent review and complete buttons -->
                <button class="secondary" id="agentReviewBtn" ${answered < total ? 'disabled' : ''} title="Have the AI review your answers and suggest clarifying questions">
                    Request Agent Review
                </button>
                <button class="primary" id="completeBtn" ${answered < total ? 'disabled' : ''}>
                    Complete Assessment →
                </button>
            `}
        </div>
    ` : ''}
    
    <script>
        const vscode = acquireVsCodeApi();
        
        // Listen for messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            
            // Agent progress updates (during question generation)
            if (message.command === 'agentProgress') {
                const panel = document.getElementById('agentProgressPanel');
                const log = document.getElementById('progressLog');
                const title = panel?.querySelector('.progress-title');
                const spinner = panel?.querySelector('.progress-spinner');
                
                if (!panel || !log) return;
                
                const { status, message: msg, type } = message.data;
                
                // Add log entry
                const entry = document.createElement('div');
                entry.className = 'log-entry';
                
                // Add type-specific classes
                if (type) {
                    entry.className += ' ' + type;
                }
                if (status === 'complete') {
                    entry.className += ' success';
                }
                if (status === 'error') {
                    entry.className += ' error';
                }
                
                // Add with three-column layout (time | prefix | msg)
                const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
                const parts = msg.split(' ');
                const prefix = parts[0] || '';
                const rest = parts.slice(1).join(' ');
                entry.innerHTML = '<span class="log-time">' + time + '</span><span class="log-prefix">' + prefix + '</span><span class="log-msg">' + rest + '</span>';
                log.insertBefore(entry, log.firstChild);
                
                // Update panel state
                if (status === 'complete') {
                    panel.classList.add('complete');
                    panel.classList.remove('error');
                    if (title) title.textContent = 'Complete!';
                    if (spinner) spinner.textContent = '✓';
                    // Auto-hide after 2 seconds
                    setTimeout(() => {
                        panel.style.display = 'none';
                    }, 2000);
                } else if (status === 'error') {
                    panel.classList.add('error');
                    panel.classList.remove('complete');
                    if (title) title.textContent = 'Error';
                    if (spinner) spinner.textContent = '✕';
                } else {
                    if (title) title.textContent = 'AI Agent Working...';
                }
                
                return;
            }
            
            // Progress bar updates (for answer saving)
            if (message.command === 'progressUpdate') {
                const { answered, total, progress, isComplete, dependenciesComplete } = message.data;
                
                // Update subtitle
                const subtitle = document.querySelector('.subtitle');
                if (subtitle) subtitle.textContent = answered + '/' + total + ' answered';
                
                // Update progress bar
                const progressFill = document.querySelector('.progress-fill');
                if (progressFill) progressFill.style.width = progress + '%';
                
                // Update complete button (content stage)
                const completeBtn = document.getElementById('completeBtn');
                if (completeBtn) completeBtn.disabled = !isComplete;
                
                // Update proceed to content button (dependencies stage)
                const proceedBtn = document.getElementById('proceedToContentBtn');
                if (proceedBtn) proceedBtn.disabled = !dependenciesComplete;
                
                // Update agent review button
                const reviewBtn = document.getElementById('agentReviewBtn');
                if (reviewBtn) reviewBtn.disabled = answered < total;
                
                // Check if current requirement section is now complete
                checkAndAutoCollapse();
            }
        });
        
        // Toggle requirement sections
        document.querySelectorAll('.req-header-row').forEach(header => {
            header.addEventListener('click', () => {
                const reqId = header.dataset.reqId;
                const section = header.closest('.req-section');
                const content = section.querySelector('.req-content');
                const toggle = header.querySelector('.req-toggle');
                
                const isExpanded = content.style.display !== 'none';
                content.style.display = isExpanded ? 'none' : 'block';
                toggle.textContent = isExpanded ? '▶' : '▼';
            });
        });
        
        // Filter dropdown
        const filterSelect = document.getElementById('filterSelect');
        if (filterSelect) {
            filterSelect.addEventListener('change', () => {
                const filter = filterSelect.value;
                
                document.querySelectorAll('.req-section').forEach(section => {
                    const rows = section.querySelectorAll('tbody tr');
                    let visibleCount = 0;
                    
                    rows.forEach(row => {
                        const hasAnswer = row.querySelector('.answer-input')?.value?.trim() ||
                                         row.querySelector('.answer-select')?.value;
                        
                        if (filter === 'unanswered') {
                            row.style.display = hasAnswer ? 'none' : '';
                            if (!hasAnswer) visibleCount++;
                        } else {
                            row.style.display = '';
                            visibleCount++;
                        }
                    });
                    
                    // Hide entire section if no visible questions
                    if (filter === 'unanswered' && visibleCount === 0) {
                        section.style.display = 'none';
                    } else {
                        section.style.display = '';
                        // Auto-expand sections with unanswered when filtering
                        if (filter === 'unanswered' && visibleCount > 0) {
                            const content = section.querySelector('.req-content');
                            const toggle = section.querySelector('.req-toggle');
                            content.style.display = 'block';
                            toggle.textContent = '▼';
                        }
                    }
                });
            });
        }
        
        // Check if a requirement is complete and auto-collapse, expand next
        function checkAndAutoCollapse() {
            const sections = Array.from(document.querySelectorAll('.req-section'));
            
            for (let i = 0; i < sections.length; i++) {
                const section = sections[i];
                const rows = section.querySelectorAll('tbody tr');
                let answeredCount = 0;
                let totalCount = 0;
                
                rows.forEach(row => {
                    if (row.style.display === 'none') return;
                    totalCount++;
                    const hasAnswer = row.querySelector('.answer-input')?.value?.trim() ||
                                     row.querySelector('.answer-select')?.value;
                    if (hasAnswer) answeredCount++;
                });
                
                const badge = section.querySelector('.req-badge');
                if (badge) {
                    badge.textContent = answeredCount + '/' + totalCount;
                    if (answeredCount === totalCount) {
                        badge.classList.add('complete');
                        section.classList.add('complete');
                    } else {
                        badge.classList.remove('complete');
                        section.classList.remove('complete');
                    }
                }
                
                // If this section is expanded and complete, collapse and open next
                const content = section.querySelector('.req-content');
                const toggle = section.querySelector('.req-toggle');
                const isExpanded = content.style.display !== 'none';
                
                if (isExpanded && answeredCount === totalCount && i < sections.length - 1) {
                    // Find next incomplete section
                    for (let j = i + 1; j < sections.length; j++) {
                        const nextSection = sections[j];
                        if (!nextSection.classList.contains('complete')) {
                            // Collapse current
                            content.style.display = 'none';
                            toggle.textContent = '▶';
                            
                            // Expand next
                            const nextContent = nextSection.querySelector('.req-content');
                            const nextToggle = nextSection.querySelector('.req-toggle');
                            nextContent.style.display = 'block';
                            nextToggle.textContent = '▼';
                            
                            // Scroll into view
                            nextSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
                            break;
                        }
                    }
                }
            }
        }
        
        // Autosave on blur (when leaving the textarea)
        document.querySelectorAll('.answer-input').forEach(textarea => {
            textarea.addEventListener('blur', () => {
                const original = textarea.dataset.original || '';
                const current = textarea.value.trim();
                
                // Only save if changed and not empty
                if (current && current !== original) {
                    textarea.dataset.original = current;
                    vscode.postMessage({
                        command: 'saveAnswerQuiet',
                        data: {
                            requirementId: textarea.dataset.req,
                            questionId: textarea.dataset.qid,
                            answer: textarea.value
                        }
                    });
                }
            });
        });
        
        // Autosave on dropdown change
        document.querySelectorAll('.answer-select').forEach(select => {
            select.addEventListener('change', () => {
                const original = select.dataset.original || '';
                const current = select.value;
                
                if (current && current !== original) {
                    select.dataset.original = current;
                    vscode.postMessage({
                        command: 'saveAnswerQuiet',
                        data: {
                            requirementId: select.dataset.req,
                            questionId: select.dataset.qid,
                            answer: current
                        }
                    });
                }
            });
        });
        
        // Autosave on checkbox change (multi-choice)
        document.querySelectorAll('.multi-choice-input').forEach(container => {
            container.querySelectorAll('input[type="checkbox"]').forEach(checkbox => {
                checkbox.addEventListener('change', () => {
                    const checkboxes = container.querySelectorAll('input[type="checkbox"]:checked');
                    const values = Array.from(checkboxes).map(cb => cb.value).join('|');
                    
                    vscode.postMessage({
                        command: 'saveAnswerQuiet',
                        data: {
                            requirementId: container.dataset.req,
                            questionId: container.dataset.qid,
                            answer: values || null
                        }
                    });
                });
            });
        });
        
        // Accept default button
        document.querySelectorAll('.accept-default-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const defaultValue = btn.dataset.default;
                const reqId = btn.dataset.req;
                const qid = btn.dataset.qid;
                
                // Find and update the associated input
                const row = btn.closest('tr');
                const select = row.querySelector('.answer-select');
                const textarea = row.querySelector('.answer-input');
                
                if (select) {
                    select.value = defaultValue;
                    select.dataset.original = defaultValue;
                }
                if (textarea) {
                    textarea.value = defaultValue;
                    textarea.dataset.original = defaultValue;
                }
                
                // Save immediately
                vscode.postMessage({
                    command: 'saveAnswerQuiet',
                    data: {
                        requirementId: reqId,
                        questionId: qid,
                        answer: defaultValue,
                        usedDefault: true
                    }
                });
                
                // Hide the accept button
                btn.style.display = 'none';
            });
        });
        
        // Use default (legacy)
        document.querySelectorAll('.default-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                vscode.postMessage({
                    command: 'useDefault',
                    data: {
                        requirementId: btn.dataset.req,
                        questionId: btn.dataset.qid,
                        defaultValue: btn.dataset.default
                    }
                });
            });
        });
        
        // Save all answers
        const saveAllBtn = document.getElementById('saveAllBtn');
        if (saveAllBtn) {
            saveAllBtn.addEventListener('click', () => {
                const answers = [];
                document.querySelectorAll('textarea[data-req]').forEach(ta => {
                    if (ta.value.trim()) {
                        answers.push({
                            requirementId: ta.dataset.req,
                            questionId: ta.dataset.qid,
                            answer: ta.value
                        });
                    }
                });
                if (answers.length > 0) {
                    vscode.postMessage({ command: 'saveAllAnswers', data: answers });
                }
            });
        }
        
        // Use all defaults
        const useAllBtn = document.getElementById('useAllDefaultsBtn');
        if (useAllBtn) {
            useAllBtn.addEventListener('click', () => {
                vscode.postMessage({ command: 'useAllDefaults' });
            });
        }
        
        // Regenerate
        const regenBtn = document.getElementById('regenerateBtn');
        if (regenBtn) {
            regenBtn.addEventListener('click', () => {
                vscode.postMessage({ command: 'regenerateQuestions' });
            });
        }
        
        // Generate
        const genBtn = document.getElementById('generateBtn');
        if (genBtn) {
            genBtn.addEventListener('click', () => {
                vscode.postMessage({ command: 'refresh' });
            });
        }
        
        // Agent Review
        const agentReviewBtn = document.getElementById('agentReviewBtn');
        if (agentReviewBtn) {
            agentReviewBtn.addEventListener('click', () => {
                vscode.postMessage({ command: 'agentReview' });
            });
        }
        
        // Complete (content stage)
        const completeBtn = document.getElementById('completeBtn');
        if (completeBtn) {
            completeBtn.addEventListener('click', () => {
                vscode.postMessage({ command: 'completeAssessment' });
            });
        }
        
        // Install dependencies (dependencies stage)
        const installDepsBtn = document.getElementById('installDepsBtn');
        if (installDepsBtn) {
            installDepsBtn.addEventListener('click', () => {
                vscode.postMessage({ command: 'installDependencies' });
            });
        }
        
        // Proceed to content assessment (dependencies stage)
        const proceedToContentBtn = document.getElementById('proceedToContentBtn');
        if (proceedToContentBtn) {
            proceedToContentBtn.addEventListener('click', () => {
                vscode.postMessage({ command: 'proceedToContentAssessment' });
            });
        }
        
        // Collapse progress panel
        const collapseBtn = document.getElementById('collapseProgressBtn');
        if (collapseBtn) {
            collapseBtn.addEventListener('click', () => {
                const panel = document.getElementById('agentProgressPanel');
                if (panel) {
                    panel.classList.toggle('minimized');
                    collapseBtn.textContent = panel.classList.contains('minimized') ? '+' : '−';
                }
            });
        }
        
        // Zoom/Theme controls
        ${getZoomThemeScript('assessment')}
    </script>
    </div>
</body>
</html>`;
    }

    /**
     * Render a question card
     */
    private _renderQuestionRow(q: {
        question_id: string;
        requirement_id: string;
        category: QuestionCategory;
        question: string;
        question_type: string;
        choices: string | null;
        suggested_default: string | null;
        answer: string | null;
        rationale: string;
    }): string {
        const config = CATEGORY_CONFIG[q.category] || { label: q.category };
        const choices = q.choices ? JSON.parse(q.choices) as string[] : [];
        const hasDefault = Boolean(q.suggested_default && !q.answer);

        return `
            <tr data-qid="${q.question_id}">
                <td><span class="category-badge">${config.label}</span></td>
                <td>
                    <div class="question-text">${this._escapeHtml(q.question)}</div>
                    ${q.rationale ? `<div class="rationale">${this._escapeHtml(q.rationale)}</div>` : ''}
                </td>
                <td class="answer-cell">
                    ${this._renderAnswerInput(q, choices, hasDefault)}
                </td>
            </tr>
        `;
    }

    /**
     * Render the appropriate input based on question type
     */
    private _renderAnswerInput(q: {
        question_id: string;
        requirement_id: string;
        question_type: string;
        suggested_default: string | null;
        answer: string | null;
    }, choices: string[], hasDefault: boolean): string {
        const dataAttrs = `data-req="${q.requirement_id}" data-qid="${q.question_id}"`;
        const currentValue = q.answer || '';

        // Single choice - render as dropdown
        if (q.question_type === 'single_choice' && choices.length > 0) {
            return `
                <div class="choice-input">
                    <select class="answer-select" ${dataAttrs} data-original="${this._escapeHtml(currentValue)}">
                        <option value="">Select...</option>
                        ${choices.map(c => `
                            <option value="${this._escapeHtml(c)}" ${currentValue === c ? 'selected' : ''}>
                                ${this._escapeHtml(c)}
                            </option>
                        `).join('')}
                    </select>
                    ${hasDefault ? `
                        <button class="accept-default-btn small" ${dataAttrs} data-default="${this._escapeHtml(q.suggested_default || '')}">
                            ✓ Accept: ${this._escapeHtml(this._truncateDefault(q.suggested_default!))}
                        </button>
                    ` : ''}
                </div>
            `;
        }

        // Multi choice - render as checkboxes
        if (q.question_type === 'multi_choice' && choices.length > 0) {
            const selectedValues = currentValue ? currentValue.split('|') : [];
            return `
                <div class="multi-choice-input" ${dataAttrs} data-original="${this._escapeHtml(currentValue)}">
                    ${choices.map(c => `
                        <label class="checkbox-label">
                            <input type="checkbox" value="${this._escapeHtml(c)}" 
                                ${selectedValues.includes(c) ? 'checked' : ''}>
                            ${this._escapeHtml(c)}
                        </label>
                    `).join('')}
                    ${hasDefault ? `
                        <button class="accept-default-btn small" ${dataAttrs} data-default="${this._escapeHtml(q.suggested_default || '')}">
                            ✓ Accept default
                        </button>
                    ` : ''}
                </div>
            `;
        }

        // Text input (default)
        return `
            <div class="text-input">
                <textarea class="answer-input" placeholder="${hasDefault ? 'Or type custom answer...' : 'Answer...'}" 
                    ${dataAttrs} data-original="${this._escapeHtml(currentValue)}">${this._escapeHtml(currentValue)}</textarea>
                ${hasDefault ? `
                    <button class="accept-default-btn small" ${dataAttrs} data-default="${this._escapeHtml(q.suggested_default || '')}">
                        ✓ Accept: ${this._escapeHtml(this._truncateDefault(q.suggested_default!))}
                    </button>
                ` : ''}
            </div>
        `;
    }

    /**
     * Truncate default for button display
     */
    private _truncateDefault(text: string): string {
        if (text.length <= 30) return text;
        return text.substring(0, 27) + '...';
    }

    /**
     * Escape HTML for safe rendering
     */
    private _escapeHtml(text: string | null | undefined): string {
        if (text === null || text === undefined) {
            return '';
        }
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    public dispose(): void {
        AssessmentPanel._currentPanel = undefined;
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
