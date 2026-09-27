import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { codexHome, getProjectPath, makeConfigToml, providerEnvironment, getProvider, getWebSearchSettings, type ProviderSettings } from "./config.js";

type RpcId = string | number;
type RpcMessage = { id?: RpcId; method?: string; params?: any; result?: any; error?: { code?: number; message?: string; data?: unknown } };

export class AppServer extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<RpcId, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private nextId = 1;
  status: "unconfigured" | "starting" | "ready" | "error" = "unconfigured";
  error: string | undefined;
  private settings: ProviderSettings | null = null;
  private activeTurns = new Map<string, string>();
  private searchReadyThreads = new Map<string, { native: boolean; beeja: boolean }>();

  async start(settings: ProviderSettings): Promise<void> {
    await this.stop();
    this.settings = settings;
    this.status = "starting";
    this.error = undefined;
    this.emit("status", this.status);
    const webSearch = await getWebSearchSettings();
    await writeFile(join(codexHome, "config.toml"), makeConfigToml(settings, webSearch.enabled), { mode: 0o600 });
    await chmod(join(codexHome, "config.toml"), 0o600);
    const env = providerEnvironment(settings);
    // Do not let Codex discover or reuse a ChatGPT session from the launching user's home.
    delete env.OPENAI_API_KEY;
    const child = spawn(process.env.CODEX_BIN || "codex", ["app-server"], {
      cwd: await getProjectPath(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.receiveLine(line));
    child.stderr.on("data", (chunk: Buffer) => {
      const message = chunk.toString().trim();
      if (message) this.emit("log", message);
    });
    child.on("error", (error) => this.fail(error.message));
    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.status !== "error") this.fail(`Codex app-server exited (${signal || (code ?? "unknown")}).`);
    });
    try {
      await this.request("initialize", {
        clientInfo: { name: "beeja-controller", title: "Beeja Controller", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      });
      this.notify("initialized", {});
      this.status = "ready";
      this.emit("status", this.status);
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    const old = this.child;
    this.child = null;
    if (old && old.exitCode === null) {
      old.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => { old.kill("SIGKILL"); resolve(); }, 1500);
        old.once("exit", () => { clearTimeout(timeout); resolve(); });
      });
    }
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error("Codex app-server stopped."));
    }
    this.pending.clear();
    this.activeTurns.clear();
    if (!this.settings) this.status = "unconfigured";
    this.emit("status", this.status);
  }

  request(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<any> {
    if (!this.child || this.child.exitCode !== null) return Promise.reject(new Error("Codex app-server is not running."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    if (!this.child || this.child.exitCode !== null) return;
    this.send({ method, params });
  }

  reply(id: RpcId, result: unknown): void { this.send({ id, result }); }
  replyError(id: RpcId, code: number, message: string): void { this.send({ id, error: { code, message } }); }

  async createThread(projectPath?: string, model?: string): Promise<any> {
    if (!this.settings) throw new Error("Configure a provider before creating a thread.");
    const search = await getWebSearchSettings();
    const result = await this.request("thread/start", {
      cwd: projectPath || await getProjectPath(),
      model: model || this.settings.model,
      modelProvider: providerId(this.settings.provider),
      historyMode: "legacy",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      ...(search.enabled && (search.tavilyApiKey || await hasOllamaCloudSearch()) ? { dynamicTools: [webSearchTool] } : {}),
    });
    const threadId = result?.thread?.id || result?.threadId;
    if (typeof threadId === "string") this.searchReadyThreads.set(threadId, {
      native: search.enabled,
      beeja: Boolean(search.enabled && (search.tavilyApiKey || await hasOllamaCloudSearch())),
    });
    return result;
  }

  async getSearchStatus(threadId?: string): Promise<any> {
    const settings = await getWebSearchSettings();
    const provider = await getProvider();
    const ollama = Boolean(provider?.apiKey && isOllamaCloudProvider(provider));
    const beejaConfigured = Boolean(settings.tavilyApiKey || ollama);
    const thread = threadId ? this.searchReadyThreads.get(threadId) : undefined;
    return {
      enabled: settings.enabled,
      tavilyConfigured: Boolean(settings.tavilyApiKey),
      ollamaCloudConfigured: ollama,
      endpointUrl: settings.endpointUrl,
      native: { configured: settings.enabled, availability: settings.enabled ? "unverified" : "disabled", threadReady: thread?.native ?? null, source: "Codex native search" },
      beeja: { configured: beejaConfigured, threadReady: thread?.beeja ?? null, sources: [ ...(ollama ? ["Ollama Cloud"] : []), ...(settings.tavilyApiKey ? ["Tavily-compatible endpoint"] : []) ] },
      status: !settings.enabled ? "disabled" : beejaConfigured ? "configured" : "unknown",
      threadId: threadId || null,
      newThreadRequired: true,
    };
  }

  async listModels(): Promise<any[]> {
    const result = await this.request("model/list", { limit: 200, includeHidden: false });
    const models = Array.isArray(result?.data) ? result.data : [];
    const normalized = models.map((model: any) => ({
      id: model.model || model.id,
      displayName: model.displayName,
      supportedReasoningEfforts: Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts.map((effort: any) => typeof effort === "string" ? effort : effort.reasoningEffort).filter(Boolean) : undefined,
      defaultReasoningEffort: model.defaultReasoningEffort,
      toolSupport: typeof model.supportsTools === "boolean" ? (model.supportsTools ? "supported" : "unsupported") : typeof model.supportsToolCalling === "boolean" ? (model.supportsToolCalling ? "supported" : "unsupported") : "unknown",
    }));
    // Custom providers commonly expose the OpenAI-compatible /models endpoint;
    // its model IDs are authoritative for this configured provider.
    if (this.settings) {
      try {
        const url = `${this.settings.baseUrl.replace(/\/+$/, "")}/models`;
        const response = await fetch(url, { headers: this.settings.apiKey ? { authorization: `Bearer ${this.settings.apiKey}` } : {}, signal: AbortSignal.timeout(8_000) });
        if (response.ok) {
          const body = await response.json() as any;
          const remote = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : [];
          const byId = new Map<string, any>(normalized.map((entry: any) => [entry.id, entry] as [string, any]));
          const discovered: any[] = [];
          for (const item of remote) {
            const id = typeof item === "string" ? item : item.id || item.name;
            if (typeof id === "string" && id) discovered.push({ ...byId.get(id), id, displayName: item.display_name || item.displayName || id });
          }
          if (discovered.length) return discovered;
        }
      } catch { /* provider model listing is optional; use Codex's catalog */ }
    }
    return normalized;
  }

  async callDynamicTool(params: any): Promise<any> {
    if (params?.tool !== "web_search" || params?.namespace !== "beeja") throw new Error("Unknown dynamic tool.");
    const settings = await getWebSearchSettings();
    if (!settings.enabled) throw new Error("Enable web search in settings first.");
    const query = typeof params.arguments?.query === "string" ? params.arguments.query.trim() : "";
    if (!query || query.length > 1000) throw new Error("Search query must be between 1 and 1000 characters.");
    const provider = await getProvider();
    const useOllama = Boolean(provider?.apiKey && isOllamaCloudProvider(provider));
    if (!settings.tavilyApiKey && !useOllama) throw new Error("Configure an Ollama Cloud provider or a Tavily-compatible search endpoint in settings first.");
    const searches = await Promise.allSettled([
      useOllama ? fetch("https://ollama.com/api/web_search", {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${provider!.apiKey}` },
        body: JSON.stringify({ query }), signal: AbortSignal.timeout(20_000),
      }).then(async (response) => { if (!response.ok) throw new Error(`Ollama Cloud search failed (${response.status}).`); return await response.json() as any; }) : Promise.resolve(null),
      settings.tavilyApiKey ? fetch(settings.endpointUrl, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${settings.tavilyApiKey}` },
        body: JSON.stringify({ query, search_depth: "basic", max_results: 5, include_answer: true }), signal: AbortSignal.timeout(20_000),
      }).then(async (response) => { if (!response.ok) throw new Error(`Configured search failed (${response.status}).`); return await response.json() as any; }) : Promise.resolve(null),
    ]);
    const succeeded = searches.filter((result): result is PromiseFulfilledResult<any> => result.status === "fulfilled" && result.value);
    if (!succeeded.length && searches.some((result) => result.status === "rejected")) throw (searches.find((result): result is PromiseRejectedResult => result.status === "rejected") as PromiseRejectedResult).reason;
    const results = succeeded.flatMap((result) => Array.isArray(result.value.results) ? result.value.results.slice(0, 5).map((item: any) => ({ title: item.title, url: item.url, content: item.content })) : []);
    const uniqueResults = [...new Map(results.filter((item) => item.url).map((item) => [item.url, item])).values()].slice(0, 8);
    const answers = succeeded.map((result) => result.value.answer).filter(Boolean);
    return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify({ answers, results: uniqueResults }) }] };
  }

  async listThreads(): Promise<any> {
    return this.request("thread/list", { limit: 50, sortKey: "updated_at", cwd: await getProjectPath() });
  }

  async listSkills(): Promise<any> {
    return this.request("skills/list", { cwds: [await getProjectPath()], forceReload: false });
  }

  async setSkillEnabled(input: { path?: string; name?: string; enabled: boolean }): Promise<any> {
    return this.request("skills/config/write", input);
  }

  async readThread(threadId: string): Promise<any> {
    try {
      return await this.request("thread/read", { threadId, includeTurns: true });
    } catch (error) {
      if (error instanceof Error && error.message.includes("is not materialized yet")) {
        return { thread: { id: threadId, turns: [] } };
      }
      throw error;
    }
  }

  async getLastTurnChanges(threadId: string): Promise<Array<{ path: string; status: string; added: number; deleted: number; diff: string }>> {
    const result = await this.readThread(threadId);
    const turns = Array.isArray(result?.thread?.turns) ? result.thread.turns : [];
    const turn = [...turns].reverse().find((item: any) => Array.isArray(item.items) && item.items.some((entry: any) => entry.type === "fileChange"));
    const changes = (turn?.items || []).filter((item: any) => item.type === "fileChange").flatMap((item: any) => item.changes || []);
    return changes.map((change: any) => {
      const diff = typeof change.diff === "string" ? change.diff : "";
      return {
        path: String(change.path || ""),
        status: String(change.kind || "M"),
        added: diff.match(/^\+(?!\+).*/gm)?.length || 0,
        deleted: diff.match(/^-(?!--).*/gm)?.length || 0,
        diff,
      };
    }).filter((change: any) => change.path);
  }

  async startTurn(threadId: string, text: string, options: { model?: string; effort?: string } = {}): Promise<any> {
    const result = await this.request("turn/start", { threadId, input: [{ type: "text", text }], ...(options.model ? { model: options.model } : {}), ...(options.effort ? { effort: options.effort } : {}) });
    const turnId = result?.turn?.id || result?.turnId;
    if (turnId) this.activeTurns.set(threadId, turnId);
    return result;
  }

  async interrupt(threadId: string, turnId?: string): Promise<any> {
    const activeTurnId = turnId || this.activeTurns.get(threadId);
    if (!activeTurnId) throw new Error("No active turn was found for this thread.");
    return this.request("turn/interrupt", { threadId, turnId: activeTurnId });
  }

  private send(value: object): void {
    if (!this.child || this.child.exitCode !== null) throw new Error("Codex app-server is not running.");
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  private receiveLine(line: string): void {
    let message: RpcMessage;
    try { message = JSON.parse(line) as RpcMessage; }
    catch { this.emit("log", `Ignored malformed app-server output: ${line.slice(0, 200)}`); return; }
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message || "App-server request failed."));
        else pending.resolve(message.result);
        return;
      }
    }
    if (message.method === "turn/started" && message.params?.threadId && message.params?.turn?.id) {
      this.activeTurns.set(message.params.threadId, message.params.turn.id);
    }
    if (message.method === "turn/completed" && message.params?.threadId) {
      this.activeTurns.delete(message.params.threadId);
    }
    this.emit("message", message);
  }

  private fail(message: string): void {
    this.status = "error";
    this.error = message;
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error(message));
    }
    this.pending.clear();
    this.emit("status", this.status);
    this.emit("errorMessage", message);
  }
}

const webSearchTool = {
  type: "namespace",
  name: "beeja",
  description: "Tools provided by the Beeja app.",
  tools: [{
    type: "function",
    name: "web_search",
    description: "Search the web using configured Ollama Cloud search and/or a Tavily-compatible endpoint. Use when current facts, sources, or recent information are useful.",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "Search query" } }, required: ["query"], additionalProperties: false },
  }],
};

async function hasOllamaCloudSearch(): Promise<boolean> {
  const provider = await getProvider();
  return Boolean(provider?.apiKey && isOllamaCloudProvider(provider));
}

function isOllamaCloudProvider(provider: ProviderSettings): boolean {
  try { return new URL(provider.baseUrl).hostname === "ollama.com" || provider.provider.toLowerCase().includes("ollama cloud"); }
  catch { return false; }
}

function providerId(provider: string) {
  return `beeja_${provider.toLowerCase().replace(/[^a-z0-9_-]/g, "_").replace(/^[^a-z]+/, "provider_") || "custom"}`;
}
