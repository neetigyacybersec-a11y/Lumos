import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_SETTINGS, PluginSettings } from '../src/types';

describe('Settings', () => {
	it('loads DEFAULT_SETTINGS with provider=ollama when no saved data exists', async () => {
		const plugin = {
			loadData: vi.fn().mockResolvedValue(null),
			settings: {} as PluginSettings,
			loadSettings: async function() {
				this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
			}
		} as any;

		await plugin.loadSettings();

		expect(plugin.settings.provider).toBe('ollama');
		expect(plugin.settings.baseUrl).toBe('http://localhost:11434');
	});

	it('persists settings round-trip through loadData/saveData', async () => {
		let mockStore: any = null;
		
		const plugin = {
			loadData: vi.fn().mockImplementation(async () => mockStore),
			saveData: vi.fn().mockImplementation(async (data) => { mockStore = data; }),
			settings: {} as PluginSettings,
			loadSettings: async function() {
				this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
			},
			saveSettings: async function() {
				await this.saveData(this.settings);
			}
		} as any;

		await plugin.loadSettings();
		plugin.settings.provider = 'openrouter';
		plugin.settings.baseUrl = 'https://openrouter.ai/api/v1';
		plugin.settings.apiKey = 'test-key';
		await plugin.saveSettings();

		// Reload
		await plugin.loadSettings();
		
		expect(plugin.settings.provider).toBe('openrouter');
		expect(plugin.settings.apiKey).toBe('test-key');
	});
});
