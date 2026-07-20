import { ItemView, WorkspaceLeaf, requestUrl, MarkdownRenderer, TFile, MarkdownView } from 'obsidian';
import LumosPlugin from './main';

export const SEARCH_VIEW_TYPE = 'semantic-search-view';

export class SemanticSearchView extends ItemView {
    plugin: LumosPlugin;
    resultsContainer: HTMLElement;
    queryInput: HTMLInputElement;
    chatHistory: { role: string, content: string, sources?: any[] }[] = [];

    constructor(leaf: WorkspaceLeaf, plugin: LumosPlugin) {
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
        this.chatHistory = [];
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
        
        this.chatHistory = [];
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
                askAiBtn.style.display = 'none';
                this.chatHistory.push({ role: 'user', content: query });
                await this.renderChatAndGenerate(results.slice(0, 5), aiResponseContainer);
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

    async renderChatAndGenerate(contextChunks: any[], container: HTMLElement) {
        container.empty();
        
        for (const msg of this.chatHistory) {
            const bubble = container.createEl('div');
            bubble.style.padding = '15px';
            bubble.style.marginBottom = '15px';
            bubble.style.borderRadius = '8px';
            
            if (msg.role === 'user') {
                bubble.style.backgroundColor = 'var(--interactive-accent)';
                bubble.style.color = 'var(--text-on-accent)';
                bubble.style.marginLeft = '20px';
                bubble.createEl('strong', { text: 'You' });
                bubble.createEl('p', { text: msg.content, cls: 'chat-message' });
            } else {
                bubble.style.border = '1px solid var(--background-modifier-border)';
                bubble.style.backgroundColor = 'var(--background-primary-alt)';
                bubble.style.marginRight = '20px';
                
                const header = bubble.createEl('div');
                header.style.display = 'flex';
                header.style.alignItems = 'center';
                header.style.gap = '8px';
                header.style.marginBottom = '12px';
                header.style.borderBottom = '1px solid var(--background-modifier-border)';
                header.style.paddingBottom = '8px';
                header.style.color = 'var(--text-accent)';
                header.createEl('span', { text: '✨' });
                header.createEl('strong', { text: 'AI Synthesis' });
                
                const contentEl = bubble.createEl('div', { cls: 'markdown-rendered' });
                contentEl.style.userSelect = 'text';
                MarkdownRenderer.renderMarkdown(msg.content, contentEl, '', this);
                
                // Action Buttons
                const actionsContainer = bubble.createEl('div');
                actionsContainer.style.display = 'flex';
                actionsContainer.style.gap = '8px';
                actionsContainer.style.marginTop = '15px';
                actionsContainer.style.paddingTop = '12px';
                actionsContainer.style.borderTop = '1px solid var(--background-modifier-border)';

                const copyBtn = actionsContainer.createEl('button', { text: '📋 Copy' });
                copyBtn.onclick = async () => {
                    await navigator.clipboard.writeText(msg.content);
                    const orig = copyBtn.innerText;
                    copyBtn.innerText = '✅ Copied!';
                    setTimeout(() => copyBtn.innerText = orig, 2000);
                };

                const insertBtn = actionsContainer.createEl('button', { text: '📥 Insert' });
                insertBtn.onclick = () => {
                    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                    if (view && view.editor) {
                        view.editor.replaceSelection(msg.content);
                        const orig = insertBtn.innerText;
                        insertBtn.innerText = '✅ Inserted!';
                        setTimeout(() => insertBtn.innerText = orig, 2000);
                    } else {
                        const orig = insertBtn.innerText;
                        insertBtn.innerText = '❌ No active note';
                        setTimeout(() => insertBtn.innerText = orig, 2000);
                    }
                };

                // Sources
                if (msg.sources && msg.sources.length > 0) {
                    const uniqueSources = [...new Set(msg.sources.map(r => r.filePath))];
                    const sourceContainer = bubble.createEl('div');
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
                        
                        tag.onclick = async (e) => {
                            e.preventDefault();
                            const file = this.app.vault.getAbstractFileByPath(filePath);
                            if (file && file instanceof TFile) {
                                await this.app.workspace.getLeaf(true).openFile(file);
                            }
                        };
                    });
                }
            }
        }
        
        // If last message was user, generate response
        if (this.chatHistory.length > 0 && this.chatHistory[this.chatHistory.length - 1].role === 'user') {
            
            const bubble = container.createEl('div');
            bubble.style.padding = '15px';
            bubble.style.marginBottom = '15px';
            bubble.style.borderRadius = '8px';
            bubble.style.border = '1px solid var(--background-modifier-border)';
            bubble.style.backgroundColor = 'var(--background-primary-alt)';
            bubble.style.marginRight = '20px';
            
            const header = bubble.createEl('div');
            header.style.display = 'flex';
            header.style.alignItems = 'center';
            header.style.gap = '8px';
            header.style.marginBottom = '12px';
            header.style.borderBottom = '1px solid var(--background-modifier-border)';
            header.style.paddingBottom = '8px';
            header.style.color = 'var(--text-accent)';
            header.createEl('span', { text: '✨' });
            header.createEl('strong', { text: 'AI Synthesis' });
            
            const contentEl = bubble.createEl('div', { cls: 'markdown-rendered' });
            contentEl.style.userSelect = 'text';
            contentEl.createEl('span', { text: 'Synthesizing...' });
            
            try {
                let currentAnswer = '';
                let lastRender = 0;
                
                const answer = await this.generateAnswer(contextChunks, (chunk) => {
                    currentAnswer += chunk;
                    const now = Date.now();
                    if (now - lastRender > 50) {
                        contentEl.empty();
                        MarkdownRenderer.renderMarkdown(currentAnswer + ' ▍', contentEl, '', this);
                        lastRender = now;
                        container.scrollTop = container.scrollHeight;
                    }
                });
                
                this.chatHistory.push({ role: 'assistant', content: answer, sources: contextChunks });
                await this.renderChatAndGenerate([], container); // Re-render to add buttons
                return;
            } catch (e) {
                contentEl.empty();
                contentEl.createEl('p', { text: 'Error: ' + e.message, cls: 'error' });
                return; // Stop here if error
            }
        }
        
        // Add follow-up input
        const followUpForm = container.createEl('form');
        followUpForm.style.display = 'flex';
        followUpForm.style.gap = '5px';
        followUpForm.style.marginTop = '15px';
        
        const followUpInput = followUpForm.createEl('input', { type: 'text', placeholder: 'Ask a follow-up...' });
        followUpInput.style.flex = '1';
        
        const followUpBtn = followUpForm.createEl('button', { text: 'Send', type: 'submit' });
        
        followUpForm.onsubmit = async (e) => {
            e.preventDefault();
            const q = followUpInput.value;
            if (!q.trim()) return;
            
            followUpInput.disabled = true;
            followUpBtn.disabled = true;
            
            this.chatHistory.push({ role: 'user', content: q });
            
            try {
                const queryVector = await this.plugin.embeddingPipeline.embed(q);
                const newResults = this.plugin.vectorStore.querySimilar(queryVector, 5);
                await this.renderChatAndGenerate(newResults, container);
            } catch(err) {
                 console.error(err);
            }
        };
        
        // Auto focus the follow-up input
        setTimeout(() => followUpInput.focus(), 100);
    }

    async generateAnswer(contextChunks: {filePath: string, text: string}[], onChunk: (chunk: string) => void): Promise<string> {
        const contextText = contextChunks.map(c => `[Source: ${c.filePath}]\n${c.text}`).join('\n\n');
        const systemPrompt = `You are an AI assistant for a personal knowledge base.
Using ONLY the provided context from the user's notes, answer the question or explain the concept provided.
If the user provides a keyword or topic instead of a full question, summarize what the notes say about that topic.
If the context contains absolutely no relevant information, say "I don't have enough information in your notes about this."

Context:
${contextText}`;

        const messages = [{ role: 'system', content: systemPrompt }];
        for (const msg of this.chatHistory) {
            messages.push({ role: msg.role === 'user' ? 'user' : 'assistant', content: msg.content });
        }

        let fullContent = '';

        if (this.plugin.settings.provider === 'ollama') {
            const url = this.plugin.settings.baseUrl.replace(/\/$/, '') + '/api/chat';
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: this.plugin.settings.llmModelName || 'llama3',
                    messages: messages,
                    stream: true
                })
            });
            
            if (!res.ok) throw new Error(`Ollama failed (${res.status}): ${await res.text()}`);
            
            const reader = res.body?.getReader();
            const decoder = new TextDecoder();
            while (true) {
                const { done, value } = await reader!.read();
                if (done) break;
                const chunk = decoder.decode(value, { stream: true });
                const lines = chunk.split('\n').filter(l => l.trim() !== '');
                for (const line of lines) {
                    try {
                        const parsed = JSON.parse(line);
                        if (parsed.message && parsed.message.content) {
                            onChunk(parsed.message.content);
                            fullContent += parsed.message.content;
                        }
                    } catch(e) {}
                }
            }
        } else {
            const url = this.plugin.settings.baseUrl.replace(/\/$/, '') + '/chat/completions';
            const res = await fetch(url, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.plugin.settings.apiKey}`,
                    'HTTP-Referer': 'https://github.com/obsidianmd/obsidian-api',
                    'X-Title': 'Obsidian Relation Plugin'
                },
                body: JSON.stringify({
                    model: this.plugin.settings.llmModelName || 'meta-llama/llama-3-8b-instruct',
                    messages: messages,
                    stream: true
                })
            });
            
            if (!res.ok) throw new Error(`OpenRouter failed (${res.status}): ${await res.text()}`);
            
            const reader = res.body?.getReader();
            const decoder = new TextDecoder();
            while (true) {
                const { done, value } = await reader!.read();
                if (done) break;
                const chunk = decoder.decode(value, { stream: true });
                const lines = chunk.split('\n').filter(l => l.trim() !== '');
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = line.slice(6);
                        if (data.trim() === '[DONE]') continue;
                        try {
                            const parsed = JSON.parse(data);
                            if (parsed.choices && parsed.choices[0].delta && parsed.choices[0].delta.content) {
                                onChunk(parsed.choices[0].delta.content);
                                fullContent += parsed.choices[0].delta.content;
                            }
                        } catch(e) {}
                    }
                }
            }
        }
        
        return fullContent;
    }
}
