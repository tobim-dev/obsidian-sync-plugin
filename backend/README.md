# Obsidian Sync Backend

Lightweight Express + SQLite backend for the `unraid-vault-sync` Obsidian plugin.

## Environment
- `PORT` (default `8787`)
- `DB_PATH` (default `/data/sync.db`)
- `SYNC_TOKEN` or `SYNC_TOKENS` (comma-separated)
- `MAX_BODY_SIZE` (default `50mb`)

## Run locally

```bash
npm install
npm run build
npm start
```

## Docker

```bash
docker build -t obsidian-sync-backend .
docker run -d \
  -p 8787:8787 \
  -e SYNC_TOKEN=change-me \
  -v $(pwd)/data:/data \
  --name obsidian-sync-backend \
  obsidian-sync-backend
```
