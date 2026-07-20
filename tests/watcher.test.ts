import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Watcher } from '../src/watcher';
import { TFile } from 'obsidian';


describe('Watcher', () => {
	let mockApp: any;
	let watcher: Watcher;
	
	beforeEach(() => {
		vi.useFakeTimers();
		mockApp = {
			vault: {
				on: vi.fn().mockImplementation((event, callback) => {
					return { event, callback }; // mock event ref
				}),
				offref: vi.fn()
			}
		};
		watcher = new Watcher(mockApp);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('collapses 5 rapid modify events into 1 processing call', () => {
		const callback = vi.fn();
		watcher.onReady(callback);
		
		const file = new TFile();
		file.path = 'test.md';
		file.extension = 'md';
		
		// Simulate 5 rapid events
		for (let i = 0; i < 5; i++) {
			watcher.handleEvent(file);
			vi.advanceTimersByTime(200); // Wait 200ms between edits
		}
		
		// Advance past the 800ms debounce
		vi.advanceTimersByTime(800);
		
		expect(callback).toHaveBeenCalledTimes(1);
		expect(callback).toHaveBeenCalledWith(file);
	});

	it('fires immediately on delete', () => {
		const callback = vi.fn();
		watcher.onReady(callback);
		watcher.register();

		// Find the delete handler
		const deleteHandlerCall = mockApp.vault.on.mock.calls.find((c: any) => c[0] === 'delete');
		const deleteHandler = deleteHandlerCall[1];

		const file = new TFile();
		file.path = 'test.md';
		file.extension = 'md';

		deleteHandler(file);
		expect(callback).toHaveBeenCalledTimes(1);
		expect(callback).toHaveBeenCalledWith(file);
	});
});
