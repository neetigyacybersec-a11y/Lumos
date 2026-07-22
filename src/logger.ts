import LumosPlugin from './main';

export class Logger {
    static plugin: LumosPlugin | null = null;
    static maxLogLines = 1000;
    static logFile = 'lumos-debug.log';
    private static logQueue: string[] = [];
    private static isWriting = false;

    static init(plugin: LumosPlugin) {
        this.plugin = plugin;
    }

    static async writeLog(level: string, message: string, data?: any) {
        const timestamp = new Date().toISOString();
        let logLine = `[${timestamp}] [${level}] ${message}`;
        if (data !== undefined) {
            const dataStr = this.sanitize(data);
            logLine += ` | ${dataStr}`;
        }
        
        // Always log to console for dev mode
        if (level === 'ERROR') {
            console.error(logLine);
        } else if (level === 'WARN') {
            console.warn(logLine);
        } else {
            console.log(logLine);
        }
        
        if (!this.plugin) return;
        
        this.logQueue.push(logLine);
        this.processQueue();
    }
    
    private static async processQueue() {
        if (this.isWriting || this.logQueue.length === 0 || !this.plugin) return;
        this.isWriting = true;
        
        const manifestDir = this.plugin.manifest?.dir || '';
        if (!manifestDir) {
            this.isWriting = false;
            return;
        }
        const logPath = `${manifestDir}/${this.logFile}`;
        const adapter = this.plugin.app.vault.adapter;
        
        try {
            let existingLogs = '';
            if (await adapter.exists(logPath)) {
                existingLogs = await adapter.read(logPath);
            }
            
            const lines = existingLogs.split('\n').filter(l => l.trim().length > 0);
            
            while(this.logQueue.length > 0) {
                lines.push(this.logQueue.shift()!);
            }
            
            if (lines.length > this.maxLogLines) {
                lines.splice(0, lines.length - this.maxLogLines);
            }
            
            await adapter.write(logPath, lines.join('\n') + '\n');
        } catch (e) {
            console.error("Failed to write to lumos-debug.log", e);
        } finally {
            this.isWriting = false;
            if (this.logQueue.length > 0) {
                this.processQueue();
            }
        }
    }
    
    static sanitize(data: any): string {
        try {
            if (data instanceof Error) {
                return data.stack || data.message;
            }
            const str = typeof data === 'string' ? data : JSON.stringify(data);
            if (str && str.length > 500) {
                return str.substring(0, 500) + '... [TRUNCATED FOR PRIVACY]';
            }
            return str;
        } catch {
            return String(data);
        }
    }

    static info(message: string, data?: any) { this.writeLog('INFO', message, data); }
    static warn(message: string, data?: any) { this.writeLog('WARN', message, data); }
    static error(message: string, data?: any) { this.writeLog('ERROR', message, data); }
    static debug(message: string, data?: any) { this.writeLog('DEBUG', message, data); }
}
