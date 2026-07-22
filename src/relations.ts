import { Logger } from './logger';
import { RelationEdge } from './relationStore';
import LumosPlugin from './main';

export class RelationExtractor {
    plugin: LumosPlugin;

    constructor(plugin: LumosPlugin) {
        this.plugin = plugin;
    }

    constructPrompt(sourcePath: string, sourceText: string, candidates: {path: string, text: string}[]): string {
        const candidateContext = candidates.map(c => `File: ${c.path}\nContent:\n${c.text}`).join('\n\n---\n\n');
        
        return `You are a knowledge graph extraction assistant.
You are given a Source Note (which could be a markdown file, image, or Calendar Event) and a list of Candidate Notes.
Determine the conceptual relationships between the Source Note and the Candidate Notes. Note that some candidates might be Google Calendar Events (indicated by [Google Calendar Event] in their content).

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
      "relationType": "duplicate-effort" | "prerequisite" | "contradicts" | "extends" | "thematic-only" | "discusses-meeting" | "follows-up",
      "confidence": 0.8,
      "evidence": "A short snippet or explanation why they relate"
    }
  ],
  "profileInsights": "If the Source Note contains information about the user's current mood, active projects, or important life events, summarize it briefly here. Otherwise, set this to null."
}

CRITICAL RULES:
1. For "relationType", you MUST pick exactly one of these fixed strings: "duplicate-effort", "prerequisite", "contradicts", "extends", "thematic-only", "discusses-meeting", or "follows-up". Do NOT write freeform prose for relationType.
2. Output only valid JSON, no markdown formatting or extra text.
3. If there are no relationships, output {"relations": [], "profileInsights": null}.`;
    }

    async extractRelations(prompt: string, sourcePath: string): Promise<{ edges: RelationEdge[], profileInsights: string | null }> {
        const messages: any[] = [{ role: 'user', content: prompt }];
        let jsonStr = '';
        
        try {
            jsonStr = await this.plugin.llmService.callLLM(messages, false, true);
        } catch (e) {
            Logger.error('LLM generation failed in relations:', e);
            return { edges: [], profileInsights: null };
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
            Logger.error('Failed to parse JSON from LLM:', jsonStr);
            return { edges: [], profileInsights: null };
        }
    }
}
