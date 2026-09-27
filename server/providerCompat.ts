import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import type { ProviderSettings } from "./config.js";
import { toChatRequest, chatToResponse, responseEvents } from "./chatCompat.js";

const supportedTools = new Set(["exec_command", "write_stdin", "view_image"]);

export function isGroqEndpoint(baseUrl: string): boolean {
  try { return new URL(baseUrl).hostname.toLowerCase() === "api.groq.com"; }
  catch { return false; }
}

export function groqCompatibleRequest(request: Record<string, any>): Record<string, any> {
  const body = { ...request };
  // Groq documents these Responses fields as unsupported. Codex sends them
  // by default, even when the selected model does not use them.
  for (const key of ["store", "include", "prompt_cache_key", "client_metadata"]) delete body[key];
  if (body.reasoning && typeof body.reasoning === "object") {
    const { summary: _summary, ...reasoning } = body.reasoning;
    if (Object.keys(reasoning).length) body.reasoning = reasoning;
    else delete body.reasoning;
  }
  if (Array.isArray(body.input)) {
    body.input = body.input.map((item: any) => item?.role === "developer" ? { ...item, role: "system" } : item);
  }
  if (Array.isArray(body.tools)) {
    // Codex namespace and built-in web tools are not understood by Groq. The
    // core shell/image tools also fit the model's small free-tier input limit.
    body.tools = body.tools.filter((tool: any) => tool?.type === "function" && supportedTools.has(tool.name));
    if (!body.tools.length) {
      delete body.tools;
      delete body.tool_choice;
      delete body.parallel_tool_calls;
    }
  }
  return body;
}

export function retryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  const wait = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(wait) && wait >= 0 ? Math.min(Math.max(wait, 1000), 60_000) : null;
}

export async function startProviderCompat(settings: ProviderSettings): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const upstreamBase = settings.baseUrl.replace(/\/+$/, "");
  const upstreamPath = new URL(upstreamBase).pathname.replace(/\/+$/, "");
  const groq = isGroqEndpoint(settings.baseUrl);
  let selectedApi: "auto" | "responses" | "chat" = "auto";
  const server = createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url || "/", "http://127.0.0.1");
      const suffix = requestUrl.pathname.slice(upstreamPath.length);
      if (!requestUrl.pathname.startsWith(`${upstreamPath}/`) || !["/responses", "/models"].includes(suffix) ||
          (suffix === "/responses" ? req.method !== "POST" : req.method !== "GET")) {
        res.writeHead(404).end();
        return;
      }
      if (settings.apiKey && req.headers.authorization !== `Bearer ${settings.apiKey}`) {
        res.writeHead(401).end();
        return;
      }
      let body: string | undefined;
      let input: Record<string, any> | undefined;
      if (suffix === "/responses") {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 32 * 1024 * 1024) { res.writeHead(413).end(); return; }
          chunks.push(chunk);
        }
        input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!input || typeof input !== "object" || Array.isArray(input)) { res.writeHead(400).end(); return; }
        body = JSON.stringify(groq ? groqCompatibleRequest(input) : input);
      }
      const controller = new AbortController();
      res.on("close", () => controller.abort());
      const send = async (route: string, payload?: string) => {
        let upstream: globalThis.Response;
        for (let attempt = 0; ; attempt++) {
          upstream = await fetch(`${upstreamBase}${route}${requestUrl.search}`, {
            method: req.method,
            headers: { ...(settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {}), ...(payload ? { "content-type": "application/json" } : {}) },
            body: payload,
            signal: controller.signal,
            redirect: "manual",
          });
          const wait = retryAfterMs(upstream.headers.get("retry-after"));
          if (upstream.status !== 429 || attempt >= 2 || wait === null) break;
          await upstream.body?.cancel();
          await delay(wait, undefined, { signal: controller.signal });
        }
        return upstream;
      };
      let upstream: globalThis.Response;
      if (suffix === "/responses" && selectedApi === "chat") {
        upstream = await send("/chat/completions", JSON.stringify(toChatRequest(input!)));
      } else {
        upstream = await send(suffix, body);
        if (suffix === "/responses" && selectedApi === "auto" && [400, 404, 405, 501].includes(upstream.status)) {
          await upstream.body?.cancel();
          upstream = await send("/chat/completions", JSON.stringify(toChatRequest(input!)));
          if (upstream.ok) selectedApi = "chat";
        } else if (suffix === "/responses" && upstream.ok) selectedApi = "responses";
      }
      if (suffix === "/responses" && selectedApi === "chat" && upstream.ok) {
        let completion: Record<string, any>;
        try { completion = await upstream.json() as Record<string, any>; }
        catch { res.writeHead(502).end(JSON.stringify({ error: { message: "Chat endpoint did not return JSON." } })); return; }
        const response = chatToResponse(input!, completion);
        const payload = responseEvents(response);
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
        res.end(payload);
        return;
      }
      res.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") || "application/json",
        ...(upstream.headers.get("retry-after") ? { "retry-after": upstream.headers.get("retry-after")! } : {}),
      });
      if (upstream.body) {
        for await (const chunk of upstream.body) {
          if (!res.write(chunk)) await once(res, "drain");
        }
      }
      res.end();
    } catch (error) {
      if (res.destroyed) return;
      if (error instanceof SyntaxError) res.writeHead(400).end(JSON.stringify({ error: { message: "Invalid JSON request" } }));
      else res.writeHead(502).end(JSON.stringify({ error: { message: error instanceof Error ? error.message : "Provider compatibility request failed" } }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}${upstreamPath}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
