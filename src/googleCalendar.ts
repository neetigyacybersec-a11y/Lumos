import { Logger } from './logger';
import { requestUrl } from "obsidian";
import LumosPlugin from "./main";
import { getGoogleAuthToken } from "./googleAuth";

export interface GoogleEvent {
    id: string;
    summary: string;
    description?: string;
    start: { dateTime?: string, date?: string };
    end: { dateTime?: string, date?: string };
    attendees?: { email: string, displayName?: string }[];
    htmlLink: string;
}

export async function fetchAllCalendarEvents(plugin: LumosPlugin, daysBack: number = 30, daysForward: number = 30): Promise<GoogleEvent[]> {
    if (!plugin.settings.googleSyncEnabled) return [];

    const token = await getGoogleAuthToken(plugin);
    if (!token) return [];

    const timeMin = new Date();
    timeMin.setDate(timeMin.getDate() - daysBack);
    
    const timeMax = new Date();
    timeMax.setDate(timeMax.getDate() + daysForward);

    const allEvents: GoogleEvent[] = [];

    try {
        // 1. Fetch list of calendars
        const calendarListResponse = await requestUrl({
            method: 'GET',
            url: `https://www.googleapis.com/calendar/v3/users/me/calendarList`,
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (calendarListResponse.json && calendarListResponse.json.items) {
            const calendars = calendarListResponse.json.items;

            // 2. Fetch events for each calendar
            for (const calendar of calendars) {
                try {
                    let pageToken = "";
                    do {
                        let url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendar.id)}/events?maxResults=2500&singleEvents=true&orderBy=startTime&timeMin=${timeMin.toISOString()}&timeMax=${timeMax.toISOString()}`;
                        if (pageToken) {
                            url += `&pageToken=${pageToken}`;
                        }

                        const eventsResponse = await requestUrl({
                            method: 'GET',
                            url: url,
                            headers: {
                                'Authorization': `Bearer ${token}`
                            }
                        });

                        if (eventsResponse.json && eventsResponse.json.items) {
                            allEvents.push(...eventsResponse.json.items.filter((e: any) => e.status !== 'cancelled'));
                            pageToken = eventsResponse.json.nextPageToken || "";
                        } else {
                            pageToken = "";
                        }
                    } while (pageToken);
                } catch (e) {
                    Logger.error(`Failed to fetch events for calendar ${calendar.summary}`, e);
                }
            }
        }
    } catch (e) {
        Logger.error("Failed to fetch Google Calendars", e);
    }
    
    return allEvents;
}
