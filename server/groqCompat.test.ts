import assert from "node:assert/strict";
import { test } from "node:test";
import { groqCompatibleRequest, isGroqEndpoint, retryAfterMs } from "./providerCompat.js";
import { makeConfigToml, providerIdFor } from "./config.js";

test("Groq compatibility preserves the Codex shell tool and conversation while removing unsupported fields", () => {
  const original = {
    model: "qwen/qwen3.8-27b",
    input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: "Rules" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Hi" }] },
      { type: "function_call_output", call_id: "call_1", output: "done" },
    ],
    tools: [
      { type: "function", name: "exec_command", parameters: { type: "object" } },
      { type: "namespace", name: "beeja", tools: [] },
      { type: "web_search" },
    ],
    reasoning: { effort: "low", summary: "auto" },
    store: false,
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: "cache",
    client_metadata: { client: "codex" },
    stream: true,
  };
  const result = groqCompatibleRequest(original);
  assert.deepEqual(result.input.map((item: any) => item.role), ["system", "user", undefined]);
  assert.deepEqual(result.tools.map((tool: any) => tool.name), ["exec_command"]);
  assert.deepEqual(result.reasoning, { effort: "low" });
  assert.equal(result.stream, true);
  for (const key of ["store", "include", "prompt_cache_key", "client_metadata"]) assert.equal(key in result, false);
  assert.equal(original.input[0].role, "developer");
  assert.equal(original.tools.length, 3);
});

test("Groq adapter is selected by exact API hostname", () => {
  assert.equal(isGroqEndpoint("https://api.groq.com/openai/v1"), true);
  assert.equal(isGroqEndpoint("https://api.groq.com.evil.example/v1"), false);
  assert.equal(isGroqEndpoint("https://example.com/v1"), false);
});

test("Groq retry delay follows Retry-After and stays bounded", () => {
  assert.equal(retryAfterMs("2"), 2000);
  assert.equal(retryAfterMs("0"), 1000);
  assert.equal(retryAfterMs("120"), 60_000);
  assert.equal(retryAfterMs("invalid"), null);
});

test("every saved provider has the same ID in Codex config and thread creation", () => {
  for (const provider of ["ollama", "groq", "deepseek", "custom", "openai"]) {
    const id = providerIdFor(provider);
    const config = makeConfigToml({ provider, baseUrl: "https://example.com/v1", model: "model", apiKey: "key", wireApi: "responses" });
    assert.ok(config.includes(`model_provider = "${id}"`));
    assert.ok(config.includes(`[model_providers.${id}]`));
    assert.ok(config.includes("wire_api = \"responses\""));
  }
});
