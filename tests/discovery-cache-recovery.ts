// Regression test for the discovery-cache lock-in.
//
// A pool the host rejects must never stay cached: while it did, every later
// start applied the same rejected copy, failed the same way and never reached
// the network, so a single unroutable entry kept the whole gateway catalog
// unregistered. These cases pin both halves of the fix — a poisoned cache is
// recovered from on startup, and a rejected discovery is dropped instead of
// being replayed.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { applyDiscovery } from "../src/apply.ts";
import { cacheScope } from "../src/cache-scope.ts";
import { profilePaths } from "../src/profiles.ts";

const home = process.env.PI_GATEWAY_TEST_HOME!;
assert.ok(home && process.env.HOME === home, "Run through scripts/run-isolated.ts");
const originalHome = process.env.HOME;
const originalArgv = [...process.argv];
const originalFetch = globalThis.fetch;

const ENDPOINT = "https://proxy.test/v1";
const API_KEY = "test-key";
const PROVIDER_ID = "11111111-1111-4111-8111-111111111111";

/** A cached discovery entry: the selector repeats the namespace for `bad`. */
function cachedEntry(id: string, selector: string, provider: string) {
	return {
		id,
		selectorId: selector,
		providerId: PROVIDER_ID,
		providerKind: "codex",
		canonicalModel: selector,
		name: `${provider} ${selector}`,
		api: "openai-responses",
		suggestedProvider: provider,
		ownedBy: provider,
	};
}

/** The same entry as the gateway reports it on /v1/models. */
function rawEntry(id: string, selector: string, provider: string) {
	return {
		id,
		providerId: PROVIDER_ID,
		providerKind: "codex",
		selectorId: selector,
		suggestedProviderName: provider,
		canonicalModel: selector,
		api: "openai-responses",
		owned_by: provider,
		name: `${provider} ${selector}`,
		reasoning: true,
		contextWindow: 128_000,
		maxTokens: 16_000,
	};
}

function seedCache(pool: unknown[]): string {
	const path = profilePaths("prod").discoveryCachePath;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(
		path,
		JSON.stringify({
			savedAt: Date.now(),
			scope: cacheScope(ENDPOINT, API_KEY, 2),
			discovery: {
				source: "well-known",
				upstreamVersion: "agp",
				builtinProviders: [],
				customPool: pool,
				serverDiscoveryExcludes: [],
				upstreamTotal: pool.length,
			},
		}),
	);
	return path;
}

function stubGateway(pool: unknown[]): { fetches: () => number } {
	let fetches = 0;
	globalThis.fetch = (async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		fetches++;
		if (url.endsWith("/v1/models")) {
			return new Response(JSON.stringify({ object: "list", data: pool }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		// The bridge discovery paths are unavailable, so discovery falls back to
		// /v1/models exactly as it does against a gateway without the façade.
		return new Response("not found", { status: 404 });
	}) as typeof fetch;
	return { fetches: () => fetches };
}

async function runExtension(): Promise<Array<{ name: string; models: number }>> {
	const { default: aiGateway } = await import("../index.ts");
	const registered: Array<{ name: string; models: number }> = [];
	await aiGateway({
		registerProvider(name: string, ...rest: unknown[]) {
			const first = rest[0] as { models?: unknown[] } | undefined;
			const second = rest[1];
			const models = Array.isArray(first?.models) ? first.models.length : Array.isArray(second) ? second.length : 0;
			registered.push({ name, models });
		},
		registerCommand() {},
		registerFlag() {},
		getFlag() {
			return undefined;
		},
		on() {},
	} as unknown as Parameters<typeof aiGateway>[0]);
	return registered;
}

try {
	process.env.HOME = home;
	process.argv.splice(2, process.argv.length - 2, "--mode", "json", "-p", "--no-session");

	const configDir = join(home, ".pi", "agent", "ai-gateway");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(
		join(configDir, "config.json"),
		JSON.stringify({ proxy: { endpoint: ENDPOINT, apiKey: API_KEY }, registerAll: true }),
	);

	const poisonedCache = seedCache([
		cachedEntry("codex/codex/gpt-5.6-terra", "codex/gpt-5.6-terra", "codex"),
	]);
	const gateway = stubGateway([
		rawEntry("codex/gpt-5.6-terra", "gpt-5.6-terra", "codex"),
		rawEntry("opencode/glm-5.2", "glm-5.2", "opencode"),
	]);

	const registered = await runExtension();
	const names = registered.map((entry) => entry.name).sort();
	assert.deepEqual(names, ["agp-prod-codex", "agp-prod-opencode"], `expected the fresh pool to register, got ${JSON.stringify(registered)}`);
	assert.equal(registered.find((entry) => entry.name === "agp-prod-codex")?.models, 1);
	assert.ok(gateway.fetches() > 0, "a rejected cached discovery must trigger a network fetch");

	const rewritten = JSON.parse(readFileSync(poisonedCache, "utf8")) as { discovery: { customPool: Array<{ id: string; selectorId?: string }> } };
	const nested = rewritten.discovery.customPool.filter((entry) => (entry.selectorId ?? "").includes("/"));
	assert.deepEqual(nested, [], "the rewritten cache must not carry an unroutable route");
	assert.ok(
		rewritten.discovery.customPool.some((entry) => entry.id === "codex/gpt-5.6-terra"),
		"the rewritten cache must hold the usable pool",
	);

	// A discovery the host rejects is dropped, never left on disk for the next
	// start to replay.
	const rejectedPath = seedCache([
		cachedEntry("codex/codex/gpt-5.6-terra", "codex/gpt-5.6-terra", "codex"),
	]);
	const poisoned = {
		source: "well-known",
		upstreamVersion: "agp",
		builtinProviders: [],
		customPool: [cachedEntry("codex/codex/gpt-5.6-terra", "codex/gpt-5.6-terra", "codex")],
		serverDiscoveryExcludes: [],
		upstreamTotal: 1,
	} as unknown as Parameters<typeof applyDiscovery>[2];
	const { loadConfig } = await import("../src/config.ts");
	await assert.rejects(
		() =>
			applyDiscovery({} as never, loadConfig(), poisoned, {
				profile: "prod",
				profileIds: ["prod", "test"],
				paths: profilePaths("prod"),
			}),
		/Invalid gateway route/,
		"the host rejects the unroutable entry before any provider registration",
	);
	assert.equal(
		existsSync(profilePaths("prod").discoveryCachePath),
		false,
		"a rejected discovery must invalidate the profile's own cache",
	);
	assert.equal(existsSync(rejectedPath), false, "a rejected discovery must invalidate the cache");

	console.log("discovery cache recovery: ok");
} finally {
	globalThis.fetch = originalFetch;
	process.argv.splice(0, process.argv.length, ...originalArgv);
	process.env.HOME = originalHome;
}
