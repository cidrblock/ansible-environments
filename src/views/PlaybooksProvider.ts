import * as vscode from 'vscode';
import { PlaybooksService, PlaybookInfo, PlaybookPlay } from '../services/PlaybooksService';
import { log } from '../extension';

type TreeNode = PlaybookNode | PlayNode | LoadingNode;

class PlaybookNode {
    constructor(
        public readonly playbook: PlaybookInfo
    ) {}
}

class PlayNode {
    constructor(
        public readonly play: PlaybookPlay,
        public readonly playbook: PlaybookInfo
    ) {}
}

class LoadingNode {
    constructor(public readonly message: string) {}
}

export class PlaybooksProvider implements vscode.TreeDataProvider<TreeNode> {
    private _service: PlaybooksService;
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor() {
        this._service = PlaybooksService.getInstance();
        
        // Listen for service changes
        this._service.onDidChange(() => {
            this._onDidChangeTreeData.fire();
        });

        // Initial load
        log('PlaybooksProvider: Triggering initial refresh');
        this._service.refresh();
    }

    public refresh(): void {
        this._service.refresh();
    }

    getTreeItem(element: TreeNode): vscode.TreeItem {
        if (element instanceof LoadingNode) {
            const item = new vscode.TreeItem(element.message);
            item.iconPath = new vscode.ThemeIcon('sync~spin');
            return item;
        }

        if (element instanceof PlaybookNode) {
            const playbook = element.playbook;
            const item = new vscode.TreeItem(
                playbook.name,
                vscode.TreeItemCollapsibleState.Collapsed
            );
            
            item.iconPath = new vscode.ThemeIcon('notebook');
            item.description = `${playbook.plays.length} play${playbook.plays.length !== 1 ? 's' : ''}`;
            item.contextValue = 'playbook';
            
            // Tooltip with path and details
            const tooltip = new vscode.MarkdownString();
            tooltip.appendMarkdown(`**${playbook.name}**\n\n`);
            tooltip.appendMarkdown(`📂 \`${playbook.relativePath}\`\n\n`);
            tooltip.appendMarkdown(`**Plays:**\n`);
            for (const play of playbook.plays) {
                tooltip.appendMarkdown(`- ${play.name} (hosts: \`${play.hosts}\`)\n`);
            }
            item.tooltip = tooltip;

            // Store playbook info for commands
            item.command = {
                command: 'ansiblePlaybooks.openPlaybook',
                title: 'Open Playbook',
                arguments: [playbook]
            };

            return item;
        }

        if (element instanceof PlayNode) {
            const play = element.play;
            const item = new vscode.TreeItem(
                play.name,
                vscode.TreeItemCollapsibleState.None
            );
            
            item.iconPath = new vscode.ThemeIcon('target');
            item.description = `hosts: ${play.hosts}`;
            item.contextValue = 'play';
            
            // Tooltip
            const tooltip = new vscode.MarkdownString();
            tooltip.appendMarkdown(`**Play:** ${play.name}\n\n`);
            tooltip.appendMarkdown(`**Hosts:** \`${play.hosts}\`\n\n`);
            tooltip.appendMarkdown(`**Line:** ${play.lineNumber}`);
            item.tooltip = tooltip;

            // Click to go to line
            item.command = {
                command: 'ansiblePlaybooks.goToPlay',
                title: 'Go to Play',
                arguments: [element.playbook, play]
            };

            return item;
        }

        return new vscode.TreeItem('Unknown');
    }

    async getChildren(element?: TreeNode): Promise<TreeNode[]> {
        if (!element) {
            // Root level - show playbooks
            if (this._service.isLoading()) {
                return [new LoadingNode('Discovering playbooks...')];
            }

            const playbooks = this._service.getPlaybooks();
            
            if (playbooks.length === 0) {
                if (this._service.isLoaded()) {
                    return [new LoadingNode('No playbooks found')];
                }
                return [new LoadingNode('Discovering playbooks...')];
            }

            return playbooks.map(pb => new PlaybookNode(pb));
        }

        if (element instanceof PlaybookNode) {
            // Show plays for this playbook
            return element.playbook.plays.map(play => new PlayNode(play, element.playbook));
        }

        return [];
    }
}
