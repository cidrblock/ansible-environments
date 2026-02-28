/**
 * Ansible Content Designer - Extension Activation
 * 
 * Handles activation and deactivation of the Content Designer module.
 * This is called from the main extension activation.
 */

import * as vscode from 'vscode';
import { DesignerTreeProvider } from './views/DesignerTreeProvider';
import { ProjectInitPanel } from './panels/ProjectInitPanel';
import { RequirementsPanel } from './panels/RequirementsPanel';
import { AssessmentPanel } from './panels/AssessmentPanel';
import { PlanningPanel } from './panels/PlanningPanel';
import { BuildPanel } from './panels/BuildPanel';
import { DriftPanel } from './panels/DriftPanel';
import { DesignerDatabase } from './database/DesignerDatabase';
import { ExportService } from './services/ExportService';
import { ContentDesignerAgent } from './orchestrator/ContentDesignerAgent';
import { initializeAgentTools } from './services/AgentToolService';

/**
 * Content Designer activation context
 */
export interface DesignerContext {
    treeProvider: DesignerTreeProvider;
    // database: DesignerDatabase;
    // progressService: ProgressService;
    disposables: vscode.Disposable[];
}

let designerContext: DesignerContext | undefined;

/**
 * Activate the Content Designer module
 * 
 * @param context - VS Code extension context
 * @param log - Logging function from main extension
 * @returns DesignerContext for access to services
 */
export async function activateDesigner(
    context: vscode.ExtensionContext,
    log: (message: string) => void
): Promise<DesignerContext> {
    log('Content Designer: Activating...');
    
    const disposables: vscode.Disposable[] = [];
    
    // Check if workspace is available
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        log('Content Designer: No workspace folder open');
    }
    
    // Initialize native VS Code tool registration
    try {
        await initializeAgentTools();
        log('Content Designer: Agent tools registered with vscode.lm');
    } catch (error) {
        log(`Content Designer: Failed to initialize agent tools: ${error}`);
    }
    
    // Register tree view provider
    const treeProvider = new DesignerTreeProvider();
    const treeView = vscode.window.createTreeView('ansibleContentDesigner', {
        treeDataProvider: treeProvider,
        showCollapseAll: false
    });
    disposables.push(treeView);
    
    // Register commands
    disposables.push(
        vscode.commands.registerCommand('ansibleContentDesigner.newProject', async () => {
            ProjectInitPanel.show(context.extensionUri);
        }),
        
        vscode.commands.registerCommand('ansibleContentDesigner.openPhase', async (phase: string) => {
            switch (phase) {
                case 'intake':
                    await RequirementsPanel.show(context.extensionUri);
                    break;
                case 'assessment':
                    await AssessmentPanel.show(context.extensionUri);
                    break;
                case 'planning':
                    await PlanningPanel.show(context.extensionUri);
                    break;
                case 'building':
                    await BuildPanel.show(context.extensionUri);
                    break;
                case 'complete':
                    await DriftPanel.show(context.extensionUri);
                    break;
                default:
                    vscode.window.showInformationMessage(`Phase: ${phase}`);
            }
        }),
        
        vscode.commands.registerCommand('ansibleContentDesigner.refresh', () => {
            treeProvider.refresh();
        }),
        
        vscode.commands.registerCommand('ansibleContentDesigner.openRequirements', async () => {
            await RequirementsPanel.show(context.extensionUri);
        }),
        
        vscode.commands.registerCommand('ansibleContentDesigner.signOff', async () => {
            // TODO: Implement sign-off via ProgressService
            vscode.window.showInformationMessage('Content Designer: Sign Off (coming soon)');
        }),
        
        vscode.commands.registerCommand('ansibleContentDesigner.export', async () => {
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspaceRoot) {
                vscode.window.showErrorMessage('No workspace folder open');
                return;
            }
            
            try {
                const db = new DesignerDatabase(workspaceRoot);
                await db.initialize();
                const exportService = new ExportService(db, workspaceRoot);
                
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: 'Exporting design data...',
                    cancellable: false
                }, async () => {
                    const files = await exportService.exportAll();
                    vscode.window.showInformationMessage(
                        `Exported ${files.length} file(s) to design/export/`
                    );
                });
                
                db.close();
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`Export failed: ${message}`);
            }
        }),

        vscode.commands.registerCommand('ansibleContentDesigner.undoBuild', async () => {
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspaceRoot) {
                vscode.window.showErrorMessage('No workspace folder open');
                return;
            }
            
            // Confirm with user
            const confirm = await vscode.window.showWarningMessage(
                'Undo Build: This will remove all files created during the last build. Continue?',
                { modal: true },
                'Undo Build'
            );
            
            if (confirm !== 'Undo Build') {
                return;
            }
            
            try {
                const db = new DesignerDatabase(workspaceRoot);
                await db.initialize();
                const agent = new ContentDesignerAgent(db, workspaceRoot);
                
                const result = agent.undoBuild();
                db.close();
                
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
                
                // Refresh tree
                treeProvider.refresh();
                
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`Undo failed: ${message}`);
            }
        })
    );
    
    designerContext = {
        treeProvider,
        disposables
    };
    
    // Add all disposables to extension context
    context.subscriptions.push(...disposables);
    
    log('Content Designer: Activated');
    
    return designerContext;
}

/**
 * Deactivate the Content Designer module
 */
export function deactivateDesigner(): void {
    if (designerContext) {
        // Close database connections
        // designerContext.database?.close();
        
        // Dispose all registered disposables
        for (const disposable of designerContext.disposables) {
            disposable.dispose();
        }
        
        designerContext = undefined;
    }
}

/**
 * Check if Content Designer is active for current workspace
 */
export function isDesignerActive(): boolean {
    return designerContext !== undefined;
}

/**
 * Get the current designer context
 */
export function getDesignerContext(): DesignerContext | undefined {
    return designerContext;
}
