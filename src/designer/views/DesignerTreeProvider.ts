/**
 * Ansible Content Designer - Tree View Provider
 * 
 * Provides the sidebar tree view for navigating Content Designer phases.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { 
    Phase, 
    PhaseStatus, 
    PhaseProgress 
} from '../types/designer';
import { DesignerDatabase } from '../database/DesignerDatabase';

/**
 * Tree item types
 */
type TreeItemType = 'root' | 'phase' | 'action';

/**
 * Tree node data
 */
interface DesignerTreeNode {
    type: TreeItemType;
    id: string;
    label: string;
    phase?: Phase;
    status?: PhaseStatus;
    count?: number;
    blockerCount?: number;
    children?: DesignerTreeNode[];
}

/**
 * Phase display configuration
 */
const PHASE_CONFIG: Record<Phase, { label: string; icon: string; order: number }> = {
    intake: { label: 'Requirements', icon: 'checklist', order: 0 },
    assessment: { label: 'Assessment', icon: 'comment-discussion', order: 1 },
    planning: { label: 'Plan', icon: 'tasklist', order: 2 },
    building: { label: 'Build', icon: 'tools', order: 3 },
    complete: { label: 'Complete', icon: 'check-all', order: 4 }
};

/**
 * Status icons
 */
const STATUS_ICONS: Record<PhaseStatus, string> = {
    locked: 'lock',
    available: 'circle-large-outline',
    in_progress: 'edit',
    blocked: 'warning',
    complete: 'check'
};

/**
 * DesignerTreeProvider - Sidebar tree view for Content Designer
 */
export class DesignerTreeProvider implements vscode.TreeDataProvider<DesignerTreeNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<DesignerTreeNode | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private _workspaceRoot: string | undefined;
    private _db: DesignerDatabase | undefined;
    private _hasProject: boolean = false;
    private _phaseProgress: Map<Phase, PhaseProgress> = new Map();

    constructor() {
        this._workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        this._checkProject();
    }

    /**
     * Check if a Content Designer project exists
     */
    private _checkProject(): void {
        if (!this._workspaceRoot) {
            this._hasProject = false;
            return;
        }

        const dbPath = path.join(this._workspaceRoot, 'design', 'design.db');
        this._hasProject = fs.existsSync(dbPath);

        if (this._hasProject) {
            this._db = new DesignerDatabase(this._workspaceRoot);
        }
    }

    /**
     * Refresh the tree view
     */
    public refresh(): void {
        this._checkProject();
        this._loadProgress();
        this._onDidChangeTreeData.fire(undefined);
    }

    /**
     * Load phase progress from database
     */
    private async _loadProgress(): Promise<void> {
        if (!this._db || !this._hasProject) {
            return;
        }

        try {
            await this._db.initialize();
            
            const rows = this._db.all<PhaseProgress>(`
                SELECT * FROM phase_progress
            `);

            this._phaseProgress.clear();
            for (const row of rows) {
                this._phaseProgress.set(row.phase, row);
            }

            this._db.close();
        } catch (error) {
            console.error('Failed to load phase progress:', error);
        }
    }

    /**
     * Get tree item for display
     */
    getTreeItem(element: DesignerTreeNode): vscode.TreeItem {
        const treeItem = new vscode.TreeItem(
            element.label,
            element.children?.length 
                ? vscode.TreeItemCollapsibleState.Expanded 
                : vscode.TreeItemCollapsibleState.None
        );

        treeItem.id = element.id;

        if (element.type === 'root') {
            treeItem.iconPath = new vscode.ThemeIcon('notebook');
            treeItem.contextValue = 'designerRoot';
            
            if (!this._hasProject) {
                treeItem.description = 'No project';
                treeItem.tooltip = 'Click "New Project" to create a Content Designer project';
            }
        } else if (element.type === 'phase' && element.phase) {
            const config = PHASE_CONFIG[element.phase];
            const status = element.status || 'locked';
            
            // Set icon based on status
            const statusIcon = STATUS_ICONS[status];
            treeItem.iconPath = new vscode.ThemeIcon(statusIcon);
            
            // Build description with count
            const parts: string[] = [];
            if (element.count !== undefined && element.count > 0) {
                parts.push(`${element.count}`);
            }
            if (element.blockerCount !== undefined && element.blockerCount > 0) {
                parts.push(`⚠️ ${element.blockerCount} blockers`);
            }
            
            treeItem.description = parts.join(' · ');
            
            // Tooltip with more detail
            const tooltip = new vscode.MarkdownString();
            tooltip.appendMarkdown(`### ${config.label}\n\n`);
            tooltip.appendMarkdown(`**Status**: ${this._formatStatus(status)}\n\n`);
            
            if (element.count !== undefined) {
                tooltip.appendMarkdown(`**Items**: ${element.count}\n\n`);
            }
            if (element.blockerCount !== undefined && element.blockerCount > 0) {
                tooltip.appendMarkdown(`**Blockers**: ${element.blockerCount}\n\n`);
            }
            
            treeItem.tooltip = tooltip;
            
            // Context value for menu contributions
            treeItem.contextValue = `designerPhase-${status}`;
            
            // Command to open phase panel
            if (status !== 'locked') {
                treeItem.command = {
                    command: 'ansibleContentDesigner.openPhase',
                    title: 'Open Phase',
                    arguments: [element.phase]
                };
            }
        } else if (element.type === 'action') {
            treeItem.iconPath = new vscode.ThemeIcon('add');
            treeItem.contextValue = 'designerAction';
            treeItem.command = {
                command: 'ansibleContentDesigner.newProject',
                title: 'New Project'
            };
        }

        return treeItem;
    }

    /**
     * Get children of a tree item
     */
    async getChildren(element?: DesignerTreeNode): Promise<DesignerTreeNode[]> {
        if (!this._workspaceRoot) {
            return [];
        }

        // Root level
        if (!element) {
            // Load progress if we have a project
            if (this._hasProject) {
                await this._loadProgress();
            }

            return this._buildRootNodes();
        }

        // Children of root
        if (element.type === 'root') {
            return element.children || [];
        }

        return [];
    }

    /**
     * Build the root level nodes
     */
    private _buildRootNodes(): DesignerTreeNode[] {
        if (!this._hasProject) {
            // No project - show action to create one
            return [{
                type: 'action',
                id: 'new-project',
                label: 'Create New Project',
                children: []
            }];
        }

        // Build phase nodes
        const phases: Phase[] = ['intake', 'assessment', 'planning', 'building', 'complete'];
        
        return phases.map(phase => {
            const progress = this._phaseProgress.get(phase);
            const config = PHASE_CONFIG[phase];
            
            return {
                type: 'phase' as TreeItemType,
                id: `phase-${phase}`,
                label: config.label,
                phase,
                status: progress?.status || 'locked',
                count: progress?.total_items || 0,
                blockerCount: progress?.blocker_count || 0
            };
        });
    }

    /**
     * Format status for display
     */
    private _formatStatus(status: PhaseStatus): string {
        const statusLabels: Record<PhaseStatus, string> = {
            locked: '🔒 Locked',
            available: '○ Available',
            in_progress: '◉ In Progress',
            blocked: '⚠️ Blocked',
            complete: '✓ Complete'
        };
        return statusLabels[status];
    }
}
