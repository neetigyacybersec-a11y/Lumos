import { Notice } from 'obsidian';

export class IndexingProgressUI {
    private notice: Notice | null = null;
    private progressBar: HTMLElement | null = null;
    private statusText: HTMLElement | null = null;
    private total: number = 0;
    
    show(totalFiles: number) {
        this.total = totalFiles;
        if (!this.notice) {
            this.notice = new Notice('', 0); // 0 = persistent, doesn't auto-hide
            
            // Add a custom class so we can style it via CSS
            this.notice.noticeEl.addClass('llm-relations-progress-notice');
            this.notice.noticeEl.empty();
            
            const container = this.notice.noticeEl.createDiv({ cls: 'llm-relations-progress-container' });
            
            const header = container.createEl('div', { cls: 'llm-relations-progress-header' });
            header.createEl('h4', { text: 'LLM Relations Indexing' });
            
            this.statusText = container.createEl('div', { cls: 'llm-relations-progress-text' });
            
            const track = container.createDiv({ cls: 'llm-relations-progress-track' });
            this.progressBar = track.createDiv({ cls: 'llm-relations-progress-fill' });
        }
        
        this.update(0, this.total, 'Starting...');
    }
    
    update(processed: number, total: number, filename: string) {
        if (!this.notice || !this.progressBar || !this.statusText) return;
        
        this.total = total; // Keep internal state synced just in case
        const percent = total === 0 ? 0 : Math.round((processed / total) * 100);
        
        // Cap visual progress bar width at 100% just in case of race conditions
        this.progressBar.style.width = `${Math.min(percent, 100)}%`;
        
        this.statusText.setText(`[${processed}/${total}] (${percent}%)\n${filename}`);
    }
    
    hide() {
        if (this.notice) {
            this.notice.hide();
            this.notice = null;
            this.progressBar = null;
            this.statusText = null;
        }
    }
}
