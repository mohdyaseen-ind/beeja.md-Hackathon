import express, { type Request, type Response, type NextFunction } from "express";
import { execFile } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { createServer } from "node:http";
import { access, stat, readdir, lstat, readFile, realpath, writeFile, chmod, rename, mkdir } from "node:fs/promises";
import { isAbsolute, resolve, relative, sep, basename, join } from "node:path";
import { lookup } from "node:dns/promises";
import { promisify } from "node:util";
import { WebSocketServer, WebSocket } from "ws";
import { AppServer } from "./appServer.js";
import {
  ensureDataDir, codexHome, getProvider, getProjectPath, getProjects, addProject, saveProvider, saveProjectPath,
  toPublicProvider, readInstructionFile, writeInstructionFile, getWebSearchSettings, saveWebSearchSettings, githubGitEnvironment, type ProviderSettings,
} from "./config.js";

const app = express();
const httpServer = createServer(app);
const appServer = new AppServer();
const port = Number(process.env.PORT || 3000);
const bind = process.env.BIND_ADDRESS || "127.0.0.1";
const clients = new Set<WebSocket>();
const approvals = new Map<string, { id: string | number; method: string; params: any }>();
const execFileAsync = promisify(execFile);
let projectWatcher: FSWatcher | null = null;
let watchedProjectPath = "";
let projectChangeTimer: NodeJS.Timeout | undefined;
const pendingProjectPaths = new Set<string>();
type UsageBreakdown = { totalTokens: number; inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number; outputTokens: number; reasoningOutputTokens: number };
type TurnUsageRecord = {
  threadId: string; turnId: string; baselineTotal: UsageBreakdown | null; total: UsageBreakdown | null;
  usage: UsageBreakdown | null; usageSource: "responses" | "thread-total-delta" | "unavailable";
  contextWindowTokens: number | null; calls: Array<{ responseId: string; usage: UsageBreakdown }>;
  startedAt?: number; completedAt?: number;
};
const turnUsage = new Map<string, TurnUsageRecord>();
const threadUsageTotals = new Map<string, UsageBreakdown>();
const usageFile = join(codexHome, "beeja-usage.json");
let usageWriteQueue = Promise.resolve();

app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));
app.use("/api", (req, res, next) => {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    const origin = req.headers.origin;
    if (origin && !isSameOrigin(origin, req.headers.host)) {
      return res.status(403).json({ error: "Requests must come from this app's origin." });
    }
  }
  next();
});

const wsServer = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
httpServer.on("upgrade", (request, socket, head) => {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (request.url !== "/ws" || (origin && !isSameOrigin(origin, host))) {
    socket.destroy();
    return;
  }
  wsServer.handleUpgrade(request, socket, head, (ws) => wsServer.emit("connection", ws, request));
});
wsServer.on("connection", (ws) => {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
  ws.send(JSON.stringify({ type: "status", status: appServer.status, error: appServer.error }));
  for (const [id, approval] of approvals) {
    ws.send(JSON.stringify({ type: "approval", id, method: approval.method, params: approval.params }));
  }
});

appServer.on("message", (message: any) => {
  // Codex exposes user-facing reasoning summaries separately from internal
  // reasoning text. Never forward the latter to browser clients.
  if (message.method === "item/reasoning/textDelta") return;
  if (message.method === "item/tool/call" && message.id !== undefined) {
    void appServer.callDynamicTool(message.params).then(
      (result) => appServer.reply(message.id, result),
      (error) => {
        const detail = messageOf(error);
        broadcast({ type: "toolError", threadId: message.params?.threadId, turnId: message.params?.turnId, tool: message.params?.tool, error: detail });
        appServer.reply(message.id, { success: false, contentItems: [{ type: "inputText", text: detail }] });
      },
    );
    return;
  }
  if (message.method && message.id !== undefined && isApprovalMethod(message.method)) {
    const key = String(message.id);
    approvals.set(key, { id: message.id, method: message.method, params: message.params || {} });
    broadcast({ type: "approval", id: key, method: message.method, params: message.params || {} });
    return;
  }
  const params = message.params || {};
  const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
  const turnId = typeof params.turnId === "string" ? params.turnId : undefined;
  if (message.method === "rawResponse/completed") {
    if (threadId && turnId && params.usage) {
      const record = ensureTurnUsage(threadId, turnId);
      const responseId = typeof params.responseId === "string" ? params.responseId : `response-${record.calls.length + 1}`;
      if (!record.calls.some((call) => call.responseId === responseId)) {
        record.calls.push({ responseId, usage: cleanUsage(params.usage) });
        record.usage = sumUsage(record.calls.map((call) => call.usage));
        record.usageSource = "responses";
        persistTurnUsage();
      }
    }
    // This notification is marked internal-only by Codex. Surface only the
    // normalized counts, never provider response metadata.
    return;
  }
  const publicMessage = message.method === "item/completed" && params.item?.type === "reasoning"
    ? { ...message, params: { ...params, item: { type: "reasoning", id: params.item.id, summary: Array.isArray(params.item.summary) ? params.item.summary : [] } } }
    : message;
  broadcast(publicMessage);
  if (message.method === "turn/started" && threadId && params.turn?.id) {
    const id = usageKey(threadId, String(params.turn.id));
    if (!turnUsage.has(id)) turnUsage.set(id, {
      threadId, turnId: String(params.turn.id), baselineTotal: threadUsageTotals.get(threadId) || null,
      total: null, usage: null, usageSource: "unavailable", contextWindowTokens: null, calls: [], startedAt: Date.now(),
    });
    persistTurnUsage();
  }
  if (message.method === "thread/tokenUsage/updated" && params.tokenUsage) {
    const tokenUsage = params.tokenUsage;
    const previousTotal = threadId ? threadUsageTotals.get(threadId) : undefined;
    const currentTotal = tokenUsage.total ? cleanUsage(tokenUsage.total) : null;
    if (threadId && currentTotal) threadUsageTotals.set(threadId, currentTotal);
    let record: TurnUsageRecord | undefined;
    if (threadId && turnId) {
      record = ensureTurnUsage(threadId, turnId);
      record.total = currentTotal;
      record.contextWindowTokens = typeof tokenUsage.modelContextWindow === "number" ? tokenUsage.modelContextWindow : null;
      if (record.calls.length) {
        record.usage = sumUsage(record.calls.map((call) => call.usage));
        record.usageSource = "responses";
      } else {
        const baseline = record.baselineTotal || previousTotal || null;
        if (baseline && currentTotal) {
          record.usage = deltaUsage(baseline, currentTotal);
          record.baselineTotal ||= baseline;
          record.usageSource = "thread-total-delta";
        } else {
          record.usage = null;
          record.usageSource = "unavailable";
        }
      }
      persistTurnUsage();
    }
    broadcast({
      type: "tokenUsage",
      threadId,
      turnId,
      usage: record?.usage || null,
      usageSource: record?.usageSource || "unavailable",
      lastCall: tokenUsage.last ? cleanUsage(tokenUsage.last) : null,
      total: tokenUsage.total || null,
      contextWindowTokens: tokenUsage.modelContextWindow ?? null,
    });
  }
  if (message.method === "item/reasoning/summaryTextDelta" && typeof params.delta === "string") {
    broadcast({ type: "reasoningTrace", threadId, turnId, itemId: params.itemId, delta: params.delta, summaryIndex: params.summaryIndex, phase: "delta" });
  }
  if (message.method === "item/completed" && params.item?.type === "reasoning" && Array.isArray(params.item.summary)) {
    broadcast({ type: "reasoningTrace", threadId, turnId, itemId: params.item.id, text: params.item.summary.join("\n"), phase: "completed" });
  }
  if (message.method === "item/fileChange/patchUpdated" && Array.isArray(params.changes)) {
    const paths = [...new Set(params.changes.map((change: any) => typeof change?.path === "string" ? change.path : "").filter(Boolean))];
    broadcast({ type: "projectFilesChanged", projectPath: watchedProjectPath, paths, threadId, turnId, source: "codex" });
  }
  if (message.method === "turn/completed" && threadId && params.turn?.id) {
    const record = turnUsage.get(usageKey(threadId, String(params.turn.id)));
    if (record) { record.completedAt = Date.now(); persistTurnUsage(); }
  }
});
appServer.on("status", (status: string) => {
  if (status === "starting" || status === "error") approvals.clear();
  broadcast({ type: "status", status, error: appServer.error });
});
appServer.on("errorMessage", (error: string) => broadcast({ type: "status", status: "error", error }));

app.get("/api/status", async (_req, res) => {
  const provider = await getProvider();
  res.json({
    projectPath: await getProjectPath(),
    appServer: { status: appServer.status, ...(appServer.error ? { error: appServer.error } : {}) },
    config: toPublicProvider(provider),
    webSearch: await appServer.getSearchStatus(),
  });
});

app.get("/api/provider", async (_req, res) => res.json(toPublicProvider(await getProvider())));
app.post("/api/provider", async (req, res, next) => {
  try {
    const input = req.body as Partial<ProviderSettings>;
    const provider = cleanText(input.provider, "Provider", 64);
    const baseUrl = cleanText(input.baseUrl, "Base URL", 2048);
    const model = cleanText(input.model, "Model", 128);
    const previous = await getProvider();
    const apiKey = typeof input.apiKey === "string"
      ? input.apiKey.trim()
      : previous?.provider === provider ? previous.apiKey : "";
    if (apiKey.length > 4096) return res.status(400).json({ error: "API key is too long." });
    if (input.wireApi && input.wireApi !== "responses") {
      return res.status(400).json({ error: "Codex custom providers currently require the Responses API (wire_api=responses). Chat Completions only endpoints are not supported." });
    }
    let parsed: URL;
    try { parsed = new URL(baseUrl); } catch { return res.status(400).json({ error: "Enter a valid provider base URL." }); }
    if (!(["http:", "https:"].includes(parsed.protocol)) || parsed.username || parsed.password) {
      return res.status(400).json({ error: "Provider URL must use HTTP or HTTPS and cannot contain embedded credentials." });
    }
    if (/\/(chat\/completions|responses)\/?$/i.test(parsed.pathname)) {
      return res.status(400).json({ error: "Enter the provider base URL, not a /chat/completions or /responses endpoint. Codex appends the Responses API route itself." });
    }
    const settings: ProviderSettings = { provider, baseUrl: parsed.toString().replace(/\/$/, ""), model, apiKey, wireApi: "responses" };
    await saveProvider(settings);
    try {
      await appServer.start(settings);
      return res.json({ ok: true, provider: toPublicProvider(settings), appServer: { status: appServer.status } });
    } catch (error) {
      return res.status(503).json({ ok: false, provider: toPublicProvider(settings), appServer: { status: appServer.status, error: messageOf(error) } });
    }
  } catch (error) { next(error); }
});

app.get("/api/models", route(async (_req, res) => {
  assertReady();
  res.json({ models: await appServer.listModels() });
}));

app.get("/api/web-search", route(async (_req, res) => {
  const threadId = typeof _req.query.threadId === "string" ? _req.query.threadId : undefined;
  res.json(await appServer.getSearchStatus(threadId));
}));
app.put("/api/web-search", route(async (req, res) => {
  const previous = await getWebSearchSettings();
  const enabled = typeof req.body?.enabled === "boolean" ? req.body.enabled : previous.enabled;
  const apiKey = typeof req.body?.tavilyApiKey === "string" ? req.body.tavilyApiKey.trim() : previous.tavilyApiKey;
  const endpointUrl = typeof req.body?.endpointUrl === "string" ? req.body.endpointUrl.trim() : previous.endpointUrl;
  if (apiKey.length > 4096) return res.status(400).json({ error: "Tavily API key is too long." });
  let endpoint: URL;
  try { endpoint = new URL(endpointUrl); } catch { return res.status(400).json({ error: "Enter a valid Tavily-compatible search endpoint URL." }); }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) return res.status(400).json({ error: "Search endpoint must use HTTPS and cannot contain embedded credentials." });
  await saveWebSearchSettings({ enabled, tavilyApiKey: apiKey, endpointUrl: endpoint.toString() });
  const provider = await getProvider();
  if (provider) await appServer.start(provider);
  res.json({ ok: true, webSearch: await appServer.getSearchStatus(), restartRequired: Boolean(provider), newThreadRequired: true, appServer: { status: appServer.status } });
}));

app.post("/api/project", async (req, res, next) => {
  try {
    const projectPath = await validateProjectPath(req.body?.projectPath, res);
    if (!projectPath) return;
    await saveProjectPath(projectPath);
    watchProject(projectPath);
    res.json({ ok: true, projectPath, projects: await getProjects(), appServer: { status: appServer.status } });
  } catch (error) { next(error); }
});

app.get("/api/projects", route(async (_req, res) => {
  res.json({ projects: await getProjects() });
}));

app.get("/api/git/status", route(async (_req, res) => {
  const projectPath = await getProjectPath();
  const [gitVersion, ghVersion, ghAuth, repositoryRoot, remote, branch, githubDns] = await Promise.allSettled([
    execFileAsync("git", ["--version"], { timeout: 5_000 }),
    execFileAsync("gh", ["--version"], { timeout: 5_000 }),
    execFileAsync("gh", ["auth", "status", "--hostname", "github.com"], { timeout: 8_000 }),
    git(projectPath, ["rev-parse", "--show-toplevel"]),
    git(projectPath, ["remote", "get-url", "origin"]),
    git(projectPath, ["branch", "--show-current"]),
    lookup("github.com"),
  ]);
  const isRepository = repositoryRoot.status === "fulfilled";
  res.json({
    projectPath,
    gitInstalled: gitVersion.status === "fulfilled",
    ghInstalled: ghVersion.status === "fulfilled",
    ghAuthenticated: ghAuth.status === "fulfilled",
    githubReachable: githubDns.status === "fulfilled",
    githubError: githubDns.status === "rejected" ? messageOf(githubDns.reason) : null,
    isRepository,
    repositoryRoot: isRepository ? repositoryRoot.value.trim() : null,
    remoteUrl: remote.status === "fulfilled" ? redactRemoteUrl(remote.value.trim()) : null,
    branch: branch.status === "fulfilled" ? branch.value.trim() : null,
  });
}));

app.post("/api/git/clone", route(async (req, res) => {
  let url: string;
  try { url = parseGithubCloneUrl(req.body?.url); }
  catch (error) { return res.status(400).json({ error: messageOf(error) }); }
  const parsed = new URL(url);
  const [owner, repository] = parsed.pathname.slice(1).replace(/\/$/, "").replace(/\.git$/i, "").split("/");
  const cloneRoot = resolve(codexHome, "..", "repositories");
  const destination = join(cloneRoot, owner, repository);
  await mkdir(join(cloneRoot, owner), { recursive: true, mode: 0o700 });
  try {
    await lstat(destination);
    return res.status(409).json({ error: "This repository folder already exists. Choose it from Projects, or move it before cloning again." });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await execFileAsync("git", ["clone", "--", url, destination], {
      cwd: cloneRoot, timeout: 180_000, maxBuffer: 250_000,
      env: { ...process.env, ...githubGitEnvironment(), GIT_TERMINAL_PROMPT: "0" },
    });
  } catch (error) {
    const detail = messageOf(error);
    const hint = /authentication|could not read Username|Repository not found|403|401/i.test(detail)
      ? "GitHub authentication may be required. Run gh auth login on this Mac, then retry."
      : /resolve host|network|timed out/i.test(detail)
        ? "This Mac could not reach GitHub. Check its network and DNS connection."
        : "Git clone failed. Check the repository URL and access permissions.";
    return res.status(502).json({ error: hint });
  }
  await saveProjectPath(destination);
  watchProject(destination);
  res.json({ ok: true, projectPath: destination, projects: await getProjects() });
}));

app.get("/api/files", route(async (req, res) => {
  const { root, target } = await projectTarget(req.query.path);
  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isDirectory()) return res.status(400).json({ error: "The requested path is not a regular project directory." });
  const entries = (await readdir(target, { withFileTypes: true })).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)).map((entry) => ({
    name: entry.name, path: relative(root, resolve(target, entry.name)).split(sep).join("/"), isDirectory: entry.isDirectory(), isFile: entry.isFile(),
  }));
  res.json({ root, path: relative(root, target).split(sep).join("/"), entries });
}));
app.get("/api/files/content", route(async (req, res) => {
  const { root, target } = await projectTarget(req.query.path);
  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isFile()) return res.status(400).json({ error: "Only regular project files can be previewed." });
  if (info.size > 1_000_000) return res.status(413).json({ error: "File preview is limited to 1 MB." });
  const bytes = await readFile(target);
  if (bytes.includes(0)) return res.status(415).json({ error: "Binary files cannot be previewed as text." });
  res.json({ path: relative(root, target).split(sep).join("/"), content: bytes.toString("utf8"), encoding: "utf8" });
}));

app.get("/api/review/branches", route(async (_req, res) => {
  const root = await getProjectPath();
  const [current, branches] = await Promise.all([
    git(root, ["branch", "--show-current"]).catch(() => ""),
    git(root, ["for-each-ref", "--format=%(refname:short)\t%(objectname:short)", "refs/heads"]).catch(() => ""),
  ]);
  res.json({ current: current.trim(), branches: branches.split("\n").filter(Boolean).map((line) => { const [name, sha] = line.split("\t"); return { name, sha }; }) });
}));
app.get("/api/review/commits", route(async (req, res) => {
  const root = await getProjectPath();
  const branch = typeof req.query.branch === "string" ? req.query.branch : "HEAD";
  if (!/^[\w./-]{1,200}$/.test(branch) || branch.startsWith("-") || branch.includes("..")) return res.status(400).json({ error: "Invalid branch name." });
  const output = await git(root, ["log", "-20", "--format=%H\t%s", branch]);
  res.json({ commits: output.split("\n").filter(Boolean).map((line) => { const [sha, ...subject] = line.split("\t"); return { sha, subject: subject.join("\t") }; }) });
}));
app.get("/api/review", route(async (req, res) => {
  const root = await getProjectPath();
  const filter = typeof req.query.filter === "string" ? req.query.filter : "uncommitted";
  if (filter === "last-turn") {
    const threadId = typeof req.query.threadId === "string" ? req.query.threadId : "";
    if (!threadId) return res.status(400).json({ error: "Select a chat to inspect its last turn changes." });
    assertReady();
    const changes = await appServer.getLastTurnChanges(threadId);
    const files = changes.map((change) => {
      const changePath = isAbsolute(change.path) ? resolve(change.path) : resolve(root, change.path);
      const rel = relative(root, changePath);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
      return { ...change, path: rel.split(sep).join("/") };
    }).filter(Boolean);
    res.json({ filter, files, diff: files.map((file: any) => file.diff).join("\n") });
    return;
  }
  const hasHead = await git(root, ["rev-parse", "--verify", "HEAD"]).then(() => true).catch(() => false);
  let args: string[];
  if (filter === "unstaged") args = ["diff", "--no-ext-diff", "--", "."];
  else if (filter === "staged") args = ["diff", "--cached", "--no-ext-diff", "--", "."];
  else if (filter === "uncommitted" || filter === "last-turn") args = hasHead ? ["diff", "HEAD", "--no-ext-diff", "--", "."] : ["diff", "--no-ext-diff", "--", "."];
  else if (filter === "committed") {
    const commit = typeof req.query.commit === "string" ? req.query.commit : "HEAD";
    if (!/^[0-9a-f]{7,40}$/i.test(commit) && commit !== "HEAD") return res.status(400).json({ error: "Invalid commit reference." });
    args = ["show", "--format=", "--no-ext-diff", commit, "--", "."];
  } else if (filter === "branch") {
    const branch = typeof req.query.branch === "string" ? req.query.branch : "";
    if (!/^[\w./-]{1,200}$/.test(branch) || branch.startsWith("-") || branch.includes("..")) return res.status(400).json({ error: "Select a valid branch." });
    args = ["diff", "--no-ext-diff", `${branch}...HEAD`, "--", "."];
  } else return res.status(400).json({ error: "Unknown review filter." });
  const diff = filter === "uncommitted" && !hasHead
    ? `${await git(root, ["diff", "--cached", "--no-ext-diff", "--", "."], 2_000_000)}${await git(root, ["diff", "--no-ext-diff", "--", "."], 2_000_000)}`
    : await git(root, args, 2_000_000);
  const nameArgs = filter === "staged" ? ["diff", "--cached", "--name-status"] : filter === "unstaged" ? ["diff", "--name-status"] : filter === "committed" ? ["diff-tree", "--no-commit-id", "--name-status", "-r", typeof req.query.commit === "string" ? req.query.commit : "HEAD"] : filter === "branch" ? ["diff", "--name-status", `${String(req.query.branch)}...HEAD`] : hasHead ? ["diff", "HEAD", "--name-status"] : ["diff", "--name-status"];
  const names = filter === "uncommitted" && !hasHead
    ? `${await git(root, ["diff", "--cached", "--name-status"]).catch(() => "")}\n${await git(root, ["diff", "--name-status"]).catch(() => "")}`
    : await git(root, nameArgs).catch(() => "");
  const files = names.split("\n").filter(Boolean).map((line) => {
    const [status, ...parts] = line.split("\t");
    const path = parts.at(-1) || "";
    const fileDiff = diff.split(/(?=^diff --git )/m).find((chunk) => chunk.split("\n").some((header) => header === `diff --git a/${path} b/${path}`));
    const added = Number(fileDiff?.match(/^\+(?!\+).*/gm)?.length || 0);
    const deleted = Number(fileDiff?.match(/^-(?!--).*/gm)?.length || 0);
    return { path, status, added, deleted, diff: fileDiff || "" };
  });
  if (filter === "uncommitted" || filter === "unstaged") {
    const status = await git(root, ["status", "--porcelain", "-z", "--untracked-files=all"]).catch(() => "");
    const untracked = status.split("\0").filter((entry) => entry.startsWith("?? ")).map((entry) => entry.slice(3));
    for (const path of untracked) {
      if (files.some((file) => file.path === path)) continue;
      let added = 0;
      let fileDiff = "";
      try {
        const { target } = await projectTarget(path);
        const info = await lstat(target);
        if (info.isFile() && !info.isSymbolicLink() && info.size <= 1_000_000) {
          const bytes = await readFile(target);
          if (!bytes.includes(0)) {
            const content = bytes.toString("utf8");
            const lines = content ? content.replace(/\n$/, "").split("\n") : [];
            added = lines.length;
            const visibleLines = lines.slice(0, 2_000);
            const suffix = lines.length > visibleLines.length ? `\n… ${lines.length - visibleLines.length} more lines omitted from preview …` : "";
            fileDiff = `diff --git a/${path} b/${path}\nnew file mode ${info.mode.toString(8).slice(-3)}\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${added} @@\n${visibleLines.map((line) => `+${line}`).join("\n")}${suffix}`;
          }
        }
      } catch { /* Keep the file listed if a safe text preview is unavailable. */ }
      files.push({ path, status: "??", added, deleted: 0, diff: fileDiff });
    }
  }
  res.json({ filter, branch: typeof req.query.branch === "string" ? req.query.branch : undefined, files, diff });
}));
app.post("/api/review/start", route(async (req, res) => {
  assertReady();
  const threadId = cleanText(req.body?.threadId, "Thread ID", 256);
  const filter = cleanText(req.body?.filter, "Review filter", 32);
  let target: any;
  if (filter === "last-turn" || filter === "unstaged" || filter === "staged") return res.status(400).json({ error: "Codex review can target all uncommitted changes, a branch, or a commit. This filter can still be inspected in the diff panel." });
  if (filter === "uncommitted") target = { type: "uncommittedChanges" };
  else if (filter === "branch") target = { type: "baseBranch", branch: cleanText(req.body?.branch, "Branch", 200) };
  else if (filter === "committed") {
    const commit = cleanText(req.body?.commit, "Commit", 64);
    if (!/^[0-9a-f]{7,40}$/i.test(commit) && commit !== "HEAD") return res.status(400).json({ error: "Invalid commit reference." });
    target = { type: "commit", sha: commit, title: null };
  }
  else return res.status(400).json({ error: "Unknown review filter." });
  res.json(await appServer.request("review/start", { threadId, target, delivery: "inline" }));
}));
app.post("/api/projects", route(async (req, res) => {
  const projectPath = await validateProjectPath(req.body?.projectPath, res);
  if (!projectPath) return;
  res.json({ ok: true, projects: await addProject(projectPath) });
}));
app.post("/api/projects/pick", route(async (_req, res) => {
  if (process.platform !== "darwin") {
    res.status(501).json({ error: "Native Finder folder selection is available on macOS. Enter an absolute path on this system." });
    return;
  }
  const script = [
    "try",
    "  return POSIX path of (choose folder with prompt \"Choose a project folder for beeja.md\")",
    "on error number -128",
    "  return \"\"",
    "end try",
  ].join("\n");
  const { stdout } = await execFileAsync("/usr/bin/osascript", ["-e", script], { timeout: 120_000, maxBuffer: 4096 });
  const projectPath = stdout.trim();
  res.json({ projectPath: projectPath ? resolve(projectPath) : null, cancelled: !projectPath });
}));

app.get("/api/instructions/:scope", route(async (req, res) => {
  const scope = pathParam(req.params.scope);
  if (scope !== "global" && scope !== "project") return res.status(400).json({ error: "Instruction scope must be global or project." });
  res.json(await readInstructionFile(scope));
}));
app.put("/api/instructions/:scope", route(async (req, res) => {
  const scope = pathParam(req.params.scope);
  if (scope !== "global" && scope !== "project") return res.status(400).json({ error: "Instruction scope must be global or project." });
  const content = req.body?.content;
  if (typeof content !== "string") return res.status(400).json({ error: "Instruction content must be a string." });
  if (Buffer.byteLength(content, "utf8") > 256 * 1024) return res.status(413).json({ error: "Instruction file cannot exceed 256 KB." });
  res.json(await writeInstructionFile(scope, content));
}));

app.get("/api/threads", route(async (_req, res) => {
  assertReady();
  res.json(await appServer.listThreads());
}));
app.get("/api/skills", route(async (_req, res) => {
  assertReady();
  res.json(await appServer.listSkills());
}));
app.put("/api/skills/config", route(async (req, res) => {
  assertReady();
  const { path, name, enabled } = req.body || {};
  if (typeof enabled !== "boolean") return res.status(400).json({ error: "enabled must be true or false." });
  if ((typeof path === "string") === (typeof name === "string")) return res.status(400).json({ error: "Provide exactly one skill path or name." });
  if (typeof path === "string" && !isAbsolute(path)) return res.status(400).json({ error: "Skill path must be absolute." });
  if (typeof path === "string" && path.length > 4096 || typeof name === "string" && (!name.trim() || name.length > 256)) {
    return res.status(400).json({ error: "Invalid skill selector." });
  }
  res.json(await appServer.setSkillEnabled({ ...(typeof path === "string" ? { path } : { name }), enabled }));
}));
app.post("/api/threads", route(async (req, res) => {
  assertReady();
  const model = typeof req.body?.model === "string" ? cleanText(req.body.model, "Model", 128) : undefined;
  const result = await appServer.createThread(undefined, model);
  const threadId = result?.thread?.id || result?.threadId;
  if (threadId) {
    threadUsageTotals.set(String(threadId), zeroUsage());
    persistTurnUsage();
  }
  res.json(result);
}));
app.get("/api/threads/:id/messages", route(async (req, res) => {
  assertReady();
  const threadId = pathParam(req.params.id);
  const result = await appServer.readThread(threadId);
  const usage = [...turnUsage.values()].filter((record) => record.threadId === threadId).sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  res.json({ ...sanitizeReasoningContent(result), beejaUsage: { turns: usage } });
}));
app.post("/api/threads/:id/turns", route(async (req, res) => {
  assertReady();
  const text = cleanText(req.body?.text, "Message", 100_000);
  const model = typeof req.body?.model === "string" ? cleanText(req.body.model, "Model", 128) : undefined;
  const effort = typeof req.body?.effort === "string" ? req.body.effort : undefined;
  if (effort && !["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(effort)) return res.status(400).json({ error: "Unsupported reasoning effort." });
  res.json(await appServer.startTurn(pathParam(req.params.id), text, { model, effort }));
}));
app.post("/api/threads/:id/interrupt", route(async (req, res) => {
  assertReady();
  res.json(await appServer.interrupt(pathParam(req.params.id), typeof req.body?.turnId === "string" ? req.body.turnId : undefined));
}));
app.post("/api/approvals/:id", route(async (req, res) => {
  const decision = req.body?.decision;
  if (decision !== "accept" && decision !== "decline") return res.status(400).json({ error: "Decision must be accept or decline." });
  const approvalId = pathParam(req.params.id);
  const approval = approvals.get(approvalId);
  if (!approval) return res.status(404).json({ error: "Approval request is no longer pending." });
  appServer.reply(approval.id, { decision });
  approvals.delete(approvalId);
  broadcast({ type: "approvalResolved", id: approvalId, decision });
  res.json({ ok: true });
}));

// Serve built frontend when present; during development Vite proxies API and WS requests here.
app.use(express.static(new URL("../web/dist", import.meta.url).pathname));
app.get("*splat", (_req, res, next) => {
  res.sendFile(new URL("../web/dist/index.html", import.meta.url).pathname, (error) => {
    if (error) next();
  });
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = messageOf(error);
  const status = message.includes("Configure a provider") || message.includes("not running") ? 409 : 500;
  res.status(status).json({ error: message });
});

function route(handler: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => { void handler(req, res).catch(next); };
}
function assertReady() {
  if (appServer.status !== "ready") throw new Error(appServer.error || "Configure a provider before using Codex.");
}
function cleanText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  if (value.trim().length > max) throw new Error(`${label} is too long.`);
  return value.trim();
}
async function validateProjectPath(value: unknown, res: Response): Promise<string | null> {
  const submitted = cleanText(value, "Project path", 4096);
  if (!isAbsolute(submitted)) {
    res.status(400).json({ error: "Project path must be absolute." });
    return null;
  }
  const projectPath = resolve(submitted);
  try {
    await access(projectPath);
    if (!(await stat(projectPath)).isDirectory()) {
      res.status(400).json({ error: "Project path must be a directory." });
      return null;
    }
  } catch {
    res.status(400).json({ error: "Project directory does not exist or is not accessible to this app." });
    return null;
  }
  return projectPath;
}
function pathParam(value: string | string[]): string { return Array.isArray(value) ? value[0] || "" : value; }
function isApprovalMethod(method: string) {
  return method.endsWith("/requestApproval") || method.endsWith("/requestUserInput");
}
function broadcast(value: unknown) {
  const json = JSON.stringify(value);
  for (const client of clients) if (client.readyState === WebSocket.OPEN) client.send(json);
}
function isSameOrigin(origin: string, host: string | undefined) {
  try {
    const parsed = new URL(origin);
    if (parsed.origin !== origin) return false;
    if (parsed.host === host) return true;
    const loopbackBind = bind === "127.0.0.1" || bind === "::1" || bind === "localhost";
    const devOrigins = new Set(["http://127.0.0.1:5173", "http://localhost:5173"]);
    return process.env.BEEJA_DEV_SERVER === "1" && process.env.NODE_ENV !== "production" && loopbackBind && devOrigins.has(parsed.origin);
  } catch { return false; }
}
function messageOf(error: unknown) { return error instanceof Error ? error.message : String(error); }
function parseGithubCloneUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 500) throw new Error("Enter a GitHub repository URL.");
  let parsed: URL;
  try { parsed = new URL(value.trim()); } catch { throw new Error("Enter a valid GitHub repository URL."); }
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com" || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/.test(parsed.pathname)) {
    throw new Error("Use a GitHub repository URL such as https://github.com/owner/repository.");
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) throw new Error("Repository owner and name must be valid path segments.");
  return `https://github.com${parsed.pathname.replace(/\/$/, "")}`;
}
function redactRemoteUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) {
      parsed.username = "";
      parsed.password = "";
    }
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch { return value.replace(/\/\/[^/@]+@/, "//"); }
}
function sanitizeReasoningContent(value: any): any {
  if (!value || typeof value !== "object") return value;
  const sanitizeTurn = (turn: any) => turn && Array.isArray(turn.items)
    ? { ...turn, items: turn.items.map((item: any) => item?.type === "reasoning" ? { type: item.type, id: item.id, summary: Array.isArray(item.summary) ? item.summary : [] } : item) }
    : turn;
  if (value.thread && Array.isArray(value.thread.turns)) return { ...value, thread: { ...value.thread, turns: value.thread.turns.map(sanitizeTurn) } };
  if (Array.isArray(value.turns)) return { ...value, turns: value.turns.map(sanitizeTurn) };
  return value;
}
function usageKey(threadId: string, turnId: string) { return `${threadId}\u0000${turnId}`; }
function cleanUsage(value: any): UsageBreakdown {
  const number = (key: keyof UsageBreakdown) => Number.isFinite(value?.[key]) ? Math.max(0, Math.trunc(value[key])) : 0;
  return { totalTokens: number("totalTokens"), inputTokens: number("inputTokens"), cachedInputTokens: number("cachedInputTokens"), cacheWriteInputTokens: number("cacheWriteInputTokens"), outputTokens: number("outputTokens"), reasoningOutputTokens: number("reasoningOutputTokens") };
}
function sumUsage(values: UsageBreakdown[]): UsageBreakdown {
  return values.reduce((total, current) => ({
    totalTokens: total.totalTokens + current.totalTokens, inputTokens: total.inputTokens + current.inputTokens,
    cachedInputTokens: total.cachedInputTokens + current.cachedInputTokens, cacheWriteInputTokens: total.cacheWriteInputTokens + current.cacheWriteInputTokens,
    outputTokens: total.outputTokens + current.outputTokens, reasoningOutputTokens: total.reasoningOutputTokens + current.reasoningOutputTokens,
  }), cleanUsage(null));
}
function deltaUsage(before: UsageBreakdown, after: UsageBreakdown): UsageBreakdown {
  const delta = (key: keyof UsageBreakdown) => Math.max(0, after[key] - before[key]);
  return { totalTokens: delta("totalTokens"), inputTokens: delta("inputTokens"), cachedInputTokens: delta("cachedInputTokens"), cacheWriteInputTokens: delta("cacheWriteInputTokens"), outputTokens: delta("outputTokens"), reasoningOutputTokens: delta("reasoningOutputTokens") };
}
function zeroUsage(): UsageBreakdown { return cleanUsage(null); }
function ensureTurnUsage(threadId: string, turnId: string): TurnUsageRecord {
  const key = usageKey(threadId, turnId);
  let record = turnUsage.get(key);
  if (!record) {
    record = { threadId, turnId, baselineTotal: threadUsageTotals.get(threadId) || null, total: null, usage: null, usageSource: "unavailable", contextWindowTokens: null, calls: [] };
    turnUsage.set(key, record);
  }
  return record;
}
async function loadTurnUsage() {
  try {
    const stored = JSON.parse(await readFile(usageFile, "utf8")) as { turns?: TurnUsageRecord[]; threadTotals?: Array<[string, UsageBreakdown]> };
    for (const [threadId, total] of stored.threadTotals || []) threadUsageTotals.set(threadId, cleanUsage(total));
    for (const item of stored.turns || []) {
      if (!item || typeof item.threadId !== "string" || typeof item.turnId !== "string") continue;
      const record: TurnUsageRecord = {
        threadId: item.threadId, turnId: item.turnId,
        baselineTotal: item.baselineTotal ? cleanUsage(item.baselineTotal) : null,
        total: item.total ? cleanUsage(item.total) : null,
        usage: item.usage ? cleanUsage(item.usage) : null,
        usageSource: ["responses", "thread-total-delta"].includes(item.usageSource) ? item.usageSource : "unavailable",
        contextWindowTokens: Number.isFinite(item.contextWindowTokens) ? item.contextWindowTokens : null,
        calls: Array.isArray(item.calls) ? item.calls.filter((call) => typeof call?.responseId === "string" && call.usage).map((call) => ({ responseId: call.responseId, usage: cleanUsage(call.usage) })) : [],
        ...(Number.isFinite(item.startedAt) ? { startedAt: item.startedAt } : {}),
        ...(Number.isFinite(item.completedAt) ? { completedAt: item.completedAt } : {}),
      };
      turnUsage.set(usageKey(record.threadId, record.turnId), record);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`Could not load saved token usage: ${messageOf(error)}`);
  }
}
function persistTurnUsage() {
  // Keep enough history for old chats while bounding the local metadata file.
  const records = [...turnUsage.values()].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0)).slice(-5000);
  const keep = new Set(records.map((record) => usageKey(record.threadId, record.turnId)));
  for (const key of turnUsage.keys()) if (!keep.has(key)) turnUsage.delete(key);
  const content = `${JSON.stringify({ turns: records, threadTotals: [...threadUsageTotals] })}\n`;
  usageWriteQueue = usageWriteQueue.then(async () => {
    const temp = `${usageFile}.tmp`;
    await writeFile(temp, content, { encoding: "utf8", mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, usageFile);
    await chmod(usageFile, 0o600);
  }).catch((error) => console.error(`Could not save token usage: ${messageOf(error)}`));
}
async function projectTarget(value: unknown): Promise<{ root: string; target: string }> {
  const root = await realpath(await getProjectPath());
  const submitted = typeof value === "string" && value ? value : root;
  const target = resolve(root, submitted);
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Path must stay within the active project directory.");
  const canonical = await realpath(target);
  const canonicalRelative = relative(root, canonical);
  if (canonicalRelative === ".." || canonicalRelative.startsWith(`..${sep}`) || isAbsolute(canonicalRelative)) throw new Error("Path must stay within the active project directory.");
  return { root, target };
}
async function git(cwd: string, args: string[], maxBuffer = 1_000_000): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, timeout: 12_000, maxBuffer, encoding: "utf8" });
  return result.stdout;
}

function watchProject(projectPath: string) {
  if (watchedProjectPath === projectPath && projectWatcher) return;
  projectWatcher?.close();
  projectWatcher = null;
  watchedProjectPath = projectPath;
  pendingProjectPaths.clear();
  try {
    projectWatcher = watch(projectPath, { recursive: true }, (_event, filename) => {
      if (!filename) {
        queueProjectChange("");
        return;
      }
      const path = String(filename).replaceAll("\\", "/");
      if (path.split("/").some((part) => part === ".git" || part === "node_modules" || part === ".next" || part === "dist")) return;
      queueProjectChange(path);
    });
    projectWatcher.on("error", () => {
      projectWatcher?.close();
      projectWatcher = null;
    });
  } catch {
    // Some platforms do not support recursive native watching. Codex file
    // change notifications remain available there.
    projectWatcher = null;
  }
}

function queueProjectChange(path: string) {
  if (path) pendingProjectPaths.add(path);
  if (projectChangeTimer) clearTimeout(projectChangeTimer);
  projectChangeTimer = setTimeout(() => {
    projectChangeTimer = undefined;
    const paths = [...pendingProjectPaths].slice(0, 250);
    pendingProjectPaths.clear();
    broadcast({ type: "projectFilesChanged", projectPath: watchedProjectPath, paths, source: "filesystem" });
  }, 120);
}

async function main() {
  await ensureDataDir();
  await loadTurnUsage();
  const settings = await getProvider();
  watchProject(await getProjectPath());
  if (settings) {
    try { await appServer.start(settings); }
    catch (error) { console.error(`Codex app-server startup failed: ${messageOf(error)}`); }
  }
  httpServer.listen(port, bind, () => console.log(`Beeja Controller listening at http://${bind}:${port}`));
}
void main();

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const client of clients) client.terminate();
  wsServer.close();
  httpServer.close();
  projectWatcher?.close();
  if (projectChangeTimer) clearTimeout(projectChangeTimer);
  void appServer.stop();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
