// An environment the user explicitly asked for (or that a session file was
// bound to) must never degrade into a different environment. A typo in
// `AGP_PROFILE`/a session bound to an environment this machine no
// longer has, has to stop before any discovery fetch or provider registration —
// not quietly run the session on prod.
//
// Run through scripts/run-isolated.ts (fresh HOME).

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";

const home = process.env.HOME ?? "";
assert.ok(home.includes("agp-contract-"), "Run through scripts/run-isolated.ts");

const { profilePaths } = await import("../src/profiles.ts");
const { ensureProfileLayout } = await import("../src/profiles-migration.ts");
const { saveConfig } = await import("../src/config.ts");
const { writeDiscoveryCache } = await import("../src/cache.ts");
const { cacheScope } = await import("../src/cache-scope.ts");
const { PREFERRED_CONTRACT } = await import("../src/fetch-usage.ts");
const { launchDecision, PROFILE_ENTRY_TYPE, PROFILE_ENV } = await import("../src/profile-context.ts");
const { createSessionRuntime } = await import("../src/session-runtime.ts");
const { buildSnapshot } = await import("../src/profile-context.ts");

const ENDPOINT = "https://prod.test/v1";
const API_KEY = "prod-key";
const originalProfileEnv = process.env[PROFILE_ENV];

ensureProfileLayout();
saveConfig("prod", {
	proxy: { endpoint: ENDPOINT, apiKey: API_KEY },
	builtinProviders: {},
	customProviders: {},
	registerAll: true,
	discoveryExcludes: [],
	overrides: {},
	refreshIntervalMinutes: 0,
	usageCacheTtlMs: 15_000,
});
const model = { id: "codex/gpt-5.6-terra", provider: "codex", api: "openai-responses" };
const discoveryFixture = {
		source: "well-known",
		upstreamVersion: "fixture",
		builtinProviders: [],
		customPool: [
			{
				...model,
				wireId: model.id,
				selectorId: "gpt-5.6-terra",
				providerId: "8fc22fba-0000-4000-8000-000000000000",
				providerKind: "codex",
				canonicalModel: "gpt-5.6-terra",
				name: "codex \u00b7 gpt-5.6-terra",
				suggestedProvider: "codex",
				ownedBy: "codex",
				metadataState: "catalog",
				priceState: "unknown",
			},
		],
	serverDiscoveryExcludes: [],
	upstreamTotal: 1,
};
writeDiscoveryCache(profilePaths("prod"), discoveryFixture, cacheScope(ENDPOINT, API_KEY, PREFERRED_CONTRACT));

/** pi mock counting registrations; the load-time apply is what must not happen. */
function makePi() {
	const registered = [];
	return {
		registered,
		pi: {
			getFlag: () => undefined,
			on() {},
			registerFlag() {},
			registerCommand() {},
			registerProvider(name) {
				registered.push(name);
			},
			unregisterProvider() {},
			appendEntry() {},
			pi: { settings: {} },
		},
	};
}

function freshCtx(sessionId, entries = []) {
	return {
		ui: { notify() {}, setStatus() {} },
		mode: "tui",
		hasUI: true,
		hasPendingMessages: () => false,
		isIdle: () => true,
		cwd: process.cwd(),
		sessionManager: { getSessionId: () => sessionId, getEntries: () => [...entries] },
		models: { list: () => [], current: () => undefined, resolve: () => undefined, family: () => "" },
	};
}

// ------------------------------------------------------ launch decision
{
	delete process.env[PROFILE_ENV];
	assert.deepEqual(
		launchDecision(() => undefined),
		{ seed: null, problem: null },
		"nothing requested leaves the registry default in play",
	);

	process.env[PROFILE_ENV] = "prod";
	assert.deepEqual(
		launchDecision(() => undefined),
		{ seed: { id: "prod", source: "launch-env" }, problem: null },
		"a configured environment is seeded",
	);

	process.env[PROFILE_ENV] = "ghost";
	const fromEnv = launchDecision(() => undefined);
	assert.equal(fromEnv.seed, null, "an unknown environment is never a seed");
	assert.equal(fromEnv.problem?.requested, "ghost");
	assert.match(fromEnv.problem?.reason ?? "", /not configured/);

	// An explicit flag is not rescued by a valid environment variable: the
	// request that was made is the request that must be honoured, or refused.
	// ("ghost-test" is absent from the registry; the default registry only ships
	// prod and test descriptors, so "test" would be a configured environment.)
	process.env[PROFILE_ENV] = "prod";
	const fromFlag = launchDecision(() => "ghost-test");
	assert.equal(fromFlag.seed, null, "a bad --agp-profile does not fall back to AGP_PROFILE");
	assert.equal(fromFlag.problem?.requested, "ghost-test");
	// ...while a configured flag still wins over the environment.
	assert.deepEqual(launchDecision(() => "test"), {
		seed: { id: "test", source: "launch-flag" },
		problem: null,
	});

	if (originalProfileEnv === undefined) delete process.env[PROFILE_ENV];
	else process.env[PROFILE_ENV] = originalProfileEnv;
}

// ------------------------------------- explicit request for a missing env
{
	delete process.env[PROFILE_ENV];
	const { pi, registered } = makePi();
	const fetchCalls = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input) => {
		fetchCalls.push(String(input));
		throw new Error("no environment may be reached");
	};
	try {
		const runtime = createSessionRuntime(pi, {
			launch: {
				seed: null,
				problem: { requested: "test", reason: 'environment "test" is not configured on this machine' },
			},
		});
		assert.equal(runtime.root, null, "a failed launch request has no root seed");
		assert.equal(runtime.rootProblem?.requested, "test");

		const result = await runtime.bindSession(freshCtx("explicit-missing"), { allowNetwork: true });
		assert.ok(result.blocked, "the session reports the problem instead of binding another environment");
		assert.equal(result.snapshot, null, "an unusable environment has no credential-bearing snapshot");
		assert.equal(result.blocked.requested, "test", "the problem reports the requested environment, not prod");
		assert.deepEqual(registered, [], "no provider may be registered for a missing environment");
		assert.deepEqual(fetchCalls, [], "no discovery may be fetched for a missing environment");
	} finally {
		globalThis.fetch = originalFetch;
	}
}

// ------------------------------------------- persisted binding that is gone
{
	delete process.env[PROFILE_ENV];
	const { pi, registered } = makePi();
	const fetchCalls = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input) => {
		fetchCalls.push(String(input));
		throw new Error("no environment may be reached");
	};
	try {
		const runtime = createSessionRuntime(pi, { root: { id: "prod", source: "launch-env" } });
		const entries = [
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
			{ type: "custom", customType: PROFILE_ENTRY_TYPE, data: { profile: "retired" } },
		];
		const result = await runtime.bindSession(freshCtx("persisted-missing", entries), {
			allowNetwork: true,
		});
		assert.ok(result.blocked, "a session bound to a retired environment does not fall back");
		assert.equal(result.blocked?.requested, "retired");
		assert.equal(result.snapshot, null, "and no config is resolved for it");
		assert.deepEqual(registered, [], "prod is not registered in its place");
		assert.deepEqual(fetchCalls, []);
	} finally {
		globalThis.fetch = originalFetch;
	}
}

// ----------------------------- a subagent with no determinable origin
{
	delete process.env[PROFILE_ENV];
	// Two environments live in one process (an older session runs on prod while
	// a newer one is on test). Their names cannot say which one a new child came
	// from, and its model names a direct provider, so the child must not start at
	// all rather than inherit whichever environment happens to be the seed.
	saveConfig("test", {
		proxy: { endpoint: "https://test.test/v1", apiKey: "test-key" },
		builtinProviders: {},
		customProviders: {},
		registerAll: true,
		discoveryExcludes: [],
		overrides: {},
		refreshIntervalMinutes: 0,
		usageCacheTtlMs: 15_000,
	});
	writeDiscoveryCache(
		profilePaths("test"),
		{ ...discoveryFixture, customPool: [] },
		cacheScope("https://test.test/v1", "test-key", PREFERRED_CONTRACT),
	);

	const { pi, registered } = makePi();
	const fetchCalls = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input) => {
		fetchCalls.push(String(input));
		throw new Error("no environment may be reached");
	};
	try {
		const runtime = createSessionRuntime(pi, { root: { id: "prod", source: "launch-env" } });
		const prodSnap = runtime.rootSnapshot();
		runtime.registerDiscovery(prodSnap, discoveryFixture);
		await runtime.applySnapshot(prodSnap, discoveryFixture);
		const testSnap = buildSnapshot({ id: "test", source: "switch" }, "test-root", 0);
		runtime.registerDiscovery(testSnap, { ...discoveryFixture, customPool: [] });
		registered.length = 0;
		fetchCalls.length = 0;

		const childCtx = freshCtx("ambiguous-child");
		childCtx.agent = { kind: "sub" };
		childCtx.models = {
			list: () => [],
			current: () => ({ provider: "ds-local", id: "deepseek-v4-pro" }),
			resolve: () => undefined,
			family: () => "",
		};
		const result = await runtime.bindSession(childCtx, { allowNetwork: true });
		assert.ok(result.blocked, "an undeterminable subagent environment fails closed");
		assert.equal(result.blocked?.requested, "subagent");
		assert.equal(result.snapshot, null, "and no config is resolved for a guessed environment");
		assert.deepEqual(registered, [], "nothing may be registered for a guessed subagent environment");
		assert.deepEqual(fetchCalls, [], "and nothing may be fetched");
	} finally {
		globalThis.fetch = originalFetch;
	}
}

// --------------------------------------------------- control: prod works
{
	delete process.env[PROFILE_ENV];
	const { pi, registered } = makePi();
	const runtime = createSessionRuntime(pi, { root: { id: "prod", source: "launch-env" } });
	const result = await runtime.bindSession(freshCtx("ordinary-session"), { allowNetwork: false });
	assert.equal(result.blocked, null, "an ordinary session binds normally");
	assert.equal(result.snapshot.id, "prod");
	assert.ok(runtime.isCurrent(result.snapshot), "and its binding is live");
	assert.deepEqual(
		registered,
		["agp-prod-codex"],
		"the environment's providers come from its own cache",
	);
}

if (originalProfileEnv === undefined) delete process.env[PROFILE_ENV];
else process.env[PROFILE_ENV] = originalProfileEnv;
rmSync(join(home, ".pi"), { recursive: true, force: true });
console.log("ok fail-closed: launch problem, persisted problem, control");
