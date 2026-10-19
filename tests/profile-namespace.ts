// Regression test for AGP environment namespacing.
//
// Prod and test may be live in two processes at once and OMP's provider registry
// is process-global and name-keyed, so every provider this plugin registers is
// named `agp-<profile>-<base>`. This pins the four behaviours that make that
// safe: the name helpers, the registration rename (including that the alias
// group `ds/*` is filtered by id from BOTH discovery sources), the per-profile
// catalogue used for role mapping, and the fact that the wire model id and the
// resolved credential are unchanged on the final request.

import assert from "node:assert/strict";
import type { ExtensionAPI, ProviderConfig } from "@oh-my-pi/pi-coding-agent";
import type { ProxyConfig } from "../src/config.ts";
import type { Discovery, DiscoveryBuiltinProvider, DiscoveryCustomEntry } from "../src/fetch-models.ts";
import { applyAll, buildProfileCatalog, registrationConfig } from "../src/apply.ts";
import { agpBaseName, agpProfileOf, agpProviderName } from "../src/provider-names.ts";
import { catalogHas } from "../src/role-map.ts";

const home = process.env.PI_GATEWAY_TEST_HOME!;
assert.ok(home && process.env.HOME === home, "Run through scripts/run-isolated.ts");
const originalFetch = globalThis.fetch;

// --- 1. Provider-name helpers ------------------------------------------------
assert.equal(agpProviderName("prod", "codex"), "codex");
assert.equal(agpProviderName("test", "Open Code"), "open-code");
assert.equal(agpBaseName("agp-test-opencode", ["prod", "test"]), "opencode");
assert.equal(agpBaseName("deepseek", ["prod", "test"]), "deepseek");
assert.equal(agpProfileOf("agp-prod-x", ["prod", "test"]), "prod");
assert.equal(agpProfileOf("plain", ["prod", "test"]), null);
// A namespace that merely starts with `agp-` but names no registered profile is
// not an AGP registration, so it is carried through unchanged.
assert.equal(agpBaseName("agp-staging-codex", ["prod", "test"]), "agp-staging-codex");
assert.equal(agpProfileOf("agp-staging-codex", ["prod", "test"]), null);

// --- Fixtures ----------------------------------------------------------------
const codexModels: DiscoveryCustomEntry[] = [
	{
		id: "codex/gpt-6-astra",
		wireId: "codex/gpt-6-astra",
		selectorId: "gpt-6-astra",
		providerId: "connector-codex",
		providerKind: "codex",
		canonicalModel: "openai/gpt-6-astra",
		metadataState: "catalog",
		priceState: "known",
		name: "GPT-6 Astra",
		// This suite pins the profile namespace, the wire id and the credential,
		// so the fixture states the prices and limits the gateway would report in
		// full. Unknown-price behaviour is covered by the model-contract suite.
		cost: { input: 3, output: 12, cacheRead: 0.3, cacheWrite: 3 },
		contextWindow: 1_050_000,
		maxTokens: 128_000,
		api: "openai-completions",
		suggestedProvider: "codex",
		ownedBy: "codex",
	},
	{
		id: "codex/gpt-6-vega",
		wireId: "codex/gpt-6-vega",
		selectorId: "gpt-6-vega",
		providerId: "connector-codex",
		providerKind: "codex",
		canonicalModel: "openai/gpt-6-vega",
		metadataState: "catalog",
		priceState: "known",
		name: "GPT-6 Vega",
		cost: { input: 4, output: 16, cacheRead: 0.4, cacheWrite: 4 },
		contextWindow: 1_050_000,
		maxTokens: 128_000,
		api: "openai-completions",
		suggestedProvider: "codex",
		ownedBy: "codex",
	},
];
// The canonical deepseek group and the `ds` alias group share one provider id.
const deepseekModels: DiscoveryCustomEntry[] = [
	{
		id: "deepseek/deepseek-v4",
		wireId: "deepseek/deepseek-v4",
		selectorId: "deepseek-v4",
		providerId: "connector-ds",
		providerKind: "deepseek",
		metadataState: "catalog",
		priceState: "known",
		name: "DeepSeek V4",
		api: "openai-completions",
		suggestedProvider: "deepseek",
		ownedBy: "deepseek",
	},
	{
		id: "deepseek/deepseek-v4-flash",
		wireId: "deepseek/deepseek-v4-flash",
		selectorId: "deepseek-v4-flash",
		providerId: "connector-ds",
		providerKind: "deepseek",
		metadataState: "catalog",
		priceState: "known",
		name: "DeepSeek V4 Flash",
		api: "openai-completions",
		suggestedProvider: "deepseek",
		ownedBy: "deepseek",
	},
];
const dsAliasModels: DiscoveryCustomEntry[] = deepseekModels.map((model) => ({
	...model,
	id: model.id.replace("deepseek/", "ds/"),
	wireId: model.wireId!.replace("deepseek/", "ds/"),
	suggestedProvider: "ds",
	ownedBy: "ds",
}));
// A providerId-free entry: the pre-connector legacy pool shape.
const localGlmModel: DiscoveryCustomEntry = {
	id: "local-glm",
	wireId: "local-glm",
	metadataState: "catalog",
	priceState: "known",
	name: "Local GLM",
	api: "openai-completions",
	suggestedProvider: "local-glm",
	ownedBy: "local",
};
const builtinProvider: DiscoveryBuiltinProvider = {
	name: "openai",
	api: "openai-responses",
	models: [
		{
			id: "gpt-6-astra",
			metadataState: "catalog",
			priceState: "known",
			name: "GPT-6 Astra",
			reasoning: true,
			contextWindow: 1_050_000,
			maxTokens: 128_000,
			cost: { input: 10, output: 50 },
		},
	],
};
const discovery: Discovery = {
	source: "well-known",
	upstreamVersion: "fixture",
	builtinProviders: [builtinProvider],
	customPool: [...codexModels, ...deepseekModels, ...dsAliasModels, localGlmModel],
	serverDiscoveryExcludes: [],
	upstreamTotal: 7,
};
const fixtureIds = new Set<string>([
	builtinProvider.models[0]!.id,
	...discovery.customPool.map((entry) => entry.id),
]);
const cfg: ProxyConfig = {
	proxy: { endpoint: "https://gateway.test/v1", apiKey: "fixture-key", providerPrefix: "cpa" },
	builtinProviders: { openai: { enabled: true, models: ["gpt-6-astra"] } },
	customProviders: {},
	registerAll: true,
	discoveryExcludes: ["ds/*"],
	overrides: { "gpt-6-astra": { contextWindow: 2_000_000 } },
	refreshIntervalMinutes: 0,
	usageCacheTtlMs: 15_000,
};

// --- 2. registrationConfig ---------------------------------------------------
const prod = registrationConfig(cfg, discovery, "prod");
assert.deepEqual(Object.keys(prod.builtinProviders), ["openai"]);
assert.deepEqual(Object.keys(prod.customProviders).sort(), [
	"codex",
	"deepseek",
	"local-glm",
]);
for (const key of Object.keys(prod.customProviders)) {
	assert.ok(!key.includes("ds"), `the ds alias group must not produce a provider: ${key}`);
}
assert.deepEqual(
	prod.customProviders["codex"]!.models.map((model) => model.id).sort(),
	["codex/gpt-6-astra", "codex/gpt-6-vega"],
);
assert.deepEqual(
	prod.customProviders["deepseek"]!.models.map((model) => model.id).sort(),
	["deepseek/deepseek-v4", "deepseek/deepseek-v4-flash"],
);
assert.deepEqual(prod.customProviders["local-glm"]!.models.map((m) => m.id), ["local-glm"]);
assert.deepEqual(prod.builtinProviders["openai"]!.models, ["gpt-6-astra"]);
// Wire ids are never rewritten: every model id is exactly the fixture's.
for (const provider of Object.values(prod.customProviders)) {
	for (const model of provider.models) assert.ok(fixtureIds.has(model.id), model.id);
}
// Overrides pass through untouched.
assert.deepEqual(prod.overrides, cfg.overrides);
assert.equal(prod.overrides, cfg.overrides, "the overrides block must be carried by reference");

// The `ds/*` pattern filters by id, not by provider name: a pattern matching no
// id drops nothing.
const wide = registrationConfig({ ...cfg, discoveryExcludes: ["*:*"] }, discovery, "prod");
assert.deepEqual(Object.keys(wide.customProviders).sort(), [
	"codex",
	"deepseek",
	"ds",
	"local-glm",
]);
assert.equal(wide.customProviders["ds"]!.models.length, 2);

// Same fixture under the test prefix.
const test = registrationConfig(cfg, discovery, "test");
assert.deepEqual(Object.keys(test.builtinProviders), ["openai"]);
assert.deepEqual(Object.keys(test.customProviders).sort(), [
	"codex",
	"deepseek",
	"local-glm",
]);

// The input config is never mutated.
assert.deepEqual(Object.keys(cfg.customProviders), []);
assert.deepEqual(Object.keys(cfg.builtinProviders), ["openai"]);

// An explicitly configured group keeps its own name (prefixed).
const cfgPrivate: ProxyConfig = {
	...cfg,
	customProviders: { "local-private": { api: "openai-completions", models: [{ id: "local-glm" }] } },
};
const privateNamespaced = registrationConfig(cfgPrivate, discovery, "prod");
assert.ok(privateNamespaced.customProviders["local-private"]);

// --- 3. buildProfileCatalog --------------------------------------------------
const catalog = buildProfileCatalog(cfg, discovery, "prod", ["prod", "test"]);
assert.deepEqual([...catalog.providers.keys()].sort(), ["codex", "deepseek", "local-glm", "openai"]);
assert.equal(catalogHas(catalog, "codex", "gpt-6-astra"), true);
assert.equal(catalogHas(catalog, "codex", "codex/gpt-6-astra"), true);
assert.equal(catalogHas(catalog, "deepseek", "deepseek-v4-flash"), true);
assert.equal(catalogHas(catalog, "openai", "gpt-6-astra"), true);
assert.equal(catalogHas(catalog, "codex", "gpt-6-unknown"), false);
assert.equal(catalog.providers.get("codex")!.has("codex/gpt-6-unknown"), false);
assert.equal(catalogHas(catalog, "missing", "gpt-6-astra"), false);

// --- 4. applyAll -------------------------------------------------------------
try {
	const registered = new Map<string, ProviderConfig>();
	const pi = {
		registerProvider(name: string, config: ProviderConfig) {
			registered.set(name, config);
		},
		unregisterProvider(name: string) {
			registered.delete(name);
		},
	} as unknown as ExtensionAPI;
	const report = await applyAll(pi, cfg, discovery, { profile: "prod", profileIds: ["prod", "test"] });
	const expectedNames = [
		"codex",
		"deepseek",
		"local-glm",
		"openai",
	];
	assert.deepEqual(report.registered.map((entry) => entry.provider).sort(), expectedNames);
	assert.deepEqual([...registered.keys()].sort(), expectedNames);

	const codexProvider = registered.get("codex")!;
	assert.deepEqual(
		codexProvider.models!.map((model) => model.id).sort(),
		["gpt-6-astra", "gpt-6-vega"],
	);
	const selected = {
		...codexProvider.models![0]!,
		provider: "codex",
		api: codexProvider.api!,
		baseUrl: codexProvider.baseUrl!,
		compat: undefined,
	};
	const context = { messages: [{ role: "user" as const, content: "fixture request", timestamp: 0 }] };
	// Identity guard: only a model that names this exact registered provider and
	// transport may dispatch, so another connector can never serve this route.
	assert.throws(
		() =>
			codexProvider.streamSimple!(
				{ ...selected, provider: "deepseek" },
				context,
				{ apiKey: "fixture-key" },
			),
		/transport identity/,
	);

	// The wire id and the resolved credential are the ones the profile owns.
	const observed: Array<{ url: string; model: unknown; authorization: string | null }> = [];
	const sseBody =
		[
			{
				id: "chat-fixture",
				object: "chat.completion.chunk",
				created: 0,
				model: codexModels[0]!.wireId,
				choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }],
			},
			{
				id: "chat-fixture",
				object: "chat.completion.chunk",
				created: 0,
				model: codexModels[0]!.wireId,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
			},
		]
			.map((event) => `data: ${JSON.stringify(event)}\n\n`)
			.join("") + "data: [DONE]\n\n";
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const request = new Request(input, init);
		const payload = (await request.json()) as { model?: unknown };
		observed.push({
			url: new URL(request.url).pathname,
			model: payload.model,
			authorization: request.headers.get("authorization"),
		});
		return new Response(sseBody, {
			headers: { "Content-Type": "text/event-stream", "X-Request-ID": "fixture-request-id" },
		});
	}) as typeof fetch;
	const result = await codexProvider.streamSimple!(selected, context, {
		apiKey: "wrong-provider-key",
		maxTokens: 256,
	}).result();
	assert.equal(result.stopReason, "stop", result.errorMessage);
	assert.ok(result.content.some((part) => part.type === "text" && part.text === "ok"));
	assert.equal(observed.length, 1);
	assert.equal(observed[0]!.url, "/v1/chat/completions");
	assert.equal(observed[0]!.model, "codex/gpt-6-astra", "the wire id must be unrewritten");
	assert.equal(
		observed[0]!.authorization,
		`Bearer ${cfg.proxy.apiKey}`,
		"the profile's resolved credential must be reasserted at the transport",
	);

	console.log("ok profile-namespace: names, registration, catalog, wire-id");
} finally {
	globalThis.fetch = originalFetch;
}
