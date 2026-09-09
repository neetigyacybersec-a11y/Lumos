import { Logger } from './logger';
import { LLMTransport, ChatMessage, TerminalApiError, TransientApiError } from './llm/transport';

export { TerminalApiError, TransientApiError };
export type { ChatMessage };

export class LLMService {
    transport: LLMTransport;

    constructor(transport: LLMTransport) {
        this.transport = transport;
    }

    async callLLM(messages: ChatMessage[], expectJson: boolean = false): Promise<string> {
        try {
            return await this.transport.chat(messages, { expectJson });
        } catch (e) {
            if (e instanceof TerminalApiError || e instanceof TransientApiError) throw e;
            throw new TransientApiError(`API Connection Failed: ${e.message}`);
        }
    }

    async chatStream(messages: ChatMessage[], onChunk: (chunk: string) => void): Promise<string> {
        return this.transport.chatStream(messages, onChunk);
    }

    async beautifyText(text: string, opts?: { relatedNotes?: boolean; imageCaptions?: boolean }): Promise<string> {
        const relatedRule = opts?.relatedNotes
            ? `RELATED TOPICS: The === RELATED NOTE CANDIDATES === section in the user message lists vault notes similar to this page. You MAY add a "## Related Notes" section at the very end: one bullet per link ("- [[Name]] - one-line reason"). Rules: ONLY names exactly as listed; NEVER invent or guess a link target; NEVER relink a note that already appears in the page or in its frontmatter.`
            : `RELATED TOPICS: Do NOT add a "Related Notes" section and do NOT introduce any new wiki links ([[...]]) for related notes. Only keep links the user already wrote.`;
        const imageRule = opts?.imageCaptions
            ? `IMAGE CAPTIONS: The === EMBEDDED IMAGE TRANSCRIPTIONS === section provides extracted text for some embedded images. For each image with a transcription, you MAY add, directly under its embed line (e.g. ![[photo.png]]), an indented italic line "> *Caption text.*" describing that image using ONLY the transcription. NEVER change the embed line itself, NEVER remove or replace an image, and NEVER add a caption for an image without a transcription.`
            : `IMAGE CAPTIONS: Do NOT add captions to images and do not modify any existing image embed lines.`;

        const systemPrompt = `You are an elite copyeditor and Markdown formatting expert for an Obsidian vault.
The user message contains a document wrapped in === NOTE CONTENT TO BEAUTIFY ===...================================, followed by INFORMATION-ONLY sections (=== EMBEDDED IMAGE TRANSCRIPTIONS === and === RELATED NOTE CANDIDATES ===) that describe supporting material. Beautify ONLY the NOTE CONTENT block. The support sections and all === markers MUST NOT appear in your output.

PRESERVATION CONTRACT:
1. Fix grammatical errors, typos, and awkward phrasing.
2. Do NOT summarize, delete, merge, or reorder information, and never change factual meaning.
3. Do NOT invent facts, names, figures, or ideas. Spelling corrections of clearly-typoed words are allowed.
4. Preserve the note's frontmatter, existing wiki links, tags, callouts, and embeds verbatim; beautify the prose around them, never their syntax.

OBSIDIAN DEFAULT MARKDOWN - prefer these native features everywhere they fit:
- Callouts: > [!note] / [!summary] / [!info] / [!tip] / [!success] / [!question] / [!warning] / [!failure] / [!danger] / [!example] / [!quote], each followed by an optional bold title on the same line. Collapsible versions use > [!type]+ (start open) or > [!type]- (start closed).
- Interactive tasks: "- [ ] pending" and "- [x] done", with two-space indented subtasks for breakdowns.
- Tables (with alignment) for attribute lists, comparisons, schedules, and any structured data.
- ==highlights== around the single most important term in a sentence.
- Wiki links [[Note Name]] only per the RELATED TOPICS rule below.
- Footnotes [^1] with their definitions collected at the very end, for citations and asides that would otherwise break the flow.
- HTML comments <!-- ... --> to leave reviewer notes, status flags, or rationale that a human reviewer should see without rendering on the page.
- Headings h2/h3 for structure; do not create an h1 (Obsidian already shows the file title). Never auto-number headings.

REVIEWABILITY RULES:
- Open with a one-line > [!summary] callout stating what this page is about.
- Keep all headings parallel in phrasing, a consistent hierarchy, and one section per distinct idea.
- Convert attribute/comparison lists into tables, and every action item, open question, or deferred decision into "- [ ]" tasks.
- Group pending tasks under a "## Tasks" heading near the END of the page, inside a single collapsible > [!todo]+ callout.
- For pages of 80+ lines, add a "> [!note]+ On This Page" callout immediately after the summary listing its h2 sections.
- Keep paragraphs to at most 3 short sentences; prefer bold/italic over ALL CAPS.

${relatedRule}

${imageRule}

OUTPUT CONTRACT:
- Output ONLY the beautified note. No preamble, no "Here is...", no commentary, no extra sections beyond the two permitted augmentations above.
- The output must contain 100% of the information from the NOTE CONTENT block and none of the support material.`;

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
