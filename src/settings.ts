import { App, PluginSettingTab, Setting } from 'obsidian';
import LumosPlugin from './main';

export class RelationSettingTab extends PluginSettingTab {
	plugin: LumosPlugin;

	constructor(app: App, plugin: LumosPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('LLM Provider')
			.setDesc('Choose between local Ollama inference or OpenRouter API')
			.addDropdown(drop => drop
				.addOption('ollama', 'Ollama (Local)')
				.addOption('openrouter', 'OpenRouter (Cloud)')
				.setValue(this.plugin.settings.provider)
				.onChange(async (value: 'ollama' | 'openrouter') => {
					this.plugin.settings.provider = value;
					
					// Set sane defaults when switching
					if (value === 'ollama' && this.plugin.settings.baseUrl.includes('openrouter')) {
						this.plugin.settings.baseUrl = 'http://localhost:11434';
					} else if (value === 'openrouter' && this.plugin.settings.baseUrl.includes('localhost')) {
						this.plugin.settings.baseUrl = 'https://openrouter.ai/api/v1';
					}
					
					await this.plugin.saveSettings();
					this.display(); // re-render to show/hide API key
				}));

		new Setting(containerEl)
			.setName('Base URL')
			.setDesc('The API endpoint for the provider')
			.addText(text => text
				.setPlaceholder(this.plugin.settings.provider === 'ollama' ? 'http://localhost:11434' : 'https://openrouter.ai/api/v1')
				.setValue(this.plugin.settings.baseUrl)
				.onChange(async (value) => {
					this.plugin.settings.baseUrl = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('LLM Chat Model Name')
			.setDesc(this.plugin.settings.provider === 'ollama' ? 'e.g., llama3, mistral' : 'e.g., openai/gpt-4o-mini, anthropic/claude-3-haiku')
			.addText(text => text
				.setPlaceholder('Enter model name')
				.setValue(this.plugin.settings.llmModelName)
				.onChange(async (value) => {
					this.plugin.settings.llmModelName = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Vision Model Name')
			.setDesc(this.plugin.settings.provider === 'ollama' ? 'e.g., llava' : 'e.g., openai/gpt-4o, google/gemini-pro-vision')
			.addText(text => text
				.setPlaceholder('Enter vision model name')
				.setValue(this.plugin.settings.visionModelName)
				.onChange(async (value) => {
					this.plugin.settings.visionModelName = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Embedding Model Name')
			.setDesc(this.plugin.settings.provider === 'ollama' ? 'e.g., nomic-embed-text' : 'e.g., openai/text-embedding-3-small')
			.addText(text => text
				.setPlaceholder(this.plugin.settings.provider === 'ollama' ? 'nomic-embed-text' : 'openai/text-embedding-3-small')
				.setValue(this.plugin.settings.embeddingModelName)
				.onChange(async (value) => {
					this.plugin.settings.embeddingModelName = value;
					await this.plugin.saveSettings();
				}));

		if (this.plugin.settings.provider === 'openrouter') {
			new Setting(containerEl)
				.setName('API Key')
				.setDesc('Your OpenRouter API Key')
				.addText(text => text
					.setPlaceholder('sk-or-v1-...')
					.setValue(this.plugin.settings.apiKey || '')
					.onChange(async (value) => {
						this.plugin.settings.apiKey = value;
						await this.plugin.saveSettings();
					}));
		}

		new Setting(containerEl)
			.setName('Auto-Add Backlinks (Frontmatter)')
			.setDesc('Automatically inject high-confidence relations as backlinks into the note\'s YAML frontmatter to populate the Graph View.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoAddBacklinks)
				.onChange(async (value) => {
					this.plugin.settings.autoAddBacklinks = value;
					await this.plugin.saveSettings();
					this.display();
				}));

		if (this.plugin.settings.autoAddBacklinks) {
			new Setting(containerEl)
				.setName('Backlink Confidence Threshold')
				.setDesc('Only add backlinks if the LLM is this confident (0.0 to 1.0)')
				.addSlider(slider => slider
					.setLimits(0.1, 1.0, 0.1)
					.setValue(this.plugin.settings.backlinkConfidenceThreshold)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.backlinkConfidenceThreshold = value;
						await this.plugin.saveSettings();
					}));
		}

		new Setting(containerEl)
			.setName('Display Threshold (Signal-to-Noise)')
			.setDesc('Only auto-display relations with an overall score above this threshold. Weaker matches are hidden behind a toggle. (0.0 to 1.0)')
			.addSlider(slider => slider
				.setLimits(0.1, 1.0, 0.1)
				.setValue(this.plugin.settings.displayThreshold)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.displayThreshold = value;
					await this.plugin.saveSettings();
				}));

		containerEl.createEl('h3', {text: 'AI User Profile', cls: 'setting-item-heading'});

		new Setting(containerEl)
			.setName('Enable Auto-Updating Profile')
			.setDesc('Automatically maintain a markdown file that learns about your current projects, mood, and important events in the background.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableUserProfile)
				.onChange(async (value) => {
					this.plugin.settings.enableUserProfile = value;
					await this.plugin.saveSettings();
					this.display();
				}));

		if (this.plugin.settings.enableUserProfile) {
			new Setting(containerEl)
				.setName('Profile File Name')
				.setDesc('The name of the file in your vault root where the profile will be maintained.')
				.addText(text => text
					.setValue(this.plugin.settings.userProfilePath)
					.onChange(async (value) => {
						this.plugin.settings.userProfilePath = value;
						await this.plugin.saveSettings();
					}));

			new Setting(containerEl)
				.setName('Update Threshold (Words)')
				.setDesc('To minimize API costs, the profile will only update after you have written or modified this many words across your notes.')
				.addText(text => text
					.setValue(this.plugin.settings.userProfileWordThreshold.toString())
					.onChange(async (value) => {
						const num = parseInt(value, 10);
						if (!isNaN(num) && num > 0) {
							this.plugin.settings.userProfileWordThreshold = num;
							await this.plugin.saveSettings();
						}
					}));
		}

		containerEl.createEl('h3', {text: 'Privacy & Exclusions', cls: 'setting-item-heading'});

		new Setting(containerEl)
			.setName('Ignored Folders')
			.setDesc('Comma-separated list of folders that will NEVER be indexed or sent to cloud APIs (e.g., "Private, Secrets"). Paths containing these strings will be skipped.')
			.addText(text => text
				.setPlaceholder('Private, Secrets')
				.setValue(this.plugin.settings.ignoredFolders)
				.onChange(async (value) => {
					this.plugin.settings.ignoredFolders = value;
					await this.plugin.saveSettings();
				}));
	}

	hide(): void {
		// When settings are closed, try to start the indexer in case they configured it correctly now
		this.plugin.indexer.start();
	}
}
