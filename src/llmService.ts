import { Logger } from './logger';
import { LLMServiceHost } from './ports';
import { createTransport, ChatMessage, TerminalApiError, TransientApiError } from './llm/transport';

export { TerminalApiError, TransientApiError };
export type { ChatMessage };

export class LLMService {
    plugin: LLMServiceHost;

    constructor(plugin: LLMServiceHost) {
        this.plugin = plugin;
    }

    async callLLM(messages: ChatMessage[], isRouting: boolean = false, expectJson: boolean = false): Promise<string> {
        try {
            return await createTransport(this.plugin.settings).chat(messages, { expectJson });
        } catch (e) {
            if (e instanceof TerminalApiError || e instanceof TransientApiError) throw e;
            throw new TransientApiError(`API Connection Failed: ${e.message}`);
        }
    }

    async beautifyText(text: string): Promise<string> {
        const systemPrompt = `You are an elite copyeditor and Markdown formatting expert.
Your task is to take the user's raw text and HEAVILY BEAUTIFY it.

RULES:
1. Fix all grammatical errors, typos, and awkward phrasing.
2. Format the text to make it stand out and be highly scannable. Use Markdown features aggressively: bolding, italics, bullet points, headers, and Obsidian callouts (e.g., > [!info], > [!summary], > [!important]).
3. INTERACTIVE ELEMENTS: Identify action items, open questions, or pending tasks and convert them into interactive Markdown checkboxes (- [ ]).
4. STRUCTURED DATA: Identify lists of attributes, comparisons, or structured data and format them into Markdown tables.
5. DO NOT summarize, delete, or change the underlying factual meaning or context of the text. The core information must remain 100% intact.
6. DO NOT add any new content, ideas, paragraphs, or external information. Your job is ONLY to format and copy-edit the exact text provided by the user.
7. Output ONLY the formatted text. No conversational filler like "Here is your formatted text."`;

        const messages: ChatMessage[] = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: text }
        ];

        return await this.callLLM(messages);
    }

    async extractMetadata(text: string): Promise<{ tags: string[], summary: string } | null> {
        const systemPrompt = `You are a metadata extraction tool for an Obsidian vault.
Your task is to analyze the provided text and output a JSON object with two fields:
1. "tags": An array of 3 to 5 highly relevant string tags (without the # symbol, using kebab-case).
2. "summary": A concise, 1-sentence summary of the text.

RULES:
1. ONLY output valid JSON. Do not include markdown formatting like \`\`\`json.
2. Do not include any conversational text.
Example output:
{
  "tags": ["machine-learning", "notes", "project-planning"],
  "summary": "This document outlines the architecture for the new ML prediction feature."
}`;

        const messages: ChatMessage[] = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: text }
        ];

        try {
            const result = await this.callLLM(messages);
            const cleanResult = result.replace(/```json/gi, '').replace(/```/g, '').trim();
            return JSON.parse(cleanResult);
        } catch (e) {
            Logger.error('[Lumos] Metadata extraction failed', e);
            return null;
        }
    }

    async autoLinkText(text: string, vaultFiles: string[]): Promise<string | null> {
        const fileListStr = vaultFiles.join('\n');
        const systemPrompt = `You are a strict text processor for an Obsidian vault.
Your task is to take the user's text and wrap any entities (concepts, people, topics) that EXACTLY OR CLOSELY MATCH the provided list of vault file names with Obsidian Wiki Links ([[Link]]).

RULES:
1. DO NOT change, add, or remove any other text. The output must be identical to the input except for the added [[ ]] brackets.
2. Only link entities if they are highly relevant and match a file in the provided list.
3. Output ONLY the linked text. No conversational filler.

=== VAULT FILES ===
${fileListStr}
===================`;

        const messages: ChatMessage[] = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: text }
        ];

        try {
            return await this.callLLM(messages);
        } catch (e) {
            Logger.error('[Lumos] Auto-link failed', e);
            return null;
        }
    }

    async extractActionItems(text: string): Promise<string | null> {
        const systemPrompt = `You are a strict task extraction assistant.
Your job is to read the user's text and identify ANY and ALL implied tasks, action items, to-dos, or promises.

RULES:
1. Output the tasks ONLY as a standard Markdown checklist (e.g. "- [ ] Task name").
2. DO NOT add any conversational filler (e.g. "Here are the tasks:").
3. If there are no tasks, output EXACTLY "NO_TASKS".`;

        const messages: ChatMessage[] = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: text }
        ];

        try {
            return await this.callLLM(messages);
        } catch (e) {
            Logger.error('[Lumos] Action item extraction failed', e);
            return null;
        }
    }
}
