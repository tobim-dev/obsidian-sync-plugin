import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import express, { Request, Response } from "express";

type SyncOperation = "upsert" | "delete";

interface IncomingChange {
  op: SyncOperation;
  path: string;
  mtime: number;
  hash?: string;
  content?: string;
}

interface SyncPayload {
  vaultId: string;
  deviceId: string;
  lastServerSeq: number;
  changes: IncomingChange[];
}

interface EventRow {
  seq: number;
  path: string;
  op: SyncOperation;
  content: string | null;
  hash: string | null;
  mtime: number;
  origin_device_id: string;
}

const port = toPositiveNumber(process.env.PORT, 8787);
const dbPath = process.env.DB_PATH || "/data/sync.db";
const maxBodySize = process.env.MAX_BODY_SIZE || "50mb";
const validTokens = loadTokens(process.env.SYNC_TOKENS || process.env.SYNC_TOKEN || "");

ensureDirectory(path.dirname(dbPath));

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

db.exec(`
CREATE TABLE IF NOT EXISTS files (
  vault_id TEXT NOT NULL,
  path TEXT NOT NULL,
  content TEXT,
  hash TEXT,
  mtime INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  updated_by_device TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (vault_id, path)
);

CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  vault_id TEXT NOT NULL,
  path TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('upsert', 'delete')),
  content TEXT,
  hash TEXT,
  mtime INTEGER NOT NULL,
  origin_device_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_vault_seq ON events(vault_id, seq);

CREATE TABLE IF NOT EXISTS devices (
  vault_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  last_seen_seq INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (vault_id, device_id)
);
`);

const upsertFileStmt = db.prepare(`
INSERT INTO files (vault_id, path, content, hash, mtime, deleted, updated_by_device, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(vault_id, path) DO UPDATE SET
  content = excluded.content,
  hash = excluded.hash,
  mtime = excluded.mtime,
  deleted = excluded.deleted,
  updated_by_device = excluded.updated_by_device,
  updated_at = excluded.updated_at
`);

const insertEventStmt = db.prepare(`
INSERT INTO events (vault_id, path, op, content, hash, mtime, origin_device_id, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const selectEventsStmt = db.prepare(
  `SELECT seq, path, op, content, hash, mtime, origin_device_id FROM events WHERE vault_id = ? AND seq > ? ORDER BY seq ASC`,
);

const maxSeqStmt = db.prepare(`SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE vault_id = ?`);

const upsertDeviceStmt = db.prepare(`
INSERT INTO devices (vault_id, device_id, last_seen_seq, updated_at)
VALUES (?, ?, ?, ?)
ON CONFLICT(vault_id, device_id) DO UPDATE SET
  last_seen_seq = excluded.last_seen_seq,
  updated_at = excluded.updated_at
`);

const applyChangesTxn = db.transaction((payload: SyncPayload): void => {
  const now = Date.now();

  for (const rawChange of payload.changes) {
    const normalizedPath = normalizeVaultPath(rawChange.path);
    if (!normalizedPath) {
      continue;
    }

    if (rawChange.op === "upsert") {
      if (typeof rawChange.content !== "string") {
        continue;
      }

      upsertFileStmt.run(
        payload.vaultId,
        normalizedPath,
        rawChange.content,
        rawChange.hash ?? null,
        rawChange.mtime,
        0,
        payload.deviceId,
        now,
      );

      insertEventStmt.run(
        payload.vaultId,
        normalizedPath,
        "upsert",
        rawChange.content,
        rawChange.hash ?? null,
        rawChange.mtime,
        payload.deviceId,
        now,
      );
      continue;
    }

    upsertFileStmt.run(payload.vaultId, normalizedPath, null, null, rawChange.mtime, 1, payload.deviceId, now);
    insertEventStmt.run(payload.vaultId, normalizedPath, "delete", null, null, rawChange.mtime, payload.deviceId, now);
  }
});

const app = express();
app.use(express.json({ limit: maxBodySize }));

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true });
});

app.post("/api/v1/sync", (req: Request, res: Response) => {
  if (!isAuthorized(req.header("authorization"), validTokens)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const parsed = parsePayload(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  try {
    applyChangesTxn(parsed.payload);

    const eventRows = selectEventsStmt.all(parsed.payload.vaultId, parsed.payload.lastServerSeq) as EventRow[];
    const serverSeq = eventRows.length > 0
      ? eventRows[eventRows.length - 1].seq
      : (maxSeqStmt.get(parsed.payload.vaultId) as { seq: number }).seq;

    upsertDeviceStmt.run(parsed.payload.vaultId, parsed.payload.deviceId, serverSeq, Date.now());

    res.json({
      serverSeq,
      changes: eventRows.map((row) => ({
        seq: row.seq,
        path: row.path,
        op: row.op,
        content: row.content,
        hash: row.hash,
        mtime: row.mtime,
        originDeviceId: row.origin_device_id,
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: `Sync failed: ${message}` });
  }
});

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Not found" });
});

app.listen(port, () => {
  const authMode = validTokens.size === 0 ? "disabled" : "enabled";
  console.log(`obsidian-sync backend listening on :${port} (auth: ${authMode}, db: ${dbPath})`);
});

function ensureDirectory(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function toPositiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function loadTokens(raw: string): Set<string> {
  const tokens = new Set<string>();
  for (const part of raw.split(",")) {
    const token = part.trim();
    if (token) {
      tokens.add(token);
    }
  }
  return tokens;
}

function isAuthorized(authorizationHeader: string | undefined, validTokenSet: Set<string>): boolean {
  if (validTokenSet.size === 0) {
    return true;
  }

  if (!authorizationHeader || !authorizationHeader.startsWith("Bearer ")) {
    return false;
  }

  const token = authorizationHeader.slice("Bearer ".length).trim();
  return validTokenSet.has(token);
}

function normalizeVaultPath(input: string): string | null {
  if (typeof input !== "string") {
    return null;
  }

  const normalized = input.replace(/\\/g, "/").replace(/^\/+/, "").trim();
  if (!normalized) {
    return null;
  }

  const parts = normalized.split("/");
  for (const part of parts) {
    if (!part || part === "." || part === "..") {
      return null;
    }
  }

  if (normalized.startsWith(".obsidian/") && !isAllowedObsidianPath(normalized)) {
    return null;
  }

  return normalized;
}

function isAllowedObsidianPath(normalized: string): boolean {
  if (normalized === ".obsidian/community-plugins.json") {
    return true;
  }

  return normalized.startsWith(".obsidian/plugins/");
}

function parsePayload(value: unknown): { ok: true; payload: SyncPayload } | { ok: false; error: string } {
  if (!value || typeof value !== "object") {
    return { ok: false, error: "Body must be an object." };
  }

  const payload = value as Partial<SyncPayload>;

  if (typeof payload.vaultId !== "string" || payload.vaultId.trim().length === 0) {
    return { ok: false, error: "vaultId is required." };
  }

  if (typeof payload.deviceId !== "string" || payload.deviceId.trim().length === 0) {
    return { ok: false, error: "deviceId is required." };
  }

  if (!Number.isFinite(payload.lastServerSeq)) {
    return { ok: false, error: "lastServerSeq must be a number." };
  }
  const safeLastServerSeq = Math.max(0, Math.floor(payload.lastServerSeq as number));

  if (!Array.isArray(payload.changes)) {
    return { ok: false, error: "changes must be an array." };
  }

  const parsedChanges: IncomingChange[] = [];

  for (const rawChange of payload.changes) {
    if (!rawChange || typeof rawChange !== "object") {
      return { ok: false, error: "Each change must be an object." };
    }

    const candidate = rawChange as Partial<IncomingChange>;
    if (candidate.op !== "upsert" && candidate.op !== "delete") {
      return { ok: false, error: "change.op must be 'upsert' or 'delete'." };
    }

    if (typeof candidate.path !== "string" || candidate.path.trim().length === 0) {
      return { ok: false, error: "change.path must be a non-empty string." };
    }

    if (!Number.isFinite(candidate.mtime)) {
      return { ok: false, error: "change.mtime must be a number." };
    }
    const safeMtime = Math.floor(candidate.mtime as number);

    if (candidate.op === "upsert" && typeof candidate.content !== "string") {
      return { ok: false, error: "upsert changes require content." };
    }

    parsedChanges.push({
      op: candidate.op,
      path: candidate.path,
      mtime: safeMtime,
      hash: typeof candidate.hash === "string" ? candidate.hash : undefined,
      content: typeof candidate.content === "string" ? candidate.content : undefined,
    });
  }

  return {
    ok: true,
    payload: {
      vaultId: payload.vaultId.trim(),
      deviceId: payload.deviceId.trim(),
      lastServerSeq: safeLastServerSeq,
      changes: parsedChanges,
    },
  };
}
