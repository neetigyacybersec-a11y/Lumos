## Obsidian Plugin Sync Rule
- **Context**: The plugin source code is located in `c:\Users\Neetigya Maurya\Documents\ObsidianExtensionDev\obsidian-relation-plugin`. 
- **Active Vault**: The Obsidian vault is located at `c:\Users\Neetigya Maurya\Documents\Everything_Everywhere`.
- **Constraint**: Obsidian loads the plugin from `Everything_Everywhere\.obsidian\plugins\obsidian-relation-plugin`. 
- **Action**: After making code changes and running `npm run build` in the development directory, you MUST copy the compiled `main.js` (and any other modified assets) to the active vault's plugin directory using the terminal, otherwise the user will not see the changes when reloading the plugin.

## Obsidian UI & Icons
- When implementing UI elements that rely on Obsidian's bundled Lucide icons (such as `addRibbonIcon` or `ItemView.getIcon()`), stick to universally supported, standard icons (e.g., `message-circle`, `message-square`, `link`, `search`, `settings`). Avoid newer or less common Lucide identifiers (like `bot`) as they may fail to render silently depending on the user's Obsidian version.
