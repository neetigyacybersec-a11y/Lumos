import { App, TAbstractFile, TFile, EventRef } from 'obsidian';

export class Watcher {
	app: App;
	debounceTimers: Map<string, NodeJS.Timeout>;
	onReadyCallback?: (file: TFile) => void;
	onRenameCallback?: (file: TFile, oldPath: string) => void;
	eventRefs: EventRef[];

	constructor(app: App) {
		this.app = app;
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
			this.app.vault.on('modify', (file) => this.handleEvent(file)),
			this.app.vault.on('create', (file) => this.handleEvent(file)),
			this.app.vault.on('rename', (file, oldPath) => {
				if (file instanceof TFile && file.extension === 'md') {
					if (this.onRenameCallback) {
						this.onRenameCallback(file, oldPath);
					}
					// Fire modify-like event so the new path gets indexed
					this.handleEvent(file);
				}
			}),
			this.app.vault.on('delete', (file) => {
				if (file instanceof TFile) {
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
			this.app.vault.offref(ref);
		}
		this.eventRefs = [];
		for (const timer of this.debounceTimers.values()) {
			clearTimeout(timer);
		}
		this.debounceTimers.clear();
	}

	handleEvent(file: TAbstractFile) {
		if (!(file instanceof TFile) || file.extension !== 'md') return;
		
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
