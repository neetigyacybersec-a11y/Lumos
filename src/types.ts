import { TFile } from 'obsidian';

export interface PluginSettings {
	provider: 'ollama' | 'openrouter';
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
}

export const DEFAULT_SETTINGS: PluginSettings = {
	provider: 'ollama',
	baseUrl: 'http://localhost:11434',
	llmModelName: 'openai/gpt-4o-mini',
	visionModelName: 'openai/gpt-4o-mini',
	embeddingModelName: 'openai/text-embedding-3-small',
	autoAddBacklinks: false,
	backlinkConfidenceThreshold: 0.8,
	displayThreshold: 0.8,
	enableUserProfile: true,
	userProfilePath: 'User_Profile_AI.md',
	userProfileWordThreshold: 500,
}

export interface QueuedFile {
	file: TFile;
	timestamp: number;
}

export interface ParsedNote {
	cleanText: string;
	wikilinks: string[];
	tags: string[];
}
