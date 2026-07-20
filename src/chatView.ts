import { ItemView, WorkspaceLeaf, MarkdownRenderer, Notice } from 'obsidian';
import RelationPlugin from './main';
import { ChatLogic, ChatMessage } from './chatLogic';

export const CHAT_VIEW_TYPE = 'llm-relations-chat-view';

export class ChatView extends ItemView {
    plugin: RelationPlugin;
    chatLogic: ChatLogic;
    history: ChatMessage[] = [];
    
    messagesEl: HTMLElement;
    inputEl: HTMLTextAreaElement;
    sendBtn: HTMLButtonElement;
    isGenerating: boolean = false;

    constructor(leaf: WorkspaceLeaf, plugin: RelationPlugin) {
        super(leaf);
        this.plugin = plugin;
        this.chatLogic = new ChatLogic(plugin);
    }

    getViewType(): string {
        return CHAT_VIEW_TYPE;
    }

    getDisplayText(): string {
        return 'Personalized AI Chat';
    }

    getIcon(): string {
        return 'message-circle';
    }

    async onOpen() {
        const container = this.containerEl.children[1];
        container.empty();
        container.addClass('llm-chat-wrapper');

        // Header
        const header = container.createEl('div', { cls: 'llm-chat-header' });
        header.createEl('h3', { text: 'AI Assistant' });
        const sub = header.createEl('p', { text: 'Personalized by your Vault Profile' });
        sub.style.fontSize = 'var(--font-ui-smaller)';
        sub.style.color = 'var(--text-muted)';
        sub.style.margin = '0';

        // Messages Area
        this.messagesEl = container.createEl('div', { cls: 'llm-chat-messages' });

        // Input Area
        const inputArea = container.createEl('div', { cls: 'llm-chat-input-area' });
        
        this.inputEl = inputArea.createEl('textarea', { cls: 'llm-chat-input' });
        this.inputEl.placeholder = 'Ask anything...';
        this.inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.handleSend();
            }
        });

        this.sendBtn = inputArea.createEl('button', { cls: 'llm-chat-send-btn' });
        // Set an SVG icon for send
        this.sendBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-send"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>`;
        this.sendBtn.onclick = () => this.handleSend();

        // Welcome message
        this.appendMessage('assistant', "Alright, lie down on the digital couch. Tell me what's going on in your head, and please, for the love of syntax, don't ask me to write a python script.");
    }

    async handleSend() {
        const text = this.inputEl.value.trim();
        if (!text || this.isGenerating) return;

        this.inputEl.value = '';
        
        // Append user message to UI and history
        await this.appendMessage('user', text);
        this.history.push({ role: 'user', content: text });

        // Analyze chat message for profile insights in the background
        this.plugin.userProfileManager.analyzeChatMessage(text);

        // Add typing indicator
        const typingId = this.appendTypingIndicator();
        this.isGenerating = true;

        try {
            const responseText = await this.chatLogic.generateResponse(text, this.history);
            
            // Remove typing indicator
            this.removeMessage(typingId);
            
            // Append assistant message to UI and history
            await this.appendMessage('assistant', responseText);
            this.history.push({ role: 'assistant', content: responseText });

        } catch (e) {
            this.removeMessage(typingId);
            new Notice('Failed to generate response. Check console.');
            await this.appendMessage('assistant', '*Error: Failed to connect to LLM. Please check your API key and connection.*');
        } finally {
            this.isGenerating = false;
        }
    }

    async appendMessage(role: 'user' | 'assistant', text: string): Promise<string> {
        const id = `msg-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
        const wrapper = this.messagesEl.createEl('div', { cls: `llm-chat-msg-wrapper ${role}` });
        wrapper.id = id;

        const bubble = wrapper.createEl('div', { cls: `llm-chat-bubble ${role}` });

        if (role === 'user') {
            bubble.innerText = text;
        } else {
            // Use Obsidian's markdown renderer for the bot!
            await MarkdownRenderer.renderMarkdown(text, bubble, '', this);
        }

        this.scrollToBottom();
        return id;
    }

    appendTypingIndicator(): string {
        const id = `msg-${Date.now()}-typing`;
        const wrapper = this.messagesEl.createEl('div', { cls: `llm-chat-msg-wrapper assistant` });
        wrapper.id = id;

        const bubble = wrapper.createEl('div', { cls: `llm-chat-bubble assistant typing-indicator` });
        bubble.createEl('span', { cls: 'dot' });
        bubble.createEl('span', { cls: 'dot' });
        bubble.createEl('span', { cls: 'dot' });

        this.scrollToBottom();
        return id;
    }

    removeMessage(id: string) {
        const el = document.getElementById(id);
        if (el) el.remove();
    }

    scrollToBottom() {
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    }

    async onClose() {
        // Cleanup handled by ItemView
    }
}
