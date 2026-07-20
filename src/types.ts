import { TFile } from 'obsidian';

export interface PluginSettings {
	provider: 'ollama' | 'openrouter';
	baseUrl: string;
	modelName: string;
	embeddingModelName: string;
	apiKey?: string;
	autoAddBacklinks: boolean;
	backlinkConfidenceThreshold: number;
	displayThreshold: number;
}

export const DEFAULT_SETTINGS: PluginSettings = {
	provider: 'ollama',
	baseUrl: 'http://localhost:11434',
	modelName: '',
	embeddingModelName: '',
	autoAddBacklinks: false,
	backlinkConfidenceThreshold: 0.8,
	displayThreshold: 0.8,
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
