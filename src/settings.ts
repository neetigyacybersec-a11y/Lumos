import { App, PluginSettingTab, Setting, TFile, Notice } from 'obsidian';
import LumosPlugin from './main';
import { loginGoogle } from './googleAuth';
import { ApiFormat, DEFAULT_BASE_URL, normalizeBaseUrl, isKnownDefaultBaseUrl, validateBaseUrl } from './llm/providerConfig';
import { testProviderConnection } from './llm/transport';

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
			.setName('API Format')
			.setDesc('Which wire protocol to speak. "OpenAI-compatible" covers OpenRouter, TokenRouter, LM Studio, vLLM, Groq and most hosted APIs — point the Base URL at whichever you use.')
			.addDropdown(drop => drop
				.addOption('ollama', 'Ollama (native API)')
				.addOption('openai', 'OpenAI-compatible')
				.setValue(this.plugin.settings.apiFormat)
				.onChange(async (value: ApiFormat) => {
					this.plugin.settings.apiFormat = value;
					
					// Swap in this format's default only when the URL is empty or
					// still an untouched default; never clobber a custom endpoint.
					if (!normalizeBaseUrl(this.plugin.settings.baseUrl) || isKnownDefaultBaseUrl(this.plugin.settings.baseUrl)) {
						this.plugin.settings.baseUrl = DEFAULT_BASE_URL[value];
					}
					
					await this.plugin.saveSettings();
					this.display(); // re-render to show/hide API key
				}));

		const baseUrlSetting = new Setting(containerEl)
			.setName('Base URL')
			.setDesc('Full base URL of the endpoint, including /v1 where the provider needs it. Any http(s) host is accepted — OpenRouter, TokenRouter, LM Studio, vLLM, a private gateway, or localhost.')
			.addText(text => text
				.setPlaceholder(DEFAULT_BASE_URL[this.plugin.settings.apiFormat])
				.setValue(this.plugin.settings.baseUrl)
				.onChange(async (value) => {
					this.plugin.settings.baseUrl = value;
					await this.plugin.saveSettings();
					renderBaseUrlFeedback();
				}));

		const baseUrlFeedbackEl = baseUrlSetting.descEl.createDiv({ cls: 'lumos-base-url-feedback' });
		const renderBaseUrlFeedback = () => {
			const result = validateBaseUrl(this.plugin.settings.baseUrl);
			if (result.ok || !normalizeBaseUrl(this.plugin.settings.baseUrl)) {
				baseUrlFeedbackEl.setText('');
				baseUrlFeedbackEl.removeClass('mod-warning');
				return;
			}
			baseUrlFeedbackEl.setText(result.error);
			baseUrlFeedbackEl.addClass('mod-warning');
		};
		renderBaseUrlFeedback();

		const connectionStatusEl = containerEl.createDiv({ cls: 'lumos-connection-status' });
		new Setting(containerEl)
			.setName('Test Connection')
			.setDesc('Probe the endpoint with one lightweight request and report what happened — reachable, auth rejected, wrong path, and so on.')
			.addButton(button => button
				.setButtonText('Test connection')
				.onClick(async () => {
					const result = await testProviderConnection(this.plugin.settings);
					connectionStatusEl.setText(result.message);
					if (result.ok) {
						connectionStatusEl.removeClass('mod-warning');
						new Notice(result.message);
					} else {
						connectionStatusEl.addClass('mod-warning');
						new Notice(`Lumos: ${result.message}`, 12000);
					}
				}));

		new Setting(containerEl)
			.setName('LLM Chat Model Name')
			.setDesc(this.plugin.settings.apiFormat === 'ollama' ? 'e.g., llama3, mistral' : 'e.g., openai/gpt-4o-mini, anthropic/claude-3-haiku')
			.addText(text => text
				.setPlaceholder('Enter model name')
				.setValue(this.plugin.settings.llmModelName)
				.onChange(async (value) => {
					this.plugin.settings.llmModelName = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Vision Model Name')
			.setDesc(this.plugin.settings.apiFormat === 'ollama' ? 'e.g., llava' : 'e.g., openai/gpt-4o, google/gemini-pro-vision')
			.addText(text => text
				.setPlaceholder('Enter vision model name')
				.setValue(this.plugin.settings.visionModelName)
				.onChange(async (value) => {
					this.plugin.settings.visionModelName = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Embedding Model Name')
			.setDesc(this.plugin.settings.apiFormat === 'ollama' ? 'e.g., nomic-embed-text' : 'e.g., openai/text-embedding-3-small')
			.addText(text => text
				.setPlaceholder(this.plugin.settings.apiFormat === 'ollama' ? 'nomic-embed-text' : 'openai/text-embedding-3-small')
				.setValue(this.plugin.settings.embeddingModelName)
				.onChange(async (value) => {
					this.plugin.settings.embeddingModelName = value;
					await this.plugin.saveSettings();
				}));

		if (this.plugin.settings.apiFormat === 'openai') {
			new Setting(containerEl)
				.setName('API Key')
				.setDesc('Sent as `Authorization: Bearer <key>`. Leave blank for endpoints that need no auth (local gateways).')
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

		containerEl.createEl('h3', {text: 'Page Beautify', cls: 'setting-item-heading'});

		new Setting(containerEl)
			.setName('Add Related Notes Section')
			.setDesc('During Beautify Page, link the page to its most similar vault notes in a "Related Notes" section using native wiki links.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.beautifyAddRelatedNotes)
				.onChange(async (value) => {
					this.plugin.settings.beautifyAddRelatedNotes = value;
					await this.plugin.saveSettings();
					this.display();
				}));

		if (this.plugin.settings.beautifyAddRelatedNotes) {
			new Setting(containerEl)
				.setName('How Many Related Notes')
				.setDesc('Maximum number of similar notes considered when building the section.')
				.addSlider(slider => slider
					.setLimits(1, 10, 1)
					.setValue(this.plugin.settings.beautifyRelatedTopK)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.beautifyRelatedTopK = value;
						await this.plugin.saveSettings();
					}));
		}

		new Setting(containerEl)
			.setName('Caption Embedded Images')
			.setDesc('Use the vision model to read text from images embedded in the page (up to 5, one vision call each) and add a caption under each matching embed.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.beautifyAddImageCaptions)
				.onChange(async (value) => {
					this.plugin.settings.beautifyAddImageCaptions = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Cache Beautify Results')
			.setDesc('Reuse previously-captioned images, beautified blocks, and whole-page beautifies across sessions so unchanged pages cost zero tokens. Results are keyed by file content and model, so they expire automatically when either changes.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.beautifyCacheEnabled)
				.onChange(async (value) => {
					this.plugin.settings.beautifyCacheEnabled = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Clear Beautify & Vision Cache')
			.setDesc('Delete every cached image transcription and beautified result. The next run re-calls the LLM for the affected pages.')
			.addButton(button => button
				.setButtonText('Clear cache')
				.onClick(async () => {
					await this.plugin.clearBeautifyCaches();
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

		containerEl.createEl('h3', {text: 'Hybrid Search & Reranking', cls: 'setting-item-heading'});

		new Setting(containerEl)
			.setName('Enable Hybrid Search (BM25 + Vectors)')
			.setDesc('Combine keyword (BM25) and semantic vector search with rank fusion. Finds exact terms, file names, and identifiers that pure semantic search misses. Runs fully offline.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableHybridSearch)
				.onChange(async (value) => {
					this.plugin.settings.enableHybridSearch = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Local Reranker')
			.setDesc('Re-rank the top search candidates with a local cross-encoder model for higher precision. The model (~4-23MB) downloads once from Hugging Face and then runs fully offline. "Off" keeps plain rank fusion.')
			.addDropdown(drop => drop
				.addOption('off', 'Off (rank fusion only)')
				.addOption('tiny', 'Fast (~4MB, TinyBERT)')
				.addOption('mini', 'Accurate (~23MB, MiniLM)')
				.setValue(this.plugin.settings.rerankerModel)
				.onChange(async (value: 'off' | 'tiny' | 'mini') => {
					this.plugin.settings.rerankerModel = value;
					await this.plugin.saveSettings();
				}));

		if (this.plugin.settings.rerankerModel !== 'off') {
			new Setting(containerEl)
				.setName('Rerank Depth')
				.setDesc('How many fused candidates to re-score per query. Higher = better precision, slower ranking.')
				.addSlider(slider => slider
					.setLimits(5, 50, 5)
					.setValue(this.plugin.settings.rerankCandidates)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.rerankCandidates = value;
						await this.plugin.saveSettings();
					}));
		}

		new Setting(containerEl)
			.setName('Request Timeout (seconds)')
			.setDesc('Hard cap per embedding/LLM network call. Timed-out calls retry with backoff instead of hanging the indexer.')
			.addText(text => text
				.setPlaceholder('60')
				.setValue(String(this.plugin.settings.requestTimeoutSec ?? 60))
				.onChange(async (value) => {
					const num = parseInt(value, 10);
					if (!isNaN(num) && num >= 5) {
						this.plugin.settings.requestTimeoutSec = num;
						await this.plugin.saveSettings();
					}
				}));

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

		new Setting(containerEl)
			.setName('Open Debug Log')
			.setDesc('View the background activity logs (lumos-debug.log) to help troubleshoot issues.')
			.addButton(btn => btn
				.setButtonText('Open Logs')
				.onClick(async () => {
					const manifestDir = this.plugin.manifest?.dir || '';
					const logPath = `${manifestDir}/lumos-debug.log`;
					const file = this.app.vault.getAbstractFileByPath(logPath);
					if (file && file instanceof TFile) {
						const leaf = this.app.workspace.getLeaf(true);
						await leaf.openFile(file);
					} else {
						new Notice("No debug logs found yet.");
					}
				}));

		containerEl.createEl('h3', {text: 'Google Calendar Integration', cls: 'setting-item-heading'});

		new Setting(containerEl)
			.setName('Enable Google Calendar Sync')
			.setDesc('Pull events from your Google Calendar to build semantic relations with your notes.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.googleSyncEnabled)
				.onChange(async (value) => {
					this.plugin.settings.googleSyncEnabled = value;
					await this.plugin.saveSettings();
					this.display();
				}));

		if (this.plugin.settings.googleSyncEnabled) {
			new Setting(containerEl)
				.setName('Google Client ID')
				.setDesc('Leave blank to use the default public client ID. Otherwise, provide your own GCP OAuth Client ID.')
				.addText(text => text
					.setPlaceholder('Your Google Client ID')
					.setValue(this.plugin.settings.googleClientId)
					.onChange(async (value) => {
						this.plugin.settings.googleClientId = value;
						await this.plugin.saveSettings();
					}));

			new Setting(containerEl)
				.setName('Google Client Secret')
				.setDesc('Only required if you are using your own Client ID.')
				.addText(text => text
					.setPlaceholder('Your Google Client Secret')
					.setValue(this.plugin.settings.googleClientSecret)
					.onChange(async (value) => {
						this.plugin.settings.googleClientSecret = value;
						await this.plugin.saveSettings();
					}));
					
			const loginSetting = new Setting(containerEl)
				.setName('Google Authentication')
				.setDesc('Log in to Google to sync your calendar.');
				
			if (this.plugin.settings.googleRefreshToken) {
				loginSetting.setDesc('You are currently logged in to Google.');
				loginSetting.addButton(btn => btn
					.setButtonText('Log Out')
					.setWarning()
					.onClick(async () => {
						this.plugin.settings.googleRefreshToken = '';
						await this.plugin.saveSettings();
						this.display();
					}));
			} else {
				loginSetting.addButton(btn => btn
					.setButtonText('Log in with Google')
					.setCta()
					.onClick(async () => {
						await loginGoogle(this.plugin, () => {
							this.display();
						});
					}));
			}
		}
	}

	hide(): void {
		// When settings are closed, try to start the indexer in case they configured it correctly now
		this.plugin.indexer.start();
	}
}
