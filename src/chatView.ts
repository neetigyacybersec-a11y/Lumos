import { ItemView, WorkspaceLeaf, MarkdownRenderer, Notice, setIcon } from 'obsidian';
import LumosPlugin from './main';
import { ChatLogic } from './chatLogic';
import { ChatMessage } from './llmService';

export const CHAT_VIEW_TYPE = 'relation-chat-view';

export class ChatView extends ItemView {
    plugin: LumosPlugin;
    chatLogic: ChatLogic;
    history: ChatMessage[] = [];
    
    messagesEl: HTMLElement;
    inputEl: HTMLTextAreaElement;
    sendBtn: HTMLButtonElement;
    isGenerating: boolean = false;
    isFocusMode: boolean = false;

    private messageContainerEl: HTMLElement;
    private sendButtonEl: HTMLButtonElement;
    private processingIndicatorEl: HTMLElement;
    private scrollAnchorEl: HTMLElement;

    constructor(leaf: WorkspaceLeaf, plugin: LumosPlugin) {
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
        
        const titleRow = header.createEl('div', { cls: 'llm-chat-title-row' });
        const headerIcon = titleRow.createEl('div', { cls: 'llm-chat-header-icon' });
        headerIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-sparkles"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/><path d="M5 3v4"/><path d="M19 17v4"/><path d="M3 5h4"/><path d="M17 19h4"/></svg>`;
        
        const titleContent = titleRow.createEl('div');
        titleContent.createEl('h3', { text: 'AI Assistant' });
        
        const toggleBtn = titleRow.createEl('button', { text: '🌐 Vault Mode', cls: 'llm-chat-toggle-btn' });
        toggleBtn.style.marginLeft = 'auto';
        toggleBtn.onclick = async () => {
            this.isFocusMode = !this.isFocusMode;
            toggleBtn.innerText = this.isFocusMode ? '📄 Note Mode' : '🌐 Vault Mode';
            await this.appendMessage('assistant', this.isFocusMode ? "Switched to **Note Focus Mode**. I'll only look at the currently open note." : "Switched to **Vault Mode**. I'll search your entire vault for context.");
        };
        
        const sub = header.createEl('p', { text: 'Personalized by your Vault Profile', cls: 'llm-chat-subtitle' });

        // Messages Area
        this.messagesEl = container.createEl('div', { cls: 'llm-chat-messages' });

        // Input Area
        const inputArea = container.createEl('div', { cls: 'llm-chat-input-area' });
        const inputContainer = inputArea.createEl('div', { cls: 'llm-chat-input-container' });
        
        this.inputEl = inputContainer.createEl('textarea', { cls: 'llm-chat-input' });
        this.inputEl.placeholder = 'Ask anything...';
        this.inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.handleSend();
            }
        });
        
        // Auto-resize textarea
        this.inputEl.addEventListener('input', () => {
            this.inputEl.style.height = 'auto';
            this.inputEl.style.height = (this.inputEl.scrollHeight) + 'px';
        });

        this.sendBtn = inputContainer.createEl('button', { cls: 'llm-chat-send-btn' });
        // Set an SVG icon for send
        this.sendBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-arrow-up"><path d="m5 12 7-7 7 7"/><path d="M12 19V5"/></svg>`;
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
            let focusFile = null;
            if (this.isFocusMode) {
                focusFile = this.plugin.app.workspace.getActiveFile();
            }
            const responseText = await this.chatLogic.generateResponse(text, this.history, focusFile);
            
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

        // Avatar
        const avatar = wrapper.createEl('div', { cls: `llm-chat-avatar ${role}` });
        if (role === 'assistant') {
            avatar.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>`;
        } else {
            avatar.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;
        }

        const bubbleContainer = wrapper.createEl('div', { cls: `llm-chat-bubble-container ${role}` });
        const bubble = bubbleContainer.createEl('div', { cls: `llm-chat-bubble ${role}` });

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

        // Avatar
        const avatar = wrapper.createEl('div', { cls: `llm-chat-avatar assistant` });
        avatar.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>`;

        const bubbleContainer = wrapper.createEl('div', { cls: `llm-chat-bubble-container assistant` });
        const bubble = bubbleContainer.createEl('div', { cls: `llm-chat-bubble assistant typing-indicator` });
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
