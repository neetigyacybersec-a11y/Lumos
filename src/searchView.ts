import { ItemView, WorkspaceLeaf, requestUrl, MarkdownRenderer, TFile } from 'obsidian';
import RelationPlugin from './main';

export const SEARCH_VIEW_TYPE = 'semantic-search-view';

export class SemanticSearchView extends ItemView {
    plugin: RelationPlugin;
    resultsContainer: HTMLElement;
    queryInput: HTMLInputElement;

    constructor(leaf: WorkspaceLeaf, plugin: RelationPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType(): string {
        return SEARCH_VIEW_TYPE;
    }

    getDisplayText(): string {
        return 'Semantic Search';
    }

    async onOpen() {
        const container = this.containerEl.children[1];
        container.empty();
        
        container.createEl('h3', { text: 'Semantic Search & AI' });

        const searchForm = container.createEl('form');
        searchForm.style.display = 'flex';
        searchForm.style.gap = '5px';
        searchForm.style.marginBottom = '15px';
        
        this.queryInput = searchForm.createEl('input', { type: 'text', placeholder: 'Ask a question or search concepts...' });
        this.queryInput.style.flex = '1';
        
        const searchBtn = searchForm.createEl('button', { text: 'Search', type: 'submit' });
        
        this.resultsContainer = container.createEl('div');

        searchForm.onsubmit = async (e) => {
            e.preventDefault();
            await this.performSearch(this.queryInput.value);
        };
    }

    async performSearch(query: string) {
        if (!query.trim()) return;
        
        this.resultsContainer.empty();
        this.resultsContainer.createEl('p', { text: 'Embedding query...' });
        
        try {
            const queryVector = await this.plugin.embeddingPipeline.embed(query);
            this.resultsContainer.empty();
            
            const results = this.plugin.vectorStore.querySimilar(queryVector, 10);
            
            if (results.length === 0) {
                this.resultsContainer.createEl('p', { text: 'No results found.' });
                return;
            }

            // Ask AI Button
            const askAiBtn = this.resultsContainer.createEl('button', { text: 'Ask AI (RAG)' });
            askAiBtn.style.marginBottom = '15px';
            askAiBtn.style.width = '100%';
            
            const aiResponseContainer = this.resultsContainer.createEl('div');
            
            askAiBtn.onclick = async () => {
                aiResponseContainer.empty();
                
                // Premium Loading State
                const loadingEl = aiResponseContainer.createEl('div');
                loadingEl.style.padding = '15px';
                loadingEl.style.textAlign = 'center';
                loadingEl.style.color = 'var(--text-muted)';
                loadingEl.style.backgroundColor = 'var(--background-secondary)';
                loadingEl.style.borderRadius = '8px';
                loadingEl.style.marginBottom = '15px';
                loadingEl.style.border = '1px solid var(--background-modifier-border)';
                loadingEl.style.animation = 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite';
                loadingEl.createEl('span', { text: '✨ Synthesizing from your notes...' });

                askAiBtn.disabled = true;
                
                try {
                    const answer = await this.generateAnswer(query, results.slice(0, 5));
                    aiResponseContainer.empty();
                    
                    // Premium Result Card
                    const callout = aiResponseContainer.createEl('div');
                    callout.style.padding = '15px';
                    callout.style.border = '1px solid var(--background-modifier-border)';
                    callout.style.borderRadius = '8px';
                    callout.style.backgroundColor = 'var(--background-primary-alt)';
                    callout.style.marginBottom = '20px';
                    callout.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.05)';
                    
                    const header = callout.createEl('div');
                    header.style.display = 'flex';
                    header.style.alignItems = 'center';
                    header.style.gap = '8px';
                    header.style.marginBottom = '12px';
                    header.style.borderBottom = '1px solid var(--background-modifier-border)';
                    header.style.paddingBottom = '8px';
                    header.style.color = 'var(--text-accent)';
                    
                    header.createEl('span', { text: '✨' });
                    header.createEl('strong', { text: 'AI Synthesis' });
                    
                    const contentEl = callout.createEl('div', { cls: 'markdown-rendered' });
                    contentEl.style.userSelect = 'text';
                    
                    // Render true markdown!
                    await MarkdownRenderer.renderMarkdown(answer, contentEl, '', this);
                    
                    // Render Clickable Sources
                    const uniqueSources = [...new Set(results.slice(0, 5).map(r => r.filePath))];
                    if (uniqueSources.length > 0) {
                        const sourceContainer = callout.createEl('div');
                        sourceContainer.style.marginTop = '15px';
                        sourceContainer.style.paddingTop = '12px';
                        sourceContainer.style.borderTop = '1px solid var(--background-modifier-border)';
                        sourceContainer.style.display = 'flex';
                        sourceContainer.style.flexWrap = 'wrap';
                        sourceContainer.style.alignItems = 'center';
                        sourceContainer.style.gap = '8px';
                        
                        const sourceLabel = sourceContainer.createEl('span', { text: 'Sources:' });
                        sourceLabel.style.fontSize = '0.85em';
                        sourceLabel.style.fontWeight = '600';
                        sourceLabel.style.color = 'var(--text-muted)';

                        uniqueSources.forEach(filePath => {
                            const fileName = filePath.split('/').pop() || filePath;
                            const tag = sourceContainer.createEl('a', { text: fileName });
                            tag.style.fontSize = '0.8em';
                            tag.style.padding = '3px 10px';
                            tag.style.borderRadius = '16px';
                            tag.style.backgroundColor = 'var(--background-secondary)';
                            tag.style.border = '1px solid var(--background-modifier-border)';
                            tag.style.color = 'var(--text-accent)';
                            tag.style.textDecoration = 'none';
                            tag.style.cursor = 'pointer';
                            tag.style.transition = 'all 0.15s ease';
                            
                            tag.onmouseenter = () => {
                                tag.style.backgroundColor = 'var(--interactive-accent)';
                                tag.style.color = 'var(--text-on-accent)';
                                tag.style.borderColor = 'var(--interactive-accent)';
                            };
                            tag.onmouseleave = () => {
                                tag.style.backgroundColor = 'var(--background-secondary)';
                                tag.style.color = 'var(--text-accent)';
                                tag.style.borderColor = 'var(--background-modifier-border)';
                            };
                            
                            tag.onclick = async (e) => {
                                e.preventDefault();
                                const file = this.app.vault.getAbstractFileByPath(filePath);
                                if (file && file instanceof TFile) {
                                    await this.app.workspace.getLeaf(true).openFile(file);
                                }
                            };
                        });
                    }
                    
                } catch (e) {
                    aiResponseContainer.empty();
                    const errEl = aiResponseContainer.createEl('div');
                    errEl.style.padding = '15px';
                    errEl.style.borderLeft = '4px solid var(--text-error)';
                    errEl.style.backgroundColor = 'var(--background-modifier-error)';
                    errEl.style.borderRadius = '0 8px 8px 0';
                    errEl.createEl('p', { text: 'Error generating answer: ' + e.message, cls: 'error' });
                }
                askAiBtn.disabled = false;
            };

            this.resultsContainer.createEl('h4', { text: 'Top Matches' });
            
            const list = this.resultsContainer.createEl('ul');
            list.style.listStyleType = 'none';
            list.style.padding = '0';
            
            for (const res of results) {
                const li = list.createEl('li');
                li.style.marginBottom = '12px';
                li.style.padding = '12px';
                li.style.border = '1px solid var(--background-modifier-border)';
                li.style.borderRadius = '8px';
                li.style.backgroundColor = 'var(--background-primary)';
                li.style.transition = 'border-color 0.15s ease';
                li.onmouseenter = () => li.style.borderColor = 'var(--interactive-accent)';
                li.onmouseleave = () => li.style.borderColor = 'var(--background-modifier-border)';
                
                const titleRow = li.createEl('div');
                titleRow.style.display = 'flex';
                titleRow.style.justifyContent = 'space-between';
                
                const link = titleRow.createEl('a', { text: res.filePath, cls: 'internal-link' });
                link.onclick = (e) => {
                    e.preventDefault();
                    this.app.workspace.openLinkText(res.filePath, '', false);
                };
                
                titleRow.createEl('span', { text: ` (${Math.round(res.similarity * 100)}%)`, cls: 'relation-confidence' });
                
                const snippet = res.text.length > 200 ? res.text.substring(0, 200) + '...' : res.text;
                const snippetEl = li.createEl('div', { text: snippet });
                snippetEl.style.fontSize = '0.9em';
                snippetEl.style.color = 'var(--text-muted)';
                snippetEl.style.marginTop = '5px';
            }
        } catch (e) {
            this.resultsContainer.empty();
            this.resultsContainer.createEl('p', { text: 'Search failed: ' + e.message, cls: 'error' });
        }
    }

    async generateAnswer(query: string, contextChunks: {filePath: string, text: string}[]): Promise<string> {
        const contextText = contextChunks.map(c => `[Source: ${c.filePath}]\n${c.text}`).join('\n\n');
        const prompt = `You are an AI assistant for a personal knowledge base.
Using ONLY the provided context from the user's notes, answer the question or explain the concept provided.
If the user provides a keyword or topic instead of a full question, summarize what the notes say about that topic.
If the context contains absolutely no relevant information, say "I don't have enough information in your notes about this."

Context:
${contextText}

Query/Topic: ${query}
Answer:`;

        if (this.plugin.settings.provider === 'ollama') {
            const url = this.plugin.settings.baseUrl.replace(/\/$/, '') + '/api/generate';
            const res = await requestUrl({
                url,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: this.plugin.settings.llmModelName || 'llama3',
                    prompt: prompt,
                    stream: false
                }),
                throw: false
            });
            if (res.status !== 200) {
                console.error('Ollama generation failed', res.status, res.text);
                throw new Error(`Ollama failed (${res.status}): ${res.text}`);
            }
            return res.json.response;
        } else {
            const url = this.plugin.settings.baseUrl.replace(/\/$/, '') + '/chat/completions';
            const res = await requestUrl({
                url,
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.plugin.settings.apiKey}`,
                    'HTTP-Referer': 'https://github.com/obsidianmd/obsidian-api',
                    'X-Title': 'Obsidian Relation Plugin'
                },
                body: JSON.stringify({
                    model: this.plugin.settings.llmModelName || 'meta-llama/llama-3-8b-instruct',
                    messages: [{ role: 'user', content: prompt }]
                }),
                throw: false
            });
            if (res.status !== 200) {
                console.error('OpenRouter generation failed', res.status, res.text);
                throw new Error(`OpenRouter failed (${res.status}): ${res.text}`);
            }
            return res.json.choices[0].message.content;
        }
    }
}
