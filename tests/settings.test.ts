import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_SETTINGS, PluginSettings, resolveSettings } from '../src/types';

describe('Settings', () => {
	it('loads defaults with apiFormat=ollama when no saved data exists', async () => {
		const plugin = {
			loadData: vi.fn().mockResolvedValue(null),
			settings: {} as PluginSettings,
			loadSettings: async function() {
				this.settings = resolveSettings(await this.loadData());
			}
		} as any;

		await plugin.loadSettings();

		expect(plugin.settings.apiFormat).toBe('ollama');
		expect(plugin.settings.baseUrl).toBe(DEFAULT_SETTINGS.baseUrl);
		expect(plugin.settings.baseUrl).toBe('http://localhost:11434');
	});

	it('persists settings round-trip through loadData/saveData', async () => {
		let mockStore: any = null;

		const plugin = {
			loadData: vi.fn().mockImplementation(async () => mockStore),
			saveData: vi.fn().mockImplementation(async (data) => { mockStore = data; }),
			settings: {} as PluginSettings,
			loadSettings: async function() {
				this.settings = resolveSettings(await this.loadData());
			},
			saveSettings: async function() {
				await this.saveData(this.settings);
			}
		} as any;

		await plugin.loadSettings();
		plugin.settings.apiFormat = 'openai';
		plugin.settings.baseUrl = 'https://api.tokenrouter.dev/v1';
		plugin.settings.apiKey = 'test-key';
		await plugin.saveSettings();

		// Reload
		await plugin.loadSettings();

		expect(plugin.settings.apiFormat).toBe('openai');
		expect(plugin.settings.baseUrl).toBe('https://api.tokenrouter.dev/v1');
		expect(plugin.settings.apiKey).toBe('test-key');
	});
});

describe('resolveSettings migration', () => {
	it('maps the legacy provider=openrouter onto apiFormat=openai', () => {
		const settings = resolveSettings({
			provider: 'openrouter',
			baseUrl: 'https://openrouter.ai/api/v1',
			apiKey: 'k',
		});

		expect(settings.apiFormat).toBe('openai');
		expect(settings.apiKey).toBe('k');
		expect((settings as any).provider).toBeUndefined();
	});

	it('maps the legacy provider=ollama onto apiFormat=ollama', () => {
		expect(resolveSettings({ provider: 'ollama' }).apiFormat).toBe('ollama');
	});

	it('prefers an explicit apiFormat over the stale legacy field', () => {
		const settings = resolveSettings({ apiFormat: 'openai', provider: 'ollama' });

		expect(settings.apiFormat).toBe('openai');
		expect((settings as any).provider).toBeUndefined();
	});

	it('drops the legacy field so it is never written back', () => {
		const settings = resolveSettings({ provider: 'ollama' });
		expect(Object.keys(settings)).not.toContain('provider');
	});
});