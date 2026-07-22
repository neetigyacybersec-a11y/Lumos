import { Logger } from './logger';
import { Notice, Platform, requestUrl } from "obsidian";
import LumosPlugin from "./main";

const PORT = 42813;
const REDIRECT_URL = `http://127.0.0.1:${PORT}/callback`;
const PUBLIC_CLIENT_ID = `783376961232-v90b17gr1mj1s2mnmdauvkp77u6htpke.apps.googleusercontent.com`;

let authSession = { server: null as any, verifier: null as any, challenge: null as any, state: null as any };

function generateState(): string {
	return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

async function generateVerifier(): Promise<string> {
	const array = new Uint8Array(56);
	await window.crypto.getRandomValues(array);
	return Array.from(array, dec => ('0' + dec.toString(16)).substr(-2)).join('');
}

async function generateChallenge(verifier: string): Promise<string> {
	const data = new TextEncoder().encode(verifier);
	const hash = await window.crypto.subtle.digest('SHA-256', data);
	return btoa(String.fromCharCode(...new Uint8Array(hash)))
		.replace(/=/g, '')
		.replace(/\+/g, '-')
		.replace(/\//g, '_');
}

let cachedAccessToken: string | null = null;
let tokenExpirationTime: number = 0;

export async function refreshAccessToken(plugin: LumosPlugin): Promise<string | null> {
    if (!plugin.settings.googleRefreshToken) return null;

	const useCustomClient = !!plugin.settings.googleClientId;
    const clientId = useCustomClient ? plugin.settings.googleClientId.trim() : PUBLIC_CLIENT_ID;

	const refreshBody = {
		grant_type: "refresh_token",
		client_id: clientId,
		client_secret: useCustomClient ? plugin.settings.googleClientSecret.trim() : null,
		refresh_token: plugin.settings.googleRefreshToken,
	};

    try {
        const url = useCustomClient ? `https://oauth2.googleapis.com/token` : `https://obsidian-google-calendar.vercel.app/api/google/refresh`;
        const { json: tokenData } = await requestUrl({
            method: 'POST',
            url: url,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(refreshBody)
        });

        if (!tokenData || !tokenData.access_token) {
            Logger.error("Error while refreshing authentication", tokenData);
            return null;
        }
        
        cachedAccessToken = tokenData.access_token;
        tokenExpirationTime = +new Date() + tokenData.expires_in * 1000;
        return cachedAccessToken;
    } catch (e) {
        Logger.error("Failed to refresh token", e);
        return null;
    }
}

export async function getGoogleAuthToken(plugin: LumosPlugin): Promise<string | null> {
	if (!plugin.settings.googleRefreshToken) return null;

	if (cachedAccessToken && tokenExpirationTime > +new Date()) {
        return cachedAccessToken;
    }

    return await refreshAccessToken(plugin);
}

const exchangeCodeForTokenDefault = async (state: string, verifier: string, code: string): Promise<any> => {
	const request = await requestUrl({
		method: 'POST',
		url: `https://obsidian-google-calendar.vercel.app/api/google/token`,
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			"client_id": PUBLIC_CLIENT_ID,
			"code_verifier": verifier,
			"code": code,
			"state": state,
		})
	});

	return request.json;
}

const exchangeCodeForTokenCustom = async (plugin: LumosPlugin, state: string, verifier: string, code: string): Promise<any> => {
	const url = `https://oauth2.googleapis.com/token`
		+ `?grant_type=authorization_code`
		+ `&client_id=${plugin.settings.googleClientId.trim()}`
		+ `&client_secret=${plugin.settings.googleClientSecret.trim()}`
		+ `&code_verifier=${verifier}`
		+ `&code=${code}`
		+ `&state=${state}`
		+ `&redirect_uri=${REDIRECT_URL}`;

	const response = await fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
	});

	return response.json();
}

export async function loginGoogle(plugin: LumosPlugin, onComplete: () => void): Promise<void> {
	const useCustomClient = !!plugin.settings.googleClientId;
	const CLIENT_ID = useCustomClient ? plugin.settings.googleClientId : PUBLIC_CLIENT_ID;

	if (!Platform.isDesktop) {
		new Notice("Can't use this OAuth method on mobile devices.");
		return;
	}

	if (!authSession.state) {
		authSession.state = generateState();
		authSession.verifier = await generateVerifier();
		authSession.challenge = await generateChallenge(authSession.verifier);
	}

	// Auto-close server if not completed in 5 minutes to prevent port leak
	setTimeout(() => {
		closeAuthServer();
	}, 5 * 60 * 1000);

	const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth'
		+ `?client_id=${CLIENT_ID}`
		+ `&response_type=code`
		+ `&redirect_uri=${REDIRECT_URL}`
		+ `&prompt=consent`
		+ `&access_type=offline`
		+ `&state=${authSession.state}`
		+ `&code_challenge=${authSession.challenge}`
		+ `&code_challenge_method=S256`
		+ `&scope=https://www.googleapis.com/auth/calendar.readonly%20https://www.googleapis.com/auth/calendar.events`;

	if (authSession.server) {
		require('electron').shell.openExternal(authUrl);
		return;
	}

	const http = require("http");
	const url = require("url");

	authSession.server = http
		.createServer(async (req: any, res: any) => {
			try {
				if (req.url.indexOf("/callback") < 0) return;

				const qs = new url.URL(
					req.url,
					`http://127.0.0.1:${PORT}`
				).searchParams;
				const code = qs.get("code");
				const received_state = qs.get("state");

				if (received_state !== authSession.state) {
					return;
				}
				
				let token;
				if (useCustomClient) {
					token = await exchangeCodeForTokenCustom(plugin, authSession.state, authSession.verifier, code);
				} else {
					token = await exchangeCodeForTokenDefault(authSession.state, authSession.verifier, code);
				}

				if (token?.refresh_token) {
					plugin.settings.googleRefreshToken = token.refresh_token;
                    await plugin.saveSettings();
                    
                    cachedAccessToken = token.access_token;
                    tokenExpirationTime = +new Date() + token.expires_in * 1000;
				}

				res.end("Authentication successful! Please return to Obsidian.");

				authSession.server.close();
				new Notice("Google Calendar Login successful!");
                onComplete();

			} catch (e) {
				Logger.error("Auth failed", e);
				authSession.server.close();
			}
			authSession = { server: null, verifier: null, challenge: null, state: null };
		})
		.listen(PORT, async () => {
			require('electron').shell.openExternal(authUrl);
		});
}

export function closeAuthServer() {
	if (authSession.server) {
		try {
			authSession.server.close();
		} catch (e) {
			Logger.error("Failed to close auth server", e);
		}
		authSession.server = null;
	}
	authSession = { server: null, verifier: null, challenge: null, state: null };
}
