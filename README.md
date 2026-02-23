# Obsidian Self-Hosted Sync (Unraid + Community Plugin)

This repository contains:
- `backend/`: Dockerized sync API for your Unraid server.
- `plugin/`: Obsidian community plugin (manual install) with a command palette sync command.

## What it does
- Syncs note files you create, edit, or delete across devices.
- Works with Obsidian on macOS, Windows, and iOS (mobile-compatible plugin API usage).
- Uses a lightweight manual sync command to keep mobile resource usage low.

## Sync model
- Each client sends local changes (`upsert` / `delete`) and requests remote changes since its last sync sequence.
- Server stores an append-only event sequence and returns new events.
- Plugin applies remote changes and updates local sync state.
- `.obsidian/` content is intentionally excluded for safety.

## 1) Run backend on Unraid

### Option A: Docker Compose
From repo root:

```bash
docker compose up -d --build
```

Edit `docker-compose.yml` first:
- Set `SYNC_TOKEN` to a long random token.
- Keep `/data` mapped to persistent storage.

### Option B: Unraid template (manual)
Use image built from `backend/Dockerfile` and set env vars:
- `PORT=8787`
- `DB_PATH=/data/sync.db`
- `SYNC_TOKEN=<your long random token>`
- `MAX_BODY_SIZE=50mb`

Expose port `8787` and mount a persistent `/data` volume.

## 2) Build plugin

```bash
cd plugin
npm install
npm run build
```

Build output files to copy into your vault plugin folder:
- `plugin/main.js`
- `plugin/manifest.json`
- `plugin/versions.json`

## 3) Install plugin (manual, all devices)

For each device, copy files to:
- `<Vault>/.obsidian/plugins/unraid-vault-sync/`

Required files in that folder:
- `main.js`
- `manifest.json`
- `versions.json`

Then in Obsidian:
1. Open `Settings -> Community plugins`.
2. Enable community plugins (if disabled).
3. Enable `Unraid Vault Sync`.

## 4) Configure plugin

In `Settings -> Unraid Vault Sync`:
- `Server URL`: for example `http://192.168.1.50:8787`
- `API token`: same token as `SYNC_TOKEN`
- `Vault ID`: same value on all devices for this vault (for example `main-notes`)
- `Extensions`: default `.md` (or `*` for all file types)

## 5) Use sync command

Open command palette and run:
- `Sync notes with self-hosted backend`

This uploads local changes and downloads remote changes (including deletes).

## Mobile and resource usage
- No background polling loop.
- No file watcher loops.
- Diffing uses `mtime + size` first, only hashing file content when needed.
- Sync runs only when you trigger the command.

## Current conflict behavior
- Last synced update wins (event sequence order on server).
- If you edit a file during the exact sync run, the plugin skips overwriting that file in that run.

## Security notes
- Set a strong `SYNC_TOKEN`.
- Run behind HTTPS/reverse proxy for internet exposure.
- Consider network-only access (VPN/LAN) for personal deployments.

## Git repository setup
If this folder is not yet a git repository:

```bash
cd /Users/tobias/Projects/obsidian_sync
git init -b main
git add .
git commit -m "Initial self-hosted Obsidian sync plugin and backend"
```

`.gitignore` already excludes local-only artifacts such as `node_modules`, `data/*.db*`, `dist`, and local plugin build output.

## GitHub Actions and GHCR
Workflow file:
- `.github/workflows/ci-ghcr.yml`

It does the following:
- Builds and type-checks the Obsidian plugin.
- Builds the backend TypeScript project.
- Builds and pushes a Docker image to GitHub Container Registry on `main`, tags (`v*`), and manual runs.

Published image name:
- `ghcr.io/<github-owner>/obsidian-sync-backend`

Required repository setting:
- `Settings -> Actions -> General -> Workflow permissions -> Read and write permissions`

## Push to GitHub repository
Create a repo on GitHub first (empty repo), then run:

```bash
cd /Users/tobias/Projects/obsidian_sync
git remote add origin git@github.com:<your-user-or-org>/<your-repo>.git
git push -u origin main
```

If you prefer HTTPS instead of SSH:

```bash
git remote add origin https://github.com/<your-user-or-org>/<your-repo>.git
git push -u origin main
```
