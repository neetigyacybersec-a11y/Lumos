import { RelationEdge } from './relationStore';

export function getSortedEdgesForPath(edges: RelationEdge[], currentPath: string): RelationEdge[] {
    // Filter out dismissed edges
    const active = edges.filter(e => !e.dismissed);
    // Sort by overall score descending, fallback to confidence
    return active.sort((a, b) => {
        const scoreA = a.scores?.overall ?? a.confidence;
        const scoreB = b.scores?.overall ?? b.confidence;
        return scoreB - scoreA;
    });
}

export function formatEdge(edge: RelationEdge, currentPath: string) {
    const isSource = edge.source === currentPath;
    const displayPath = isSource ? edge.target : edge.source;
    
    return {
        displayPath,
        relationType: edge.relationType || (edge as any).relation, // Backwards compatible
        evidence: edge.evidence,
        confidence: edge.confidence,
        scores: edge.scores
    };
}
