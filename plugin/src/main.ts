import {
	App,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	normalizePath,
	requestUrl,
} from "obsidian";

type SyncOperation = "upsert" | "delete";

interface SyncSettings {
	serverUrl: string;
	apiToken: string;
	vaultId: string;
	includeExtensions: string;
}

interface LocalEntry {
	path: string;
	mtime: number;
	size: number;
	hash: string;
}

interface SyncState {
	deviceId: string;
	lastServerSeq: number;
	entries: Record<string, LocalEntry>;
}

interface PersistedData {
	settings: SyncSettings;
	state: SyncState;
}

interface SyncChange {
	op: SyncOperation;
	path: string;
	mtime: number;
	hash?: string;
	content?: string;
}

interface SyncRequest {
	vaultId: string;
	deviceId: string;
	lastServerSeq: number;
	changes: SyncChange[];
}

interface RemoteChange {
	seq: number;
	op: SyncOperation;
	path: string;
	mtime: number;
	hash?: string | null;
	content?: string | null;
	originDeviceId: string;
}

interface SyncResponse {
	serverSeq: number;
	changes: RemoteChange[];
}

interface SnapshotResult {
	entries: Record<string, LocalEntry>;
	localChanges: SyncChange[];
}

interface ApplyResult {
	appliedUpserts: number;
	appliedDeletes: number;
	skipped: number;
}

const DEFAULT_SETTINGS: SyncSettings = {
	serverUrl: "http://127.0.0.1:8787",
	apiToken: "",
	vaultId: "",
	includeExtensions: ".md",
};

export default class UnraidVaultSyncPlugin extends Plugin {
	private settings: SyncSettings = { ...DEFAULT_SETTINGS };
	private state: SyncState = this.createDefaultState();
	private syncInProgress = false;

	public async onload(): Promise<void> {
		await this.loadPluginData();

		if (!this.settings.vaultId) {
			this.settings.vaultId = this.suggestVaultId();
			await this.persistData();
		}

		this.addSettingTab(new UnraidVaultSyncSettingTab(this.app, this));
		this.addCommand({
			id: "sync-now",
			name: "Sync notes with self-hosted backend",
			callback: async () => {
				await this.runSync();
			},
		});
	}

	public async runSync(): Promise<void> {
		if (this.syncInProgress) {
			new Notice("Sync is already running.");
			return;
		}

		if (!this.settings.serverUrl.trim()) {
			new Notice("Set the sync server URL in plugin settings.");
			return;
		}

		if (!this.settings.apiToken.trim()) {
			new Notice("Set the sync API token in plugin settings.");
			return;
		}

		if (!this.settings.vaultId.trim()) {
			new Notice("Set a shared vault ID in plugin settings.");
			return;
		}

		this.syncInProgress = true;
		const syncStartedAt = Date.now();
		new Notice("Vault sync started...");

		try {
			const snapshot = await this.buildSnapshot();
			const request: SyncRequest = {
				vaultId: this.settings.vaultId.trim(),
				deviceId: this.state.deviceId,
				lastServerSeq: this.state.lastServerSeq,
				changes: snapshot.localChanges,
			};

			const response = await this.pushAndPull(request);
			const applyResult = await this.applyRemoteChanges(
				response.changes,
				snapshot.entries,
				syncStartedAt,
			);

			this.state.entries = snapshot.entries;
			this.state.lastServerSeq = response.serverSeq;
			await this.persistData();

			new Notice(
				`Sync complete. Uploaded ${snapshot.localChanges.length} change(s), downloaded ${applyResult.appliedUpserts + applyResult.appliedDeletes} change(s).`,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			new Notice(`Sync failed: ${message}`);
			console.error("[unraid-vault-sync] sync failed", error);
		} finally {
			this.syncInProgress = false;
		}
	}

		public async testServerConnection(): Promise<void> {
			const baseUrl = this.cleanBaseUrl();
			try {
				const response = await requestUrl({
					url: `${baseUrl}/health`,
					method: "GET",
					throw: false,
				});

			if (response.status >= 400) {
				new Notice(`Healthcheck failed: ${response.status}`);
				return;
			}

			new Notice("Server healthcheck passed.");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			new Notice(`Healthcheck error: ${message}`);
		}
	}

	public getSettings(): SyncSettings {
		return this.settings;
	}

	public async updateSettings(patch: Partial<SyncSettings>): Promise<void> {
		this.settings = {
			...this.settings,
			...patch,
		};
		await this.persistData();
	}

	private async loadPluginData(): Promise<void> {
		const raw = (await this.loadData()) as Partial<PersistedData> | null;
		this.settings = {
			...DEFAULT_SETTINGS,
			...(raw?.settings ?? {}),
		};

		this.state = {
			...this.createDefaultState(),
			...(raw?.state ?? {}),
			entries: raw?.state?.entries ?? {},
		};

		if (!this.state.deviceId) {
			this.state.deviceId = this.generateDeviceId();
		}
	}

	private async persistData(): Promise<void> {
		const payload: PersistedData = {
			settings: this.settings,
			state: this.state,
		};
		await this.saveData(payload);
	}

	private createDefaultState(): SyncState {
		return {
			deviceId: this.generateDeviceId(),
			lastServerSeq: 0,
			entries: {},
		};
	}

	private generateDeviceId(): string {
		if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
			return crypto.randomUUID();
		}

		return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
	}

	private suggestVaultId(): string {
		const fallback = this.app.vault.getName();
		const cleaned = fallback
			.toLowerCase()
			.replace(/[^a-z0-9-_]+/g, "-")
			.replace(/^-+|-+$/g, "");
		return cleaned || "default-vault";
	}

	private parseExtensions(): Set<string> {
		const extensions = new Set<string>();
		const source = this.settings.includeExtensions || DEFAULT_SETTINGS.includeExtensions;

		for (const rawValue of source.split(",")) {
			const value = rawValue.trim().toLowerCase();
			if (!value) {
				continue;
			}
			if (value === "*") {
				extensions.add("*");
				continue;
			}
			extensions.add(value.startsWith(".") ? value : `.${value}`);
		}

		if (extensions.size === 0) {
			extensions.add(".md");
		}

		return extensions;
	}

	private shouldIncludeFile(file: TFile, extensions: Set<string>): boolean {
		if (file.path.startsWith(`${this.app.vault.configDir}/`)) {
			return false;
		}

		if (extensions.has("*")) {
			return true;
		}

		const ext = file.extension ? `.${file.extension.toLowerCase()}` : "";
		return extensions.has(ext);
	}

	private async buildSnapshot(): Promise<SnapshotResult> {
		const extensions = this.parseExtensions();
		const localChanges: SyncChange[] = [];
		const nextEntries: Record<string, LocalEntry> = {};
		const previousEntries = this.state.entries;
		const files = [...this.app.vault.getFiles()].sort((a, b) => a.path.localeCompare(b.path));

		for (const file of files) {
			if (!this.shouldIncludeFile(file, extensions)) {
				continue;
			}

			const path = normalizePath(file.path);
			const previous = previousEntries[path];

			if (previous && previous.mtime === file.stat.mtime && previous.size === file.stat.size) {
				nextEntries[path] = previous;
				continue;
			}

			const content = await this.app.vault.cachedRead(file);
			const hash = fnv1aHash(content);
			const entry: LocalEntry = {
				path,
				mtime: file.stat.mtime,
				size: file.stat.size,
				hash,
			};
			nextEntries[path] = entry;

			if (!previous || previous.hash !== hash || previous.mtime !== file.stat.mtime || previous.size !== file.stat.size) {
				localChanges.push({
					op: "upsert",
					path,
					mtime: file.stat.mtime,
					hash,
					content,
				});
			}
		}

		const deleteTimestamp = Date.now();
		for (const previousPath of Object.keys(previousEntries)) {
			if (nextEntries[previousPath]) {
				continue;
			}

			localChanges.push({
				op: "delete",
				path: previousPath,
				mtime: deleteTimestamp,
			});
		}

		return {
			entries: nextEntries,
			localChanges,
		};
	}

	private async pushAndPull(request: SyncRequest): Promise<SyncResponse> {
		const baseUrl = this.cleanBaseUrl();
		const response = await requestUrl({
			url: `${baseUrl}/api/v1/sync`,
			method: "POST",
			throw: false,
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.settings.apiToken.trim()}`,
			},
			body: JSON.stringify(request),
		});

		if (response.status >= 400) {
			throw new Error(`Server returned ${response.status}: ${response.text}`);
		}

		const payload = response.json as Partial<SyncResponse>;
		if (typeof payload.serverSeq !== "number" || !Array.isArray(payload.changes)) {
			throw new Error("Server returned an invalid sync payload.");
		}

		return {
			serverSeq: payload.serverSeq,
			changes: payload.changes,
		};
	}

	private cleanBaseUrl(): string {
		return this.settings.serverUrl.trim().replace(/\/+$/, "");
	}

	private isSafePath(path: string): boolean {
		if (!path || path.startsWith("/")) {
			return false;
		}

		if (path.startsWith(`${this.app.vault.configDir}/`)) {
			return false;
		}

		const parts = path.split("/");
		for (const part of parts) {
			if (!part || part === "." || part === "..") {
				return false;
			}
		}

		return true;
	}

	private async applyRemoteChanges(
		incomingChanges: RemoteChange[],
		entryMap: Record<string, LocalEntry>,
		syncStartedAt: number,
	): Promise<ApplyResult> {
		const ordered = [...incomingChanges].sort((a, b) => a.seq - b.seq);
		const latestByPath = new Map<string, RemoteChange>();
		let appliedUpserts = 0;
		let appliedDeletes = 0;
		let skipped = 0;

		for (const rawChange of ordered) {
			const safePath = normalizePath(rawChange.path || "");
			if (!this.isSafePath(safePath)) {
				skipped += 1;
				continue;
			}

			latestByPath.set(safePath, {
				...rawChange,
				path: safePath,
			});
		}

		const collapsedChanges = [...latestByPath.values()].sort((a, b) => a.seq - b.seq);

		for (const rawChange of collapsedChanges) {
			if (rawChange.originDeviceId === this.state.deviceId) {
				continue;
			}

			const safePath = rawChange.path;

			if (rawChange.op === "delete") {
				const existing = this.app.vault.getAbstractFileByPath(safePath);
				if (existing instanceof TFile) {
					await this.app.vault.delete(existing);
				}
				delete entryMap[safePath];
				appliedDeletes += 1;
				continue;
			}

			if (typeof rawChange.content !== "string") {
				skipped += 1;
				continue;
			}

			const hash = rawChange.hash ?? fnv1aHash(rawChange.content);
			const current = this.app.vault.getAbstractFileByPath(safePath);

			if (current instanceof TFile) {
				const currentContent = await this.app.vault.cachedRead(current);
				const currentHash = fnv1aHash(currentContent);
				if (currentHash === hash) {
					entryMap[safePath] = {
						path: safePath,
						mtime: current.stat.mtime,
						size: current.stat.size,
						hash,
					};
					continue;
				}

				if (current.stat.mtime > syncStartedAt) {
					// Keep very recent local edits if the user was typing during sync.
					skipped += 1;
					continue;
				}

				await this.app.vault.modify(current, rawChange.content);
			} else {
				await this.ensureParentFolders(safePath);
				await this.app.vault.create(safePath, rawChange.content);
			}

			const updated = this.app.vault.getAbstractFileByPath(safePath);
			if (updated instanceof TFile) {
				entryMap[safePath] = {
					path: safePath,
					mtime: updated.stat.mtime,
					size: updated.stat.size,
					hash,
				};
				appliedUpserts += 1;
			} else {
				skipped += 1;
			}
		}

		return {
			appliedUpserts,
			appliedDeletes,
			skipped,
		};
	}

	private async ensureParentFolders(path: string): Promise<void> {
		const parts = path.split("/");
		parts.pop();
		if (parts.length === 0) {
			return;
		}

		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			const existing = this.app.vault.getAbstractFileByPath(current);
			if (existing) {
				continue;
			}
			await this.app.vault.createFolder(current).catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				if (!message.includes("already exists")) {
					throw error;
				}
			});
		}
	}
}

class UnraidVaultSyncSettingTab extends PluginSettingTab {
	private readonly plugin: UnraidVaultSyncPlugin;

	public constructor(app: App, plugin: UnraidVaultSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	public display(): void {
		const { containerEl } = this;
		const settings = this.plugin.getSettings();

		containerEl.empty();
		containerEl.createEl("h2", { text: "Unraid Vault Sync" });

		new Setting(containerEl)
			.setName("Server URL")
			.setDesc("URL of your Docker sync service, for example: http://192.168.1.10:8787")
			.addText((text) =>
				text
					.setPlaceholder("http://127.0.0.1:8787")
					.setValue(settings.serverUrl)
					.onChange(async (value) => {
						await this.plugin.updateSettings({ serverUrl: value.trim() });
					}),
			);

		new Setting(containerEl)
			.setName("API token")
			.setDesc("Bearer token configured on the sync server.")
			.addText((text) =>
				text
					.setPlaceholder("Paste token")
					.setValue(settings.apiToken)
					.onChange(async (value) => {
						await this.plugin.updateSettings({ apiToken: value.trim() });
					}),
			);

		new Setting(containerEl)
			.setName("Vault ID")
			.setDesc("Must be identical on all devices that should sync together.")
			.addText((text) =>
				text
					.setPlaceholder("my-main-vault")
					.setValue(settings.vaultId)
					.onChange(async (value) => {
						await this.plugin.updateSettings({ vaultId: value.trim() });
					}),
			);

		new Setting(containerEl)
			.setName("Extensions")
			.setDesc("Comma-separated list. Default is .md. Use * for all file types.")
			.addText((text) =>
				text
					.setPlaceholder(".md")
					.setValue(settings.includeExtensions)
					.onChange(async (value) => {
						await this.plugin.updateSettings({ includeExtensions: value.trim() });
					}),
			);

		new Setting(containerEl)
			.setName("Sync controls")
			.setDesc("Use command palette action: Sync notes with self-hosted backend.")
			.addButton((button) =>
				button.setButtonText("Sync now").onClick(async () => {
					await this.plugin.runSync();
				}),
			)
			.addButton((button) =>
				button.setButtonText("Test server").onClick(async () => {
					await this.plugin.testServerConnection();
				}),
			);
	}
}

function fnv1aHash(value: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}
