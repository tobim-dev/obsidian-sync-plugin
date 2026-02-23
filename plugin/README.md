# Unraid Vault Sync Plugin

Obsidian plugin that syncs notes to a self-hosted backend.

## Commands
- `Sync notes with self-hosted backend`
- `Force full sync (re-upload local vault)`

## Optional config sync
- Enable `Sync community plugins` in plugin settings to sync:
  - `.obsidian/plugins/*`
  - `.obsidian/community-plugins.json`

## Development

```bash
npm install
npm run build
```

Files needed for installation:
- `main.js`
- `manifest.json`
- `versions.json`
