import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { UsageAccount, UsageDocument, UsageGroup } from "../src/fetch-usage.ts";
import { cacheScope } from "../src/cache-scope.ts";
import { renderQuotaSegment } from "../src/status-quota.ts";
import { renderUsage } from "../src/ui-usage.ts";

const home = process.env.PI_GATEWAY_TEST_HOME!;
assert.ok(home && process.env.HOME === home, "Run through scripts/run-isolated.ts");
const originalHome = process.env.HOME;
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
const originalArgv = [...process.argv];
const initialTime = Date.UTC(2026, 8, 15, 12);
let now = initialTime;
process.env.HOME = home;
Date.now = () => now;
process.argv.splice(2);
const providerId = "11111111-1111-4111-8111-111111111111";
const otherProviderId = "22222222-2222-4222-8222-222222222222";
const modelId = "gpt-6-astra";
const wireId = `codex/${modelId}`;
const theme = {
	fg(_color: "success" | "warning" | "error" | "dim", text: string) {
		return text;
	},
};
const binding = { providerId, providerKind: "codex", modelIds: [wireId, modelId] };
const freshWindow: UsageGroup = {
	id: "seven-day",
	label: "7d",
	scope: "provider_subscription",
	state: "supported",
	remainingFraction: 0.37,
	resetTime: new Date(initialTime + 3_600_000).toISOString(),
	capturedAt: new Date(initialTime).toISOString(),
};
const freshAccount: UsageAccount = {
	provider: "codex",
	providerId,
	scope: "provider_subscription",
	account: "opaque-a",
	authIndex: "opaque-a",
	label: "Subscription",
	status: "active",
	disabled: false,
	unavailable: false,
	success: 0,
	failed: 0,
	lastRequestAt: null,
	supported: true,
	groups: [freshWindow],
};
const staleOtherProvider: UsageAccount = {
	...freshAccount,
	providerId: otherProviderId,
	account: "opaque-b",
	status: "stale",
	unavailable: true,
	groups: [{ ...freshWindow, state: "stale", remainingFraction: null }],
};
const usage: UsageDocument = {
	schemaVersion: 1,
	generatedAt: new Date(initialTime).toISOString(),
	unsupportedProviders: [],
	cache: { updatedAt: new Date(initialTime).toISOString(), stale: true, ttlMs: 120_000 },
	accounts: [freshAccount, staleOtherProvider],
};
const cfg = {
	proxy: { endpoint: "https://freshness.test/v1", apiKey: "fixture-key-a", providerPrefix: "" },
	registerAll: true,
	builtinProviders: {},
	customProviders: {},
	overrides: {},
	discoveryExcludes: [],
	refreshIntervalMinutes: 0,
	usageCacheTtlMs: 15_000,
};
const discovery = {
	schemaVersion: 1,
	builtinProviders: {},
	customModelPool: [
		{
			id: wireId,
			wireId,
			selectorId: modelId,
			canonicalModel: modelId,
			providerId,
			providerKind: "codex",
			suggestedProviderName: "codex",
			api: "openai-responses",
			name: "GPT-6 Astra",
			metadataState: "catalog",
			priceState: "known",
			reasoning: true,
			input: ["text"],
			contextWindow: 1_050_000,
			maxTokens: 128_000,
			cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
		},
	],
};

try {
	assert.match(
		renderQuotaSegment(usage, binding, theme, modelId)!,
		/7d .* 37/,
		"other connector staleness is not selected transport staleness",
	);
	const staleOtherModel: UsageGroup = {
		...freshWindow,
		id: "seven-day-other",
		label: "7d Other",
		model: "other-model",
		state: "stale",
		remainingFraction: null,
	};
	const mixed = {
		...usage,
		accounts: [{ ...freshAccount, status: "partial", groups: [freshWindow, staleOtherModel] }],
	};
	assert.match(renderQuotaSegment(mixed, binding, theme, modelId)!, /7d .* 37/);
	assert.doesNotMatch(renderQuotaSegment(mixed, binding, theme, modelId)!, /Other|stale/);
	assert.equal(
		renderQuotaSegment(
			{ ...usage, accounts: [{ ...freshAccount, status: "stale", groups: [staleOtherModel] }] },
			binding,
			theme,
			modelId,
		),
		"quota unknown",
		"an unrelated model's stale window is not a selected stale window",
	);
	assert.equal(
		renderQuotaSegment(usage, binding, theme, modelId, { localStale: true }),
		"quota stale",
	);

	const legacy: UsageAccount = {
		...freshAccount,
		providerId: undefined,
		groups: [{ ...freshWindow, state: undefined }],
	};
	assert.equal(
		renderQuotaSegment({ ...usage, accounts: [legacy] }, { providerKind: "codex" }, theme, modelId),
		"quota stale",
	);
	assert.equal(
		renderQuotaSegment(
			{ ...usage, accounts: [{ ...freshAccount, groups: [{ ...freshWindow, state: undefined }] }] },
			binding,
			theme,
			modelId,
		),
		"quota stale",
		"native unclassified windows must retain the global conservative hint",
	);
	const currentDocument = { ...usage, cache: { ...usage.cache!, stale: false } };
	assert.equal(
		renderQuotaSegment(
			{
				...currentDocument,
				accounts: [
					{ ...freshAccount, groups: [{ ...freshWindow, resetTime: new Date(now).toISOString() }] },
				],
			},
			binding,
			theme,
			modelId,
		),
		"quota stale",
		"reset expiry is inclusive",
	);
	assert.match(
		renderQuotaSegment(
			{
				...currentDocument,
				accounts: [{ ...freshAccount, groups: [{ ...freshWindow, resetTime: "not-a-timestamp" }] }],
			},
			binding,
			theme,
			modelId,
		)!,
		/7d .* 37/,
		"invalid reset timestamps are not invented expiry dates",
	);
	const expiredDetail = renderUsage({
		...currentDocument,
		accounts: [
			{ ...freshAccount, groups: [{ ...freshWindow, resetTime: new Date(now).toISOString() }] },
		],
	}).join("\n");
	assert.match(expiredDetail, /stale/);
	assert.doesNotMatch(
		expiredDetail,
		/37%/,
		"detail view must not show old allowance past reset either",
	);

	let usageReads = 0;
	let failUsage = false;
	const authorities: string[] = [];
	const json = (body: unknown, status = 200) =>
		new Response(JSON.stringify(body), {
			status,
			headers: { "Content-Type": "application/json", "X-Pi-Contract": "2" },
		});
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const request = input instanceof Request ? input : new Request(input, init);
		const path = new URL(request.url).pathname;
		if (path === "/v0/resource/plugins/pi-bridge/well-known") return json(discovery);
		if (path === "/v0/resource/plugins/pi-bridge/capabilities")
			return json({
				schemaVersion: 1,
				plugin: "pi-bridge",
				contract: 2,
				latestContract: 2,
				endpoints: { usage: "/usage" },
			});
		if (path === "/v0/resource/plugins/pi-bridge/usage") {
			usageReads++;
			authorities.push(request.headers.get("authorization") ?? "");
			return failUsage ? json({}, 503) : json(usage);
		}
		throw new Error(`Unexpected fixture path: ${path}`);
	}) as typeof fetch;
	// These imports intentionally exercise the plugin after HOME/clock isolation:
	// their module-load cache paths must never bind to the real user directory.
	const { default: aiGateway } = await import("../index.ts");
	const { USAGE_CACHE_PATH, USAGE_LOCK_PATH, USAGE_CACHE_TTL_MS, writeUsageCache } = await import(
		"../src/usage-shared-cache.ts"
	);
	const configDir = join(home, ".pi/agent/ai-gateway");
	mkdirSync(configDir, { recursive: true });
	const configPath = join(configDir, "config.json");
	writeFileSync(configPath, JSON.stringify(cfg));
	type FixtureContext = {
		hasUI: boolean;
		model: { provider: string; id: string };
		ui: {
			theme: typeof theme;
			notify(): void;
			setStatus(key: string, value: string | undefined): void;
		};
	};
	type Handler = (event: unknown, ctx: FixtureContext) => unknown;
	const handlers = new Map<string, Handler[]>();
	await aiGateway({
		registerProvider() {},
		unregisterProvider() {},
		registerCommand() {},
		on(name: string, handler: Handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
	} as unknown as ExtensionAPI);
	let status: string | undefined;
	const ctx: FixtureContext = {
		hasUI: true,
		model: { provider: "codex", id: modelId },
		ui: {
			theme,
			notify() {},
			setStatus(_key, value) {
				status = value;
			},
		},
	};
	const emit = async (name: string) => {
		status = undefined;
		const selected = handlers.get(name);
		assert.ok(selected?.length);
		for (const handler of selected) await handler({ type: name }, ctx);
		return status;
	};

	assert.match((await emit("before_agent_start"))!, /7d .* 37/);
	assert.equal(usageReads, 1);
	now += USAGE_CACHE_TTL_MS; // Exact TTL boundary, not a wall-clock sleep.
	failUsage = true;
	assert.equal(
		await emit("before_agent_start"),
		"quota stale",
		"failed refresh carries local staleness",
	);
	assert.equal(usageReads, 2);

	writeFileSync(USAGE_LOCK_PATH, "other-fixture-process");
	utimesSync(USAGE_LOCK_PATH, now / 1000, now / 1000);
	const beforeLock = usageReads;
	assert.equal(
		await emit("before_agent_start"),
		"quota stale",
		"lock contention carries local staleness",
	);
	assert.equal(usageReads, beforeLock);
	rmSync(USAGE_LOCK_PATH);

	assert.equal(await emit("turn_end"), "quota stale");
	const beforeReadOnly = usageReads;
	assert.equal(
		await emit("turn_end"),
		"quota stale",
		"debounced read-only fallback carries local staleness",
	);
	assert.equal(usageReads, beforeReadOnly);

	failUsage = false;
	assert.match(
		(await emit("before_agent_start"))!,
		/7d .* 37/,
		"successful refresh clears local staleness despite aggregate stale hint",
	);
	const freshReads = usageReads;
	assert.match((await emit("before_agent_start"))!, /7d .* 37/);
	assert.equal(usageReads, freshReads, "same authority may reuse a fresh shared cache");

	failUsage = true;
	writeFileSync(
		configPath,
		JSON.stringify({ ...cfg, proxy: { ...cfg.proxy, apiKey: "fixture-key-b" } }),
	);
	assert.equal(
		(await import("../src/config.ts")).loadConfig().proxy.apiKey,
		"fixture-key-b",
		"fixture configuration must reload",
	);
	assert.equal(
		await emit("before_agent_start"),
		undefined,
		"another key must not inherit even a fresh old document",
	);
	assert.equal(authorities.at(-1), "Bearer fixture-key-b");
	writeFileSync(
		configPath,
		JSON.stringify({
			...cfg,
			proxy: { ...cfg.proxy, endpoint: "https://other-freshness.test/v1" },
		}),
	);
	assert.equal(
		await emit("before_agent_start"),
		undefined,
		"same key at a different endpoint must not inherit old quota",
	);
	writeFileSync(configPath, JSON.stringify(cfg));
	const beforeRestoredAuthority = usageReads;
	assert.match((await emit("before_agent_start"))!, /7d .* 37/);
	assert.equal(usageReads, beforeRestoredAuthority);

	const scope = cacheScope(cfg.proxy.endpoint, cfg.proxy.apiKey, 2);
	writeUsageCache(
		{
			...currentDocument,
			accounts: [
				{ ...freshAccount, groups: [{ ...freshWindow, resetTime: new Date(now).toISOString() }] },
			],
		},
		scope,
	);
	assert.equal(
		await emit("before_agent_start"),
		"quota stale",
		"even a fresh client cache cannot resurrect an expired reset",
	);
	const stored = JSON.parse(readFileSync(USAGE_CACHE_PATH, "utf8"));
	assert.equal(stored.doc.cache.stale, false, "local freshness must not rewrite server provenance");
	assert.equal(
		stored.doc.accounts[0].groups[0].state,
		"supported",
		"local freshness must not mutate captured observations",
	);
	console.log("quota freshness check: ok");
} finally {
	globalThis.fetch = originalFetch;
	Date.now = originalNow;
	process.argv.splice(0, process.argv.length, ...originalArgv);
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	rmSync(home, { recursive: true, force: true });
}
