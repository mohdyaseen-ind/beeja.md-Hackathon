export function normalizeProviderUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Enter a valid provider base URL."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Provider URL must use HTTP or HTTPS without embedded credentials, query parameters, or a fragment.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/(chat\/completions|responses|models)$/i, "") || "/";
  return url.toString().replace(/\/$/, "");
}

export interface DiscoveredModel { id: string; displayName: string; }

export async function discoverProviderModels(provider: string, baseUrl: string, apiKey: string): Promise<DiscoveredModel[]> {
  const base = normalizeProviderUrl(baseUrl);
  const url = new URL(base);
  // Native Ollama URLs use /api/tags; /v1 URLs use its OpenAI-compatible catalog.
  const nativeOllama = provider === "ollama" && (url.pathname === "/" || url.pathname === "/api");
  const catalogUrl = nativeOllama ? `${url.origin}/api/tags` : `${base}/models`;
  let response: Response;
  try {
    response = await fetch(catalogUrl, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
  } catch {
    throw new Error("Could not reach the model endpoint. Check the URL and try again.");
  }
  if (!response.ok) {
    await response.body?.cancel();
    if ([401, 403].includes(response.status)) throw new Error("Model listing was denied. Enter a valid API key for this endpoint.");
    if ([404, 405, 501].includes(response.status)) throw new Error("This endpoint does not expose a model list. Check the base URL or enter a model ID manually.");
    throw new Error(`Model listing failed (HTTP ${response.status}). Try again.`);
  }
  let body: any;
  try { body = await response.json(); } catch { throw new Error("The model endpoint did not return JSON."); }
  const entries = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : Array.isArray(body) ? body : null;
  if (!entries) throw new Error("The endpoint returned an unsupported model list.");
  const models = new Map<string, DiscoveredModel>();
  for (const entry of entries) {
    const id = typeof entry === "string" ? entry : entry?.id ?? entry?.name ?? entry?.model;
    if (typeof id !== "string" || !id.trim()) continue;
    const name = entry?.display_name ?? entry?.displayName;
    models.set(id, { id, displayName: typeof name === "string" && name ? name : id });
  }
  return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
}
