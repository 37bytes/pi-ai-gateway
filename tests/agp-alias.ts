import assert from "node:assert/strict";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext, ProviderConfig } from "@oh-my-pi/pi-coding-agent";
import { createSessionRuntime } from "../src/session-runtime.ts";
import { saveConfig, type ProxyConfig } from "../src/config.ts";
import { writeDiscoveryCache } from "../src/cache.ts";
import { cacheScope } from "../src/cache-scope.ts";
import { profilePaths } from "../src/profiles.ts";
import { PREFERRED_CONTRACT } from "../src/fetch-usage.ts";
import type { Discovery, DiscoveryCustomEntry } from "../src/fetch-models.ts";

assert.ok(process.env.PI_GATEWAY_TEST_HOME && process.env.HOME === process.env.PI_GATEWAY_TEST_HOME);
const route = (id: string): DiscoveryCustomEntry => ({ id, wireId: id, selectorId: id.split("/")[1]!, providerId: "fixture", providerKind: "opencode", name: id, api: "openai-completions", suggestedProvider: "opencode", ownedBy: "fixture", metadataState: "catalog", priceState: "known", reasoning: false, input: ["text"], contextWindow: 10000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
const endpoints = { prod: "https://prod.invalid/v1", test: "https://test.invalid/v1" };
for (const profile of ["prod", "test"] as const) {
 const cfg: ProxyConfig = { proxy: { endpoint: endpoints[profile], apiKey: `synthetic-${profile}` }, builtinProviders: {}, customProviders: {}, registerAll: true, discoveryExcludes: [], overrides: {}, refreshIntervalMinutes: 0, usageCacheTtlMs: 0 };
 saveConfig(profile, cfg);
 const entries = [route("opencode/shared"), ...(profile === "test" ? [route("opencode/test-only")] : [])];
 const discovery: Discovery = { source: "well-known", upstreamVersion: "fixture", builtinProviders: [], customPool: entries, serverDiscoveryExcludes: [], upstreamTotal: entries.length };
 writeDiscoveryCache(profilePaths(profile), discovery, cacheScope(endpoints[profile], cfg.proxy.apiKey, PREFERRED_CONTRACT));
}
const nativeAgp: ProviderConfig = { baseUrl: endpoints.test, api: "openai-completions" };
const providers = new Map<string, ProviderConfig>([["agp", nativeAgp]]);
let selected = { provider: "agp", id: "opencode/shared", api: "openai-completions", baseUrl: endpoints.test } as Model<Api>;
let refuse = false;
let stale = false;
let changes = 0;
const pi = {
 registerProvider(name: string, config: ProviderConfig) { providers.set(name, config); },
 unregisterProvider(name: string) { providers.delete(name); },
 getFlag() { return undefined; }, appendEntry() {},
 setModel(model: Model<Api>) { if (refuse) return false; selected = model; changes++; return true; },
 getThinkingLevel() { return "high"; }, setThinkingLevel(value: string) { assert.equal(value, "high"); },
};
const ctx = {
 agent: { kind: "main" }, hasUI: false,
 sessionManager: { getSessionId: () => "alias-fixture", getEntries: () => [], isSessionOnDisk: () => false },
 isIdle: () => true, hasPendingMessages: () => false,
 models: {
 current: () => selected,
 list: () => [],
 resolve: (selector: string) => {
  if (stale) return selected;
  const split = selector.indexOf("/"); const provider = selector.slice(0, split); const id = selector.slice(split + 1);
  const config = providers.get(provider); const model = config?.models?.find(item => item.id === id);
  return model && config ? { ...model, provider, api: model.api ?? config.api, baseUrl: config.baseUrl } : undefined;
 },
 },
};
// Fixtures implement only host operations exercised by the real runtime.
const runtime = createSessionRuntime(pi as unknown as ExtensionAPI, { root: { id: "test", source: "launch-env" } });
const context = ctx as unknown as ExtensionContext;
const originalFetch = globalThis.fetch;
let requests = 0;
globalThis.fetch = (async (input, init) => {
 requests++;
 const request = new Request(input, init);
 assert.equal(request.url, `${endpoints.prod}/chat/completions`);
 assert.equal(request.headers.get("authorization"), "Bearer synthetic-prod");
 const payload: unknown = await request.json();
 assert.ok(payload && typeof payload === "object" && "model" in payload);
 assert.equal(payload.model, "opencode/shared");
 const base = { id: "fixture", object: "chat.completion.chunk", created: 0, model: "opencode/shared" };
 const frames = [{ ...base, choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] }, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }];
 return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}) as typeof fetch;
try {
 await runtime.bindSession(context);
 assert.equal(selected.api, "agp:opencode:openai-completions");
 assert.equal(selected.baseUrl, endpoints.test);
 const switched = await runtime.switchEnvironment(context, "prod");
 assert.equal(switched.ok, true, switched.message);
 assert.equal(selected.provider, "agp");
 assert.equal(selected.id, "opencode/shared");
 assert.equal(selected.baseUrl, endpoints.prod);
 assert.equal(runtime.bindingFor("alias-fixture")?.id, "prod");
 const result = await providers.get("opencode")!.streamSimple!(selected, { messages: [{ role: "user", content: "synthetic", timestamp: 0 }] }, { sessionId: "alias-fixture" }).result();
 assert.notEqual(result.stopReason, "error", JSON.stringify(result));
 assert.equal(requests, 1);
 const oldModel = selected;
 stale = true;
 assert.equal((await runtime.switchEnvironment(context, "test")).ok, false);
 assert.equal(runtime.bindingFor("alias-fixture")?.id, "prod");
 assert.equal(selected, oldModel);
 stale = false; refuse = true;
 assert.equal((await runtime.switchEnvironment(context, "test")).ok, false);
 assert.equal(runtime.bindingFor("alias-fixture")?.id, "prod");
 refuse = false;
 selected = { ...oldModel, id: "opencode/test-only" };
 assert.equal((await runtime.switchEnvironment(context, "test")).ok, true);
 assert.equal((await runtime.switchEnvironment(context, "prod")).ok, false);
 assert.equal(runtime.bindingFor("alias-fixture")?.id, "test");
 selected = { ...oldModel, provider: "ds", id: "direct", api: "openai-completions", baseUrl: "https://direct.invalid/v1" };
 const direct = selected; const before = changes;
 assert.equal((await runtime.switchEnvironment(context, "prod")).ok, true);
 assert.equal(selected, direct); assert.equal(changes, before);
 assert.equal(providers.get("agp"), nativeAgp, "native AGP provider, image routes and auth must not be replaced");
 assert.equal(requests, 1, "no discovery or real provider requests");
 console.log("PASS AGP alias: target transport and wire request, stale resolver and host-refusal rollback, missing target refusal, direct ds unchanged");
} finally { globalThis.fetch = originalFetch; }
