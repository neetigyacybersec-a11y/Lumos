import { App, TAbstractFile, TFile, EventRef } from 'obsidian';

import LumosPlugin from './main';

export class Watcher {
	plugin: LumosPlugin;
	debounceTimers: Map<string, NodeJS.Timeout>;
	onReadyCallback?: (file: TFile) => void;
	onRenameCallback?: (file: TFile, oldPath: string) => void;
	eventRefs: EventRef[];

	constructor(plugin: LumosPlugin) {
		this.plugin = plugin;
		this.debounceTimers = new Map();
		this.eventRefs = [];
	}

	onReady(callback: (file: TFile) => void) {
		this.onReadyCallback = callback;
	}

	onRename(callback: (file: TFile, oldPath: string) => void) {
		this.onRenameCallback = callback;
	}

	register() {
		this.eventRefs.push(
			this.plugin.app.vault.on('modify', (file) => {
				if (file instanceof TFile && ['md', 'pdf', 'png', 'jpg', 'jpeg', 'webp'].includes(file.extension.toLowerCase())) {
					this.plugin.logActivity(`File modified: ${file.path}`);
					this.handleEvent(file);
				}
			}),
			this.plugin.app.vault.on('create', (file) => {
				if (file instanceof TFile && ['md', 'pdf', 'png', 'jpg', 'jpeg', 'webp'].includes(file.extension.toLowerCase())) {
					this.plugin.logActivity(`File created: ${file.path}`);
					this.handleEvent(file);
				}
			}),
			this.plugin.app.vault.on('rename', (file, oldPath) => {
				if (file instanceof TFile && ['md', 'pdf', 'png', 'jpg', 'jpeg', 'webp'].includes(file.extension.toLowerCase())) {
					if (this.onRenameCallback) {
						this.onRenameCallback(file, oldPath);
					}
					this.plugin.logActivity(`File renamed: from ${oldPath} to ${file.path}`);
					// Fire modify-like event so the new path gets indexed
					this.handleEvent(file);
				}
			}),
			this.plugin.app.vault.on('delete', (file) => {
				if (file instanceof TFile) {
					this.plugin.logActivity(`File deleted: ${file.path}`);
					// Clear any pending timers for deleted file
					if (this.debounceTimers.has(file.path)) {
						clearTimeout(this.debounceTimers.get(file.path));
						this.debounceTimers.delete(file.path);
					}
					// Fire a special delete event
					if (this.onReadyCallback) {
						this.onReadyCallback(file); 
					}
				}
			})
		);
	}

	unregister() {
		for (const ref of this.eventRefs) {
			this.plugin.app.vault.offref(ref);
		}
		this.eventRefs = [];
		for (const timer of this.debounceTimers.values()) {
			clearTimeout(timer);
		}
		this.debounceTimers.clear();
	}

	handleEvent(file: TAbstractFile) {
		if (!(file instanceof TFile) || !['md', 'pdf', 'png', 'jpg', 'jpeg', 'webp'].includes(file.extension.toLowerCase())) return;
		
		if (this.debounceTimers.has(file.path)) {
			clearTimeout(this.debounceTimers.get(file.path));
		}

		const timer = setTimeout(() => {
			this.debounceTimers.delete(file.path);
			if (this.onReadyCallback) {
				this.onReadyCallback(file);
			}
		}, 800);

		this.debounceTimers.set(file.path, timer);
	}
}
