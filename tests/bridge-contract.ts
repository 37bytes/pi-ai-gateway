import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "pi-ai-gateway-contract-"));
const originalHome = process.env.HOME;
const originalFetch = globalThis.fetch;
process.env.HOME = home;

// Config constants derive their paths at module evaluation, so the test loads
// the known modules after isolating HOME.
const { fetchBridgeCapabilities, PLUGIN_USER_AGENT } = await import(
	"../src/bridge.ts"
);
const { fetchDiscovery } = await import("../src/fetch-models.ts");
const {
	clearUsageCache,
	fetchUsage,
	lastUsageContract,
	lastUsageSource,
} = await import("../src/fetch-usage.ts");

const cfg = {
	proxy: {
		endpoint: "https://gateway.test/v1",
		apiKey: "gateway-key",
		usageKey: "legacy-key",
		providerPrefix: "gateway",
	},
	builtinProviders: {},
	customProviders: {},
	discoveryExcludes: [],
	overrides: {},
	refreshIntervalMinutes: 0,
	usageCacheTtlMs: 15_000,
};

const discoveryDocument = {
	schemaVersion: 1,
	builtinProviders: {
		openai: {
			api: "openai-responses",
			models: [{ id: "gpt-test", name: "GPT test" }],
		},
	},
	customModelPool: [],
};

const usageDocument = {
	schemaVersion: 1,
	generatedAt: "2026-09-04T00:00:00Z",
	accounts: [],
	unsupportedProviders: [],
};

type Call = { path: string; headers: Headers };

function installFetch(respond: (call: Call) => Response | Promise<Response>): Call[] {
	const calls: Call[] = [];
	globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		const headers = new Headers(init?.headers);
		const call = { path: url.pathname, headers };
		calls.push(call);
		return respond(call);
	}) as typeof fetch;
	return calls;
}

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
	return new Response(JSON.stringify(body), { status, headers });
}

try {
	let calls = installFetch((call) => {
		assert.equal(call.path, "/v0/resource/plugins/pi-bridge/capabilities");
		return json({
			schemaVersion: 1,
			plugin: "pi-bridge",
			contract: 2,
			latestContract: 2,
			endpoints: { usage: "/usage" },
		});
	});
	const capabilities = await fetchBridgeCapabilities(
		"https://gateway.test",
		"gateway-key",
		2,
	);
	assert.deepEqual(capabilities, {
		contract: 2,
		latestContract: 2,
		usagePath: "/usage",
	});
	assert.equal(calls[0]?.headers.get("authorization"), "Bearer gateway-key");
	assert.equal(calls[0]?.headers.get("x-pi-contract"), "2");
	assert.equal(calls[0]?.headers.get("user-agent"), PLUGIN_USER_AGENT);

	calls = installFetch((call) => {
		if (call.path === "/v0/resource/plugins/pi-bridge/well-known") {
			return json(discoveryDocument);
		}
		throw new Error(`unexpected discovery request: ${call.path}`);
	});
	const viaBridge = await fetchDiscovery(cfg, "gateway-key");
	assert.equal(viaBridge.source, "well-known");
	assert.deepEqual(
		calls.map((call) => call.path),
		["/v0/resource/plugins/pi-bridge/well-known"],
	);
	assert.equal(calls[0]?.headers.get("authorization"), "Bearer gateway-key");
	assert.equal(calls[0]?.headers.get("x-pi-contract"), "2");

	calls = installFetch((call) => {
		if (call.path === "/v0/resource/plugins/pi-bridge/well-known") return json({}, 404);
		if (call.path === "/v0/resource/plugins/pi-bridge/dev/well-known") return json({}, 404);
		if (call.path === "/.well-known/pi") return json({}, 404);
		if (call.path === "/v1/models") {
			return json({ data: [{ id: "gpt-fallback", owned_by: "openai" }] });
		}
		throw new Error(`unexpected discovery fallback request: ${call.path}`);
	});
	const fallback = await fetchDiscovery(cfg, "gateway-key");
	assert.equal(fallback.source, "v1-models");
	assert.deepEqual(
		calls.map((call) => call.path),
		[
			"/v0/resource/plugins/pi-bridge/well-known",
			"/v0/resource/plugins/pi-bridge/dev/well-known",
			"/.well-known/pi",
			"/v1/models",
		],
	);
	assert.equal(calls[2]?.headers.has("authorization"), false);
	assert.equal(calls[3]?.headers.get("authorization"), "Bearer gateway-key");

	clearUsageCache();
	calls = installFetch((call) => {
		if (call.path === "/v0/resource/plugins/pi-bridge/capabilities") {
			return json({
				schemaVersion: 1,
				plugin: "pi-bridge",
				contract: 2,
				latestContract: 2,
				endpoints: { usage: "/usage" },
			});
		}
		if (call.path === "/v0/resource/plugins/pi-bridge/usage") {
			return json({ ...usageDocument, unsupportedProviders: null }, 200, { "X-Pi-Contract": "2" });
		}
		throw new Error(`unexpected plugin usage request: ${call.path}`);
	});
	assert.deepEqual(await fetchUsage(cfg, "legacy-key", { force: true }), usageDocument);
	assert.deepEqual(
		calls.map((call) => call.path),
		[
			"/v0/resource/plugins/pi-bridge/capabilities",
			"/v0/resource/plugins/pi-bridge/usage",
		],
	);
	assert.equal(calls[1]?.headers.get("authorization"), "Bearer gateway-key");
	assert.equal(calls[1]?.headers.get("x-pi-contract"), "2");
	assert.equal(lastUsageSource(), "plugin");
	assert.equal(lastUsageContract(), 2);

	clearUsageCache();
	calls = installFetch((call) => {
		if (call.path === "/v0/resource/plugins/pi-bridge/capabilities") return json({}, 404);
		if (call.path === "/v0/resource/plugins/pi-bridge/usage") return json({}, 404);
		if (call.path === "/v0/resource/plugins/pi-bridge/dev/usage") return json({}, 404);
		if (call.path === "/api/usage") return json(usageDocument);
		throw new Error(`unexpected legacy usage request: ${call.path}`);
	});
	assert.deepEqual(await fetchUsage(cfg, "legacy-key", { force: true }), usageDocument);
	assert.deepEqual(
		calls.map((call) => call.path),
		[
			"/v0/resource/plugins/pi-bridge/capabilities",
			"/v0/resource/plugins/pi-bridge/usage",
			"/v0/resource/plugins/pi-bridge/dev/usage",
			"/api/usage",
		],
	);
	assert.equal(calls[3]?.headers.get("x-plugin-key"), "legacy-key");
	assert.equal(calls[3]?.headers.has("authorization"), false);
	assert.equal(lastUsageSource(), "sidecar");
	assert.equal(lastUsageContract(), 1);

	console.log("bridge contract check: ok");
} finally {
	globalThis.fetch = originalFetch;
	process.env.HOME = originalHome;
	rmSync(home, { recursive: true, force: true });
}
