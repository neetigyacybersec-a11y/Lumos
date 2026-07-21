import { requestUrl, TFile } from 'obsidian';
import LumosPlugin from './main';

export interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
}

export class ChatLogic {
    // We maintain a sliding window of the last 10 messages for context
    private chatHistory: { role: string, content: string }[] = [];
    private maxHistory = 10; 
    private isProcessing = false;
    plugin: LumosPlugin;

    constructor(plugin: LumosPlugin) {
        this.plugin = plugin;
    }

    private async callLLM(messages: ChatMessage[], isRouting: boolean = false): Promise<string> {
        let resultText = '';
        if (this.plugin.settings.provider === 'ollama') {
            const url = this.plugin.settings.baseUrl.replace(/\/$/, '') + '/api/chat';
            const res = await requestUrl({
                url,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: this.plugin.settings.llmModelName || 'llama3',
                    messages: messages,
                    stream: false
                })
            });
            if (res.status !== 200) throw new Error('Ollama generation failed');
            resultText = res.json.message.content;
        } else {
            const url = this.plugin.settings.baseUrl.replace(/\/$/, '') + '/chat/completions';
            const res = await requestUrl({
                url,
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.plugin.settings.apiKey}`
                },
                body: JSON.stringify({
                    model: this.plugin.settings.llmModelName || 'meta-llama/llama-3-8b-instruct',
                    messages: messages
                })
            });
            if (res.status !== 200) throw new Error('OpenRouter generation failed');
            resultText = res.json.choices[0].message.content;
        }
        return resultText;
    }

    async generateResponse(query: string, history: ChatMessage[]): Promise<string> {
        try {
            // 1. Smart RAG: Determine if search is needed
            let retrievedContext = '';
            try {
                const searchDeciderPrompt: ChatMessage[] = [
                    { role: 'system', content: 'You are an internal routing AI. You must be EXTREMELY AGGRESSIVE about searching the user\'s vault. Unless the user is explicitly saying a generic greeting (like "hello") or a one-word acknowledgment (like "ok"), you MUST output a search query. Output a concise search query (1-5 words) to find related notes. ONLY output exactly "NO_SEARCH" if a search would be completely nonsensical. Only output the query or "NO_SEARCH". Do not explain.' },
                    ...history,
                    { role: 'user', content: query }
                ];
                
                const searchDecision = await this.callLLM(searchDeciderPrompt, true);
                
                if (searchDecision && !searchDecision.includes('NO_SEARCH')) {
                    const cleanQuery = searchDecision.replace(/["']/g, '').trim();
                    console.log('[ChatLogic] Smart RAG triggering search for:', cleanQuery);
                    const queryEmbedding = await this.plugin.embeddingPipeline.embed(cleanQuery);
                    // Top 3 similar chunks
                    const similar = this.plugin.vectorStore.querySimilar(queryEmbedding, 3);
                    if (similar.length > 0) {
                        retrievedContext = similar.map(c => `File: ${c.filePath}\nContent:\n${c.text}`).join('\n\n---\n\n');
                    }
                } else {
                    console.log('[ChatLogic] Smart RAG determined no search needed.');
                }
            } catch (e) {
                console.error('[ChatLogic] Failed to retrieve RAG context:', e);
                // Non-fatal, continue without RAG
            }

            // 2. Profile: Retrieve User Profile
            let userProfile = '';
            try {
                const profilePath = this.plugin.settings.userProfilePath;
                const file = this.plugin.app.vault.getAbstractFileByPath(profilePath);
                if (file instanceof TFile) {
                    userProfile = await this.plugin.app.vault.read(file);
                }
            } catch (e) {
                console.error('[ChatLogic] Failed to read user profile:', e);
            }

            // 3. Construct System Prompt
            let systemPrompt = `[IDENTITY & ROLE]
You are an amalgamation of a fiercely loyal best friend, a sharply witty comedian, and a highly grounded psychotherapist. You possess high emotional intelligence, a razor-sharp sense of humor, and absolutely zero tolerance for BS—especially your own.

[CORE DIRECTIVES - THE NON-NEGOTIABLES]
1. ANTI-SYCOPHANCY (Do NOT agree with everything)
You are strictly forbidden from being a yes-man. Default validation is toxic. If the user says something irrational, self-destructive, or factually incorrect, you must gently but firmly call it out. Play devil’s advocate. Challenge their cognitive distortions.

2. ANTI-HALLUCINATION (The Truth Boundary)
You do not invent facts, statistics, quotes, or citations. If you are not 100% certain of a factual claim, you must not generate it. Your knowledge cutoff is real, and you respect it.

3. THE IGNORANCE PROTOCOL (Admitting you don't know)
When faced with a factual question you cannot answer, you will use the following exact phrasing or a close variation: "I genuinely don't know, and I'm not going to hallucinate an answer to sound smart." Never guess. Never bluff.

[PERSONALITY & TONE GUIDELINES]
Witty & Observational: Your humor is dry, clever, and observational. You use metaphors and analogies to make heavy topics digestible.
Warm but Sharp: You clearly care about the user's well-being, but you show it by being honest, not by coddling them.
Disarming, not Deflecting: Use humor to disarm tension and provide perspective, never to mock the user's pain or deflect from a serious topic.
Conversational: Write like a human texting or talking on a couch. No robotic transitions like "Furthermore," "In conclusion," or "It is important to note."

[THE THERAPIST-FRIEND HYBRID FRAMEWORK]
As a Friend: You use slang (naturally, not cringingly), pop culture references, and casual syntax. You take their side emotionally while remaining objective logically.
As a Therapist: You subtly utilize principles of Cognitive Behavioral Therapy (CBT), Stoicism, and mindfulness. You ask probing questions. You help them untangle their thoughts rather than tying the knot tighter.
Disclaimer: If the user expresses intent to harm themselves or others, drop the humor immediately, state clearly that you are an AI and not a medical professional, and provide a crisis resource.`;
            
            if (userProfile && userProfile.trim().length > 0) {
                systemPrompt += `\n\nYour knowledge of the user is summarized below. Use this to personalize your tone and recommendations:\n=== USER PROFILE ===\n${userProfile}\n====================`;
            }

            if (retrievedContext && retrievedContext.trim().length > 0) {
                systemPrompt += `\n\nTo help you answer the user's latest query, here are some highly relevant notes retrieved from their vault:\n=== RETRIEVED CONTEXT ===\n${retrievedContext}\n====================\nIncorporate this information into your answer if it is relevant to their question.`;
            }

            // 4. Construct final messages payload
            const messages: ChatMessage[] = [
                { role: 'system', content: systemPrompt },
                ...history,
                { role: 'user', content: query }
            ];

            // 5. API Call
            const resultText = await this.callLLM(messages);

            return resultText;
        } catch (error) {
            console.error('[ChatLogic] Generation error:', error);
            throw error;
        }
    }
}
