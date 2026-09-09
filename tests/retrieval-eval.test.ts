import { describe, it, expect } from 'vitest';
import { VectorStore } from '../src/vectorStore';
import { MirroredIndex } from '../src/search/mirroredIndex';
import { HybridRetriever } from '../src/search/hybridRetriever';
import { Reranker } from '../src/search/reranker';

/**
 * Retrieval-quality evaluation harness. NOT part of CI: run locally with a
 * real Ollama (nomic-embed-text) and, for the rerank leg, network access to
 * Hugging Face on first use:
 *
 *   LUMOS_EVAL=1 npx vitest run tests/retrieval-eval.test.ts
 */

const OLLAMA = process.env.LUMOS_OLLAMA_URL ?? 'http://localhost:11434';
const EMBED_MODEL = 'nomic-embed-text';
const RUN = !!process.env.LUMOS_EVAL;

interface Fixture {
    path: string;
    text: string;
}

const CORPUS: Fixture[] = [
    { path: 'k8s-ops.md', text: 'Kubernetes cluster autoscaling with the cluster-autoscaler. Pod disruption budgets, node pools, and horizontal pod autoscaling for microservices deployments.' },
    { path: 'pasta.md', text: 'Sunday pasta recipe. Slow tomato sauce with basil, garlic, olive oil. Fresh semolina dough rolled by hand for tagliatelle.' },
    { path: 'incident-cve.md', text: 'Security postmortem: CVE-2024-3094 xz utils backdoor supply chain attack. Detection steps, affected versions, incident response timeline.' },
    { path: 'quantum-notes.md', text: 'Quantum computing fundamentals. Qubits, superposition, entanglement, Shor algorithm for factoring, error correction thresholds.' },
    { path: 'trip-japan.md', text: 'Japan trip itinerary. Tokyo to Kyoto by shinkansen, ryokan booking, cherry blossom forecast late March, JR pass activation.' },
    { path: 'ml-training.md', text: 'Training large language models. Distributed data parallel, gradient accumulation, learning rate warmup schedules, mixed precision losses.' },
    { path: 'garden-soil.md', text: 'Vegetable garden soil preparation. Compost ratios, nitrogen fixing beans, mulching depth, pH testing kits in early spring.' },
    { path: 'meeting-q3.md', text: 'Q3 planning meeting minutes. Roadmap priorities, headcount request approved, migration deadline moved to October, action items assigned.' },
    { path: 'rust-borrow.md', text: 'Rust ownership and borrow checker notes. Lifetimes explained, shared versus mutable references, Rc RefCell patterns.' },
    { path: 'sleep-study.md', text: 'Sleep research summary. Circadian rhythm alignment, caffeine half-life effects, deep sleep stages, blue light exposure evening.' },
];

// query -> the only relevant file
const GOLDEN: { query: string; relevant: string }[] = [
    { query: 'how do I scale my kubernetes pods automatically', relevant: 'k8s-ops.md' },
    { query: 'CVE-2024-3094', relevant: 'incident-cve.md' },
    { query: 'xz utils backdoor postmortem', relevant: 'incident-cve.md' },
    { query: 'homemade tagliatelle tomato sauce', relevant: 'pasta.md' },
    { query: 'what is entanglement and shor algorithm', relevant: 'quantum-notes.md' },
    { query: 'kyoto cherry blossom itinerary timing', relevant: 'trip-japan.md' },
    { query: 'learning rate warmup distributed training', relevant: 'ml-training.md' },
    { query: 'compost ratio for vegetable beds', relevant: 'garden-soil.md' },
    { query: 'q3 roadmap action items meeting outcome', relevant: 'meeting-q3.md' },
    { query: 'borrow checker lifetime explanations', relevant: 'rust-borrow.md' },
    { query: 'caffeine effect on deep sleep stages', relevant: 'sleep-study.md' },
    // identifier-style query dense retrieval typically fails
    { query: 'supply chain attack detection steps', relevant: 'incident-cve.md' },
];

async function ollamaEmbed(text: string): Promise<number[]> {
    const res = await fetch(`${OLLAMA.replace(/\/$/, '')}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
    });
    if (!res.ok) throw new Error(`Ollama embed failed (${res.status})`);
    const json: any = await res.json();
    return json.embedding;
}

// --- metrics over single-relevant-doc judgments ---
function rankOf(results: { filePath: string }[], relevant: string): number {
    const idx = results.findIndex((r) => r.filePath === relevant);
    return idx === -1 ? -1 : idx + 1;
}
const mrr = (ranks: number[]) =>
    ranks.reduce((s, r) => s + (r > 0 ? 1 / r : 0), 0) / ranks.length;
const recall10 = (ranks: number[]) => ranks.filter((r) => r > 0 && r <= 10).length / ranks.length;
const ndcg10 = (ranks: number[]) =>
    ranks.reduce((s, r) => s + (r > 0 && r <= 10 ? 1 / Math.log2(r + 2) : 0), 0) / ranks.length;

function report(name: string, ranks: number[]) {
    const line = `${name.padEnd(24)} Recall@10=${recall10(ranks).toFixed(3)}  MRR@10=${mrr(ranks).toFixed(3)}  nDCG@10=${ndcg10(ranks).toFixed(3)}`;
    console.log(`[EVAL] ${line}`);
    return line;
}

describe.skipIf(!RUN)('retrieval quality eval (LUMOS_EVAL=1)', () => {
    it('compares dense-only vs hybrid vs hybrid+reranker', async () => {
        const plugin: any = {
            settings: {
                enableHybridSearch: true,
                rerankerModel: 'off',
                rerankCandidates: 20,
                provider: 'ollama',
                baseUrl: OLLAMA,
                embeddingModelName: EMBED_MODEL,
            },
            embeddingPipeline: { embed: ollamaEmbed },
            vectorStore: null as any,
        };
        const vectorStore = new VectorStore(plugin);
        plugin.vectorStore = vectorStore;

        const mirrored = new MirroredIndex();
        mirrored.attach(vectorStore);
        const lexical = mirrored.lexical;

        for (const f of CORPUS) {
            await vectorStore.upsert(f.path, [
                {
                    id: `${f.path}#0`,
                    filePath: f.path,
                    text: f.text,
                    embedding: await ollamaEmbed(f.text),
                    contentHash: 'eval',
                },
            ]);
        }

        // Leg A: dense-only baseline
        const denseRanks: number[] = [];
        for (const g of GOLDEN) {
            const vec = await ollamaEmbed(g.query);
            const res = await vectorStore.querySimilar(vec, 10);
            denseRanks.push(rankOf(res, g.relevant));
        }
        report('dense only', denseRanks);

        // Leg B: hybrid (RRF)
        const reranker = new Reranker(null);
        const hybridRetriever = new HybridRetriever(plugin, lexical, reranker);
        const hybridRanks: number[] = [];
        for (const g of GOLDEN) {
            const res = await hybridRetriever.retrieve({ query: g.query, topK: 10 });
            hybridRanks.push(rankOf(res, g.relevant));
        }
        report('hybrid (RRF k=60)', hybridRanks);

        // Leg C: hybrid + local reranker (downloads model on first run)
        plugin.settings.rerankerModel = 'tiny';
        const rerankRanks: number[] = [];
        let rerankAvailable = true;
        for (const g of GOLDEN) {
            const res = await hybridRetriever.retrieve({ query: g.query, topK: 10 });
            if (!res.length) rerankAvailable = false;
            rerankRanks.push(rankOf(res, g.relevant));
        }
        if (rerankAvailable) report('hybrid + tiny reranker', rerankRanks);
        else console.log('[EVAL] reranker unavailable; skipping leg C');

        // Hybrid must not be worse than dense-only on this set.
        expect(ndcg10(hybridRanks)).toBeGreaterThanOrEqual(ndcg10(denseRanks) - 0.05);
    }, 600000);
});
