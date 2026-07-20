import { PluginSettings } from './types';
import { requestUrl } from 'obsidian';
import { RelationEdge } from './relationStore';

export class RelationExtractor {
    settings: PluginSettings;

    constructor(settings: PluginSettings) {
        this.settings = settings;
    }

    constructPrompt(sourcePath: string, sourceText: string, candidates: {path: string, text: string}[]): string {
        const candidateContext = candidates.map(c => `File: ${c.path}\nContent:\n${c.text}`).join('\n\n---\n\n');
        
        return `You are a knowledge graph extraction assistant.
You are given a Source Note and a list of Candidate Notes.
Determine the conceptual relationships between the Source Note and the Candidate Notes.

Source Note File: ${sourcePath}
Source Note Content:
${sourceText}

Candidate Notes:
${candidateContext}

Extract any strong relationships as JSON. 
Format your output STRICTLY as a JSON object with two keys: "relations" and "profileInsights".
{
  "relations": [
    {
      "target": "path of the candidate note",
      "relationType": "duplicate-effort" | "prerequisite" | "contradicts" | "extends" | "thematic-only",
      "confidence": 0.8,
      "evidence": "A short snippet or explanation why they relate"
    }
  ],
  "profileInsights": "If the Source Note contains information about the user's current mood, active projects, or important life events, summarize it briefly here. Otherwise, set this to null."
}

CRITICAL RULES:
1. For "relationType", you MUST pick exactly one of these five fixed strings: "duplicate-effort", "prerequisite", "contradicts", "extends", or "thematic-only". Do NOT write freeform prose for relationType.
2. Output only valid JSON, no markdown formatting or extra text.
3. If there are no relationships, output {"relations": [], "profileInsights": null}.`;
    }

    async extractRelations(prompt: string, sourcePath: string): Promise<{ edges: RelationEdge[], profileInsights: string | null }> {
        let jsonStr = '';
        if (this.settings.provider === 'ollama') {
            const url = this.settings.baseUrl.replace(/\/$/, '') + '/api/generate';
            const res = await requestUrl({
                url,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: this.settings.llmModelName || 'llama3',
                    prompt: prompt,
                    stream: false,
                    format: 'json'
                })
            });
            if (res.status !== 200) throw new Error('Ollama generation failed');
            jsonStr = res.json.response;
        } else {
            // OpenRouter OpenAI-compatible endpoint
            const url = this.settings.baseUrl.replace(/\/$/, '') + '/chat/completions';
            const res = await requestUrl({
                url,
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.settings.apiKey}`
                },
                body: JSON.stringify({
                    model: this.settings.llmModelName || 'meta-llama/llama-3-8b-instruct',
                    messages: [{ role: 'user', content: prompt }]
                })
            });
            if (res.status !== 200) throw new Error('OpenRouter generation failed');
            jsonStr = res.json.choices[0].message.content;
        }

        try {
            let cleanStr = jsonStr;
            const match = jsonStr.match(/\{[\s\S]*\}/);
            if (match) {
                cleanStr = match[0];
            } else {
                cleanStr = jsonStr.replace(/```json/g, '').replace(/```/g, '').trim();
            }
            const parsed = JSON.parse(cleanStr);
            const array = parsed.relations || [];
            
            const edges = array.map((item: any) => ({
                source: sourcePath,
                target: item.target || 'unknown',
                relationType: item.relationType || item.relation || 'thematic-only',
                confidence: typeof item.confidence === 'number' ? item.confidence : 0.5,
                evidence: item.evidence || ''
            }));
            
            const profileInsights = typeof parsed.profileInsights === 'string' ? parsed.profileInsights : null;

            return { edges, profileInsights };
        } catch (e) {
            console.error('Failed to parse JSON from LLM:', jsonStr);
            return { edges: [], profileInsights: null };
        }
    }
}
