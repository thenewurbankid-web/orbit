// Pluggable language model for estimates and the question helper. Off until the user picks a provider:
// nothing is downloaded, and no model server is contacted, while config.json "llm".provider is "none".
//
//   "llm": { "provider": "none" | "ollama" | "openai" | "anthropic",
//            "baseUrl": "...", "model": "...", "autoEstimate": false }
//
// "openai" is any OpenAI-compatible server: OpenAI, LM Studio, llama.cpp, vLLM, OpenRouter, Groq...
// API keys: the env var named by "apiKeyEnv" (default OPENAI_API_KEY / ANTHROPIC_API_KEY), else llm-key.txt
// in the data folder (mode 600, written by the settings panel, never sent back to the page).
import { readFile, writeFile, chmod, unlink } from "node:fs/promises";
import { join } from "node:path";

export const LLM_DEFAULTS = { provider: "none", baseUrl: "", model: "", apiKeyEnv: "", autoEstimate: false };
export const PROVIDERS = {
  none: { label: "Off", baseUrl: "", model: "" },
  ollama: { label: "Ollama", baseUrl: process.env.OLLAMA_URL ?? "http://localhost:11434", model: "qwen2.5-coder:7b" },
  openai: { label: "OpenAI-compatible", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", keyEnv: "OPENAI_API_KEY" },
  anthropic: { label: "Anthropic", baseUrl: "https://api.anthropic.com", model: "claude-haiku-5-5", keyEnv: "ANTHROPIC_API_KEY" },
};

export function createLlm({ dataDir, config }) {
  const keyFile = join(dataDir, "llm-key.txt");
  const cfg = () => {
    const c = { ...LLM_DEFAULTS, ...(config().llm ?? {}) };
    if (!PROVIDERS[c.provider]) c.provider = "none";
    const d = PROVIDERS[c.provider];
    return { ...c, baseUrl: String(c.baseUrl || d.baseUrl).replace(/\/$/, ""), model: c.model || d.model };
  };
  async function apiKey(c = cfg()) {
    const env = c.apiKeyEnv || PROVIDERS[c.provider].keyEnv;
    if (env && process.env[env]) return process.env[env];
    try { return (await readFile(keyFile, "utf8")).trim() || null; } catch { return null; }
  }
  const enabled = () => cfg().provider !== "none";
  const off = () => Object.assign(new Error("No language model is connected. Pick one in Settings → Language model."), { status: 409, code: "llm_off" });

  async function post(url, headers, body, timeoutMs) {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }
  // Models sometimes wrap JSON in prose or a code fence: take the outermost object.
  const parse = (text) => { const s = String(text ?? ""), a = s.indexOf("{"), b = s.lastIndexOf("}"); return JSON.parse(a >= 0 && b > a ? s.slice(a, b + 1) : s); };
  const plain = (messages) => messages.map((m) => ({ ...m, content: String(m.content).replace(/\s*\/no_think\b/g, "") }));

  // One structured call. Same shape as before (messages, JSON schema) → { out, model }.
  async function json(messages, schema, { timeoutMs = 90000 } = {}) {
    const c = cfg();
    if (c.provider === "none") throw off();
    if (c.provider === "ollama") {
      const r = await post(c.baseUrl + "/api/chat", {}, {
        model: c.model, stream: false, keep_alive: "5m", ...(c.model.startsWith("qwen3") ? { think: false } : {}),
        options: { temperature: 0.2, num_ctx: 8192 }, format: schema, messages,
      }, timeoutMs);
      return { out: parse(r.message?.content), model: c.model };
    }
    const key = await apiKey(c);
    if (c.provider === "openai") {
      const body = { model: c.model, temperature: 0.2, messages: plain(messages), response_format: { type: "json_schema", json_schema: { name: "answer", schema } } };
      const headers = key ? { authorization: `Bearer ${key}` } : {};
      let r;
      try { r = await post(c.baseUrl + "/chat/completions", headers, body, timeoutMs); }
      catch (e) { if (!/\b400\b/.test(e.message)) throw e; r = await post(c.baseUrl + "/chat/completions", headers, { ...body, response_format: { type: "json_object" } }, timeoutMs); } // servers without json_schema
      return { out: parse(r.choices?.[0]?.message?.content), model: r.model ?? c.model };
    }
    // anthropic: the schema becomes a forced tool call.
    if (!key) throw Object.assign(new Error("Anthropic needs an API key (Settings → Language model)."), { status: 409 });
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const r = await post(c.baseUrl + "/v1/messages", { "x-api-key": key, "anthropic-version": "2023-06-01" }, {
      model: c.model, max_tokens: 2048, temperature: 0.2, ...(system ? { system } : {}),
      messages: plain(messages.filter((m) => m.role !== "system")),
      tools: [{ name: "answer", description: "Return the answer.", input_schema: schema }], tool_choice: { type: "tool", name: "answer" },
    }, timeoutMs);
    const use = r.content?.find((b) => b.type === "tool_use");
    if (!use) throw new Error("Anthropic returned no structured answer");
    return { out: use.input, model: r.model ?? c.model };
  }

  // What the page may see: never the key itself.
  async function status() {
    const c = cfg();
    return { provider: c.provider, baseUrl: c.baseUrl, model: c.model, autoEstimate: Boolean(c.autoEstimate), hasKey: Boolean(await apiKey(c)), keyEnv: c.apiKeyEnv || PROVIDERS[c.provider].keyEnv || null, providers: Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, v.label])) };
  }
  // Models on the chosen server, listed only when asked.
  async function models() {
    const c = cfg();
    if (c.provider === "none") throw off();
    const key = await apiKey(c);
    const url = c.provider === "ollama" ? c.baseUrl + "/api/tags" : c.provider === "anthropic" ? c.baseUrl + "/v1/models" : c.baseUrl + "/models";
    const headers = c.provider === "anthropic" ? { "x-api-key": key ?? "", "anthropic-version": "2023-06-01" } : key ? { authorization: `Bearer ${key}` } : {};
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`);
    const j = await res.json();
    return (j.models ?? j.data ?? []).map((m) => m.name ?? m.id).filter(Boolean).slice(0, 200);
  }
  async function test() {
    const t0 = Date.now();
    const { out, model } = await json([{ role: "user", content: 'Reply with {"ok": true}.' }], { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }, { timeoutMs: 60000 });
    return { ok: out?.ok === true, model, ms: Date.now() - t0 };
  }
  async function setKey(key) {
    if (key === null || key === "") { await unlink(keyFile).catch(() => {}); return; }
    await writeFile(keyFile, String(key).trim() + "\n", { mode: 0o600 });
    await chmod(keyFile, 0o600);
  }
  return { json, enabled, status, models, test, setKey, cfg };
}
