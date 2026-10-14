export class App {}
export class Plugin {
    app: any;
    manifest: any;
    constructor(app: any, manifest: any) {
        this.app = app;
        this.manifest = manifest;
    }
}
export class PluginSettingTab {
    app: any;
    plugin: any;
    containerEl: any = { empty: () => {} };
    constructor(app: any, plugin: any) {
        this.app = app;
        this.plugin = plugin;
    }
}
function mockEl(): any {
    return {
        empty() {}, setText() {}, addClass() {}, removeClass() {},
        createEl: () => mockEl(), createDiv: () => mockEl(), createSpan: () => mockEl(),
    };
}
export class Setting {
    descEl: any = mockEl();
    infoEl: any = mockEl();
    buttonEl: any = mockEl();
    constructor(containerEl: any) {}
    setName() { return this; }
    setDesc() { return this; }
    addDropdown(cb: any) { cb(this); return this; }
    addOption() { return this; }
    setValue() { return this; }
    onChange() { return this; }
    addText(cb: any) { cb(this); return this; }
    setPlaceholder() { return this; }
    addButton(cb: any) { cb(this); return this; }
    setButtonText() { return this; }
    onClick() { return this; }
    addToggle(cb: any) { cb(this); return this; }
    addSlider(cb: any) { cb(this); return this; }
    setLimits() { return this; }
    setDynamicTooltip() { return this; }
    setWarning() { return this; }
    setCta() { return this; }
}
export class Notice {
    constructor(public message?: any, public timeout?: number) {}
    noticeEl: any;
    hide() {}
}
export class ItemView {
    leaf: any;
    constructor(leaf?: any) { this.leaf = leaf; }
    navigation = false;
    getViewType() { return ''; }
    getDisplayText() { return ''; }
    onOpen() {}
    onClose() {}
    containerEl: any = {
        empty() {}, createDiv: () => ({ createEl: () => ({}), empty() {} }),
        createEl: () => ({}), addClass() {}, removeClass() {},
    };
    contentEl: any = this.containerEl;
    registerEvent() {}
    app: any;
}
export class WorkspaceLeaf {}
export class MarkdownView {}
export function requestUrl(_r: any): Promise<any> { return Promise.resolve({ status: 200, json: {} }); }
export class TAbstractFile {
    vault: any;
    path: string;
    name: string;
    parent: any;
}
export class TFile extends TAbstractFile {
    stat: any;
    basename: string;
    extension: string;
}
