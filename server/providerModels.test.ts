import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverProviderModels, normalizeProviderUrl } from "./providerModels.js";

test("catalog URLs accept base and full inference endpoints", () => {
  for (const suffix of ["/", "/responses", "/chat/completions/", "/models"]) {
    assert.equal(normalizeProviderUrl(`https://example.com/v1${suffix}`), "https://example.com/v1");
  }
  for (const url of ["file:///tmp/a", "https://user:secret@example.com", "https://example.com?key=secret", "invalid"]) {
    assert.throws(() => normalizeProviderUrl(url));
  }
});

test("discovery preserves exact IDs and sends credentials only to the requested endpoint", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    assert.equal(url, "https://example.com/v1/models");
    assert.equal((options.headers as Record<string, string>).authorization, "Bearer secret");
    assert.equal(options.redirect, "error");
    return Response.json({ data: [{ id: "gemma4:4b-cloud" }, { id: "qwen/model:latest", display_name: "Qwen" }, { id: "gemma4:4b-cloud" }, null] });
  });
  assert.deepEqual(await discoverProviderModels("custom", "https://example.com/v1/chat/completions", "secret"), [
    { id: "gemma4:4b-cloud", displayName: "gemma4:4b-cloud" }, { id: "qwen/model:latest", displayName: "Qwen" },
  ]);
});

test("native Ollama lists installed tags without needing a credential", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    assert.equal(url, "http://localhost:11434/api/tags");
    assert.deepEqual(options.headers, {});
    return Response.json({ models: [{ name: "gemma4:4b" }, { model: "llama:latest" }] });
  });
  assert.equal((await discoverProviderModels("ollama", "http://localhost:11434", "")).length, 2);
});

test("discovery reports auth, unsupported listing, malformed and empty responses", async (t) => {
  for (const [response, message] of [
    [new Response("private upstream details", { status: 401 }), /valid API key/],
    [new Response("missing", { status: 404 }), /does not expose/],
    [new Response("not JSON"), /did not return JSON/],
    [Response.json({ unexpected: [] }), /unsupported model list/],
  ] as const) {
    const mock = t.mock.method(globalThis, "fetch", async () => response);
    await assert.rejects(discoverProviderModels("openai", "https://example.com/v1", ""), message);
    mock.mock.restore();
  }
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [] }));
  assert.deepEqual(await discoverProviderModels("openai", "https://example.com/v1", ""), []);
});
