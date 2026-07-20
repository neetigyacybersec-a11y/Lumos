import { ItemView, WorkspaceLeaf } from 'obsidian';
import RelationPlugin from './main';
import { getSortedEdgesForPath, formatEdge } from './sidebarLogic';

export const RELATION_VIEW_TYPE = 'relation-sidebar-view';

export class RelationSidebarView extends ItemView {
    plugin: RelationPlugin;

    constructor(leaf: WorkspaceLeaf, plugin: RelationPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType(): string {
        return RELATION_VIEW_TYPE;
    }

    getDisplayText(): string {
        return 'LLM Relations';
    }

    async onOpen() {
        this.render();
        // Register event to re-render when active leaf changes
        this.registerEvent(this.app.workspace.on('file-open', () => this.render()));
        // Re-render when file content changes (so relations hide/show instantly)
        this.registerEvent(this.app.metadataCache.on('changed', (file) => {
            const activeFile = this.app.workspace.getActiveFile();
            if (activeFile && file.path === activeFile.path) {
                this.render();
            }
        }));
    }

    async onClose() {
        // Cleanup handled by ItemView
    }

    render() {
        const container = this.containerEl.children[1];
        container.empty();

        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) {
            container.createEl('p', { text: 'Open a file to see LLM-extracted relations.' });
            return;
        }

        const edges = this.plugin.relationStore.getEdgesForPath(activeFile.path);
        let sorted = getSortedEdgesForPath(edges, activeFile.path);

        // Filter out edges that are already linked in the document body
        const cache = this.app.metadataCache.getFileCache(activeFile);
        const existingLinks = new Set(cache?.links?.map(l => l.link) || []);
        sorted = sorted.filter(edge => {
            const formatted = formatEdge(edge, activeFile.path);
            const targetFile = this.app.vault.getAbstractFileByPath(formatted.displayPath);
            if (targetFile) {
                const basename = targetFile.name.replace(/\.[^/.]+$/, "");
                if (existingLinks.has(basename) || existingLinks.has(targetFile.name) || existingLinks.has(formatted.displayPath)) {
                    return false; // Hide if already linked
                }
            }
            return true;
        });

        const threshold = this.plugin.settings.displayThreshold || 0.8;
        const strongEdges = sorted.filter(e => (e.scores?.overall ?? e.confidence) >= threshold);
        const weakEdges = sorted.filter(e => (e.scores?.overall ?? e.confidence) < threshold);

        container.createEl('h3', { text: `Relations for ${activeFile.basename}` });
        
        if (sorted.length === 0) {
            container.createEl('p', { text: 'No relations found yet. Edit the file to trigger extraction.' });
            return;
        }

        const renderEdgeList = (edges: typeof sorted, parentEl: HTMLElement) => {
            const list = parentEl.createEl('ul', { cls: 'relation-list' });
            for (const edge of edges) {
                const formatted = formatEdge(edge, activeFile.path);
                const overallScore = formatted.scores?.overall ?? formatted.confidence;
                
                const li = list.createEl('li', { cls: 'relation-item' });
                li.style.marginBottom = '15px';
                li.style.padding = '10px';
                li.style.border = '1px solid var(--background-modifier-border)';
                li.style.borderRadius = '5px';
                
                const titleRow = li.createEl('div', { cls: 'relation-title' });
                titleRow.style.display = 'flex';
                titleRow.style.justifyContent = 'space-between';
                
                const link = titleRow.createEl('a', { text: formatted.displayPath, cls: 'internal-link' });
                link.onclick = (e) => {
                    e.preventDefault();
                    this.app.workspace.openLinkText(formatted.displayPath, activeFile.path, false);
                };
                
                const scoreSpan = titleRow.createEl('span', { text: `${Math.round(overallScore * 100)}%`, cls: 'relation-confidence' });
                scoreSpan.style.cursor = 'help';
                
                if (formatted.scores) {
                    const breakdown = `LLM: ${Math.round(formatted.scores.llm * 100)}%\n` +
                                      `Cosine: ${Math.round(formatted.scores.cosine * 100)}%\n` +
                                      `Keyword: ${Math.round(formatted.scores.keyword * 100)}%\n` +
                                      `Folder: ${Math.round(formatted.scores.folder * 100)}%\n` +
                                      `Recency: ${Math.round(formatted.scores.recency * 100)}%`;
                    scoreSpan.title = breakdown;
                }
                
                li.createEl('div', { text: `Type: ${formatted.relationType}`, cls: 'relation-type' });
                
                if (formatted.evidence) {
                    const evidenceEl = li.createEl('div', { text: `"${formatted.evidence}"`, cls: 'relation-evidence' });
                    evidenceEl.style.fontStyle = 'italic';
                    evidenceEl.style.fontSize = '0.9em';
                    evidenceEl.style.color = 'var(--text-muted)';
                    evidenceEl.style.marginBottom = '8px';
                }
                
                // Action Buttons
                const btnRow = li.createEl('div', { cls: 'relation-actions' });
                btnRow.style.display = 'flex';
                btnRow.style.gap = '5px';
                btnRow.style.marginTop = '8px';
                
                const btnInsert = btnRow.createEl('button', { text: 'Insert Link' });
                btnInsert.onclick = async () => {
                    const targetFile = this.app.vault.getAbstractFileByPath(formatted.displayPath);
                    if (targetFile) {
                        const relType = formatted.relationType || 'related';
                        const calloutText = `\n\n> [!info] [[${targetFile.name}]]\n> **Type:** ${relType}\n> *"${formatted.evidence || ''}"*\n`;
                        
                        const editor = this.app.workspace.activeEditor?.editor;
                        if (editor) {
                            const lastLine = editor.lastLine();
                            const lastLineLength = editor.getLine(lastLine).length;
                            editor.replaceRange(calloutText, { line: lastLine, ch: lastLineLength });
                        } else {
                            try {
                                await this.app.vault.process(activeFile, (data) => data + calloutText);
                            } catch (e) {
                                console.error('Failed to append callout', e);
                            }
                        }
                    }
                };
                
                if (formatted.relationType === 'duplicate-effort') {
                    const btnMerge = btnRow.createEl('button', { text: 'Merge' });
                    btnMerge.onclick = async () => {
                        const targetFile = this.app.vault.getAbstractFileByPath(formatted.displayPath);
                        if (targetFile) {
                            const leaf = this.app.workspace.getLeaf('split');
                            await leaf.openFile(targetFile as any);
                        }
                    };
                }
                
                const btnDismiss = btnRow.createEl('button', { text: 'Dismiss' });
                btnDismiss.onclick = async () => {
                    await this.plugin.relationStore.dismissEdge(activeFile.path, formatted.displayPath, formatted.relationType);
                    this.render();
                };
            }
        };

        if (strongEdges.length > 0) {
            renderEdgeList(strongEdges, container);
        } else {
            container.createEl('p', { text: 'No strong relations found.' });
        }

        if (weakEdges.length > 0) {
            const details = container.createEl('details');
            details.style.marginTop = '15px';
            const summary = details.createEl('summary', { text: `Show Weak Matches (${weakEdges.length})` });
            summary.style.cursor = 'pointer';
            summary.style.fontWeight = 'bold';
            
            renderEdgeList(weakEdges, details);
        }
    }
}
