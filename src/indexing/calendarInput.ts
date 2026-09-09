import { GoogleEvent } from '../googleCalendar';
import { IndexInput } from './indexFileFlow';

/**
 * IndexInput strategy for Google Calendar events. Events are stored under a
 * virtual `gcal://<id>` path. They score by plain confidence (the scoring
 * engine expects TFile) and have no backlinks/insights/activity side effects.
 */
export class CalendarInput implements IndexInput {
    readonly path: string;
    private readonly text: string;

    constructor(event: GoogleEvent) {
        this.path = `gcal://${event.id}`;
        const startDate = event.start.dateTime ? new Date(event.start.dateTime).toLocaleString() : event.start.date;
        let text = `[Google Calendar Event]\nTitle: ${event.summary}\nDate: ${startDate}\n`;
        if (event.description) text += `Description: ${event.description}\n`;
        if (event.attendees && event.attendees.length > 0) {
            const attendees = event.attendees.map(a => a.displayName || a.email).join(', ');
            text += `Attendees: ${attendees}\n`;
        }
        this.text = text;
    }

    extractText() {
        return { text: this.text, madeNetworkCall: false };
    }

    promptSource(text: string): string {
        return text;
    }

    async score(edges: any[]): Promise<any[]> {
        return edges.map(edge => ({
            ...edge,
            scores: { overall: edge.confidence, llm: edge.confidence, cosine: 0, keyword: 0, folder: 0, recency: 0 },
        }));
    }

    mergeOnPartial(_existing: any[], scored: any[]): any[] {
        return scored;
    }

    async afterPersist(): Promise<void> {}

    async onNoRelations(): Promise<void> {}
}