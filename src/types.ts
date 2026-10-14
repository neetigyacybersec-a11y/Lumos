import { TFile } from 'obsidian';
import { ApiFormat, DEFAULT_BASE_URL } from './llm/providerConfig';

export interface PluginSettings {
	apiFormat: ApiFormat;
	baseUrl: string;
	llmModelName: string;
	visionModelName: string;
	embeddingModelName: string;
	apiKey?: string;
	autoAddBacklinks: boolean;
	backlinkConfidenceThreshold: number;
	displayThreshold: number;
	enableUserProfile: boolean;
	userProfilePath: string;
	userProfileWordThreshold: number;
	ignoredFolders: string;
	googleClientId: string;
	googleClientSecret: string;
	googleRefreshToken: string;
	googleSyncEnabled: boolean;
	enableHybridSearch: boolean;
	rerankerModel: 'off' | 'tiny' | 'mini';
	rerankCandidates: number;
	requestTimeoutSec: number;
	beautifyAddRelatedNotes: boolean;
	beautifyAddImageCaptions: boolean;
	beautifyRelatedTopK: number;
	beautifyCacheEnabled: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
	apiFormat: 'ollama',
	baseUrl: DEFAULT_BASE_URL.ollama,
	llmModelName: 'openai/gpt-4o-mini',
	visionModelName: 'openai/gpt-4o-mini',
	embeddingModelName: 'openai/text-embedding-3-small',
	autoAddBacklinks: false,
	backlinkConfidenceThreshold: 0.8,
	displayThreshold: 0.8,
	enableUserProfile: true,
	userProfilePath: 'User_Profile_AI.md',
	userProfileWordThreshold: 500,
	ignoredFolders: 'Private, Secrets, .obsidian',
	googleClientId: '',
	googleClientSecret: '',
	googleRefreshToken: '',
	googleSyncEnabled: false,
	enableHybridSearch: true,
	rerankerModel: 'off',
	rerankCandidates: 20,
	requestTimeoutSec: 60,
	beautifyAddRelatedNotes: true,
	beautifyAddImageCaptions: true,
	beautifyRelatedTopK: 5,
	beautifyCacheEnabled: true,
}

/**
 * Merges persisted data over the defaults and migrates the legacy v1 `provider`
 * field (`'ollama' | 'openrouter'`) onto the protocol-based `apiFormat`. An
 * explicit `apiFormat` always wins, and the stale key is dropped so it is not
 * written back.
 */
export function resolveSettings(saved: any): PluginSettings {
	const merged = Object.assign({}, DEFAULT_SETTINGS, saved) as PluginSettings & { provider?: string };
	if (saved && typeof saved.provider === 'string' && !saved.apiFormat) {
		merged.apiFormat = saved.provider === 'ollama' ? 'ollama' : 'openai';
	}
	delete (merged as any).provider;
	return merged;
}

export interface ParsedNote {
	cleanText: string;
	wikilinks: string[];
	tags: string[];
}
