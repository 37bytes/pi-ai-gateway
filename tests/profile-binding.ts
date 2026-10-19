// Regression test for the per-session environment binding and the generation
// gate, against the stateless runtime model.
//
// Three things must hold once two AGP environments (prod/test) can be live in
// separate sessions and processes:
//
//   * a session resolves to exactly one environment — persisted binding, else
//     prod for a pre-profile session, else the environment it inherited from
//     its parent's registry, else the runtime root — and that binding is fixed
//     once made; the plugin reads `AGP_PROFILE`, never writes it;
//   * a late refresh that started on one environment can never register
//     providers into the environment selected afterwards — the generation gate
//     rejects it;
//   * model roles and the generated overlay are rewritten only for namespaces
//     this environment actually serves, so direct providers stay verbatim and
//     no key material can leak into the overlay.

import assert from "node:assert/strict";
import { readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Api } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ProxyConfig } from "../src/config.ts";
import type { Discovery, DiscoveryCustomEntry } from "../src/fetch-models.ts";
import type { ProfileSeed } from "../src/profile-context.ts";

const home = process.env.PI_GATEWAY_TEST_HOME!;
assert.ok(home && process.env.HOME === home, "Run through scripts/run-isolated.ts");
const originalHome = process.env.HOME;
const originalProfileEnv = process.env.AGP_PROFILE;
process.env.HOME = home;

// Dynamic imports: home/config paths are computed at module evaluation, so HOME
// must be isolated before the production modules load (same pattern as the
// other contract tests).
const { profilePaths, PROFILES_DIR, FILE_MODE } = await import("../src/profiles.ts");
const { saveConfig } = await import("../src/config.ts");
const { writeDiscoveryCache } = await import("../src/cache.ts");
const { cacheScope } = await import("../src/cache-scope.ts");
const { PREFERRED_CONTRACT } = await import("../src/fetch-usage.ts");
const {
	PROFILE_FLAG,
	PROFILE_ENTRY_TYPE,
	launchDecision,
	defaultSeed,
	persistedProfile,
	sessionHasHistory,
	profileFromRegisteredNames,
	pickProfileForSession,
	originOf,
	describeProfile,
} = await import("../src/profile-context.ts");
const { ROOT_SESSION_KEY, PROFILE_STATUS_KEY, createSessionRuntime } = await import(
	"../src/session-runtime.ts"
);
const { buildProfileCatalog } = await import("../src/apply.ts");
const { remapRoles, remapSpawnPatterns, catalogHas } = await import("../src/role-map.ts");
const { profileOverlayYaml, writeProfileOverlay } = await import("../src/profile-overlay.ts");

const PROD_ENDPOINT = "https://prod.test/v1";
const TEST_ENDPOINT = "https://test.test/v1";
const API_KEY = "k";
const ROOT_PROD: ProfileSeed = { id: "prod", source: "launch-env" };
const ROOT_TEST: ProfileSeed = { id: "test", source: "launch-flag" };

function makeCfg(endpoint: string): ProxyConfig {
	return {
		proxy: { endpoint, apiKey: API_KEY },
		builtinProviders: {},
		customProviders: {},
		registerAll: true,
		discoveryExcludes: [],
		overrides: {},
		refreshIntervalMinutes: 0,
		usageCacheTtlMs: 15_000,
	};
}

function customEntry(
	id: string,
	suggestedProvider: string,
	api: Api = "openai-completions",
): DiscoveryCustomEntry {
	const selectorId = id.slice(id.indexOf("/") + 1);
	return {
		id,
		wireId: id,
		selectorId,
		providerId: "connector-1",
		providerKind: suggestedProvider,
		canonicalModel: `upstream/${selectorId}`,
		name: id,
		api,
		suggestedProvider,
		ownedBy: suggestedProvider,
		metadataState: "catalog",
		priceState: "known",
		reasoning: true,
		input: ["text"],
		contextWindow: 128_000,
		maxTokens: 16_000,
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
	};
}

function discoveryOf(entries: DiscoveryCustomEntry[]): Discovery {
	return {
		source: "well-known",
		upstreamVersion: "fixture",
		builtinProviders: [],
		customPool: entries,
		serverDiscoveryExcludes: [],
		upstreamTotal: entries.length,
	};
}

/** Host mock: the provider-registry methods applyAll drives plus what the harness observes. */
interface PiMock {
	registered: string[];
	unregistered: string[];
	registerProvider(name: string): void;
	unregisterProvider(name: string): void;
	appendEntry(type: string, data: unknown): void;
	getFlag(name: string): string | boolean | undefined;
}

function makePi(): PiMock {
	const registered: string[] = [];
	const unregistered: string[] = [];
	return {
		registered,
		unregistered,
		registerProvider(name: string) {
			registered.push(name);
		},
		unregisterProvider(name: string) {
			unregistered.push(name);
		},
		appendEntry() {},
		getFlag() {
			return undefined;
		},
	};
}

/** Session context mock exposing just what the runtime reads. */
interface CtxMock {
	hasUI: boolean;
	sessionManager: { getSessionId(): string; getEntries(): Array<{ type: string }> };
	models: { list(): Array<{ provider: string }> };
	isIdle(): boolean;
}

function makeCtx(opts: {
	sessionId: string;
	entries?: Array<{ type: string; customType?: string; data?: unknown }>;
	providers?: string[];
}): CtxMock {
	return {
		hasUI: false,
		sessionManager: {
			getSessionId: () => opts.sessionId,
			getEntries: () => (opts.entries ?? []) as Array<{ type: string }>,
		},
		models: { list: () => (opts.providers ?? []).map((provider) => ({ provider })) },
		isIdle: () => true,
	};
}

const asCtx = (ctx: CtxMock): ExtensionContext => ctx as unknown as ExtensionContext;
const asCommandCtx = (ctx: CtxMock): ExtensionCommandContext =>
	ctx as unknown as ExtensionCommandContext;
const asPi = (pi: PiMock): ExtensionAPI => pi as unknown as ExtensionAPI;

try {
	// ------------------------------------------------------------------ fixtures
	// One config per environment on disk, plus each environment's own discovery
	// cache recorded under that environment's own scope.
	saveConfig("prod", makeCfg(PROD_ENDPOINT));
	saveConfig("test", makeCfg(TEST_ENDPOINT));
	const prodPaths = profilePaths("prod");
	const testPaths = profilePaths("test");
	const prodScope = cacheScope(PROD_ENDPOINT, API_KEY, PREFERRED_CONTRACT);
	const testScope = cacheScope(TEST_ENDPOINT, API_KEY, PREFERRED_CONTRACT);
	writeDiscoveryCache(prodPaths, discoveryOf([customEntry("codex/gpt-5.6-luna", "codex")]), prodScope);
	writeDiscoveryCache(testPaths, discoveryOf([customEntry("codex/gpt-5.6-terra", "codex")]), testScope);

	// A launch selection is a seed: AGP_PROFILE is read, never treated as state.
	process.env.AGP_PROFILE = "test";
	const envSentinel = process.env.AGP_PROFILE;

	// ------------------------------------------------- 1. resolution inputs
	assert.deepEqual(launchDecision(() => undefined), {
		seed: { id: "test", source: "launch-env" },
		problem: null,
	});
	assert.deepEqual(launchDecision((name) => (name === PROFILE_FLAG ? "prod" : undefined)), {
		seed: { id: "prod", source: "launch-flag" },
		problem: null,
	});
	assert.deepEqual(defaultSeed(), { id: "prod", source: "default" });

	const persisted = [
		{
			type: "custom",
			customType: PROFILE_ENTRY_TYPE,
			data: { profile: "test", boundAt: "2026-10-19T00:00:00.000Z" },
		},
	];
	assert.deepEqual(persistedProfile(persisted), { id: "test", problem: null });
	assert.deepEqual(persistedProfile([{ type: "message" }]), { id: null, problem: null });
	assert.deepEqual(
		persistedProfile([{ type: "custom", customType: "other", data: { profile: "test" } }]),
		{ id: null, problem: null },
	);
	assert.equal(
		persistedProfile([
			{ type: "custom", customType: PROFILE_ENTRY_TYPE, data: { profile: "retired" } },
		]).problem?.requested,
		"retired",
		"a persisted environment this machine no longer has is reported, not dropped",
	);
	assert.equal(sessionHasHistory([{ type: "message" }]), true);
	assert.equal(sessionHasHistory([{ type: "custom" }]), false);

	// Legacy prefixed names still identify their environment; plain names do not.
	assert.equal(profileFromRegisteredNames(["agp-prod-codex"], ["prod", "test"]), "prod");
	assert.equal(profileFromRegisteredNames(["agp-test-openai", "other"], ["prod", "test"]), "test");
	assert.equal(profileFromRegisteredNames(["codex"], ["prod", "test"]), null);
	assert.equal(
		profileFromRegisteredNames(["agp-prod-codex", "agp-test-codex"], ["prod", "test"]),
		null,
		"two environments in one registry must never silently pick one",
	);

	// Resolution order (main session): persisted > history > model > registry > root.
	// A subagent must never guess: without a naming model or a single-environment
	// registry it fails closed instead of taking the launch seed.
	const resolution = (extra) => ({
		persisted: { id: null, problem: null },
		hasHistory: false,
		modelOrigin: null,
		registryOrigin: null,
		isChild: false,
		root: ROOT_PROD,
		rootProblem: null,
		...extra,
	});
	assert.deepEqual(
		pickProfileForSession(resolution({ persisted: { id: "test", problem: null } })),
		{ seed: { id: "test", source: "session" }, problem: null },
	);
	assert.deepEqual(
		pickProfileForSession(resolution({ hasHistory: true, modelOrigin: "test" })),
		{ seed: { id: "prod", source: "legacy" }, problem: null },
		"a pre-profile session stays on prod even when its model names another environment",
	);
	assert.deepEqual(
		pickProfileForSession(resolution({ modelOrigin: "test", registryOrigin: "prod" })),
		{ seed: { id: "test", source: "inherited" }, problem: null },
		"a session's own model outranks the registry hint",
	);
	assert.deepEqual(
		pickProfileForSession(resolution({ registryOrigin: "test" })),
		{ seed: { id: "test", source: "inherited" }, problem: null },
	);
	assert.deepEqual(
		pickProfileForSession(resolution({ root: ROOT_TEST })),
		{ seed: ROOT_TEST, problem: null },
	);
	assert.deepEqual(
		pickProfileForSession(resolution({ root: ROOT_TEST, rootProblem: { requested: "ghost", reason: "missing" } })),
		{ seed: ROOT_TEST, problem: null },
		"a usable seed wins over a launch problem that no longer applies",
	);
	const childProblem = pickProfileForSession(
		resolution({ isChild: true, root: ROOT_TEST, rootProblem: { requested: "ghost", reason: "missing" } }),
	);
	assert.equal(childProblem.seed, null, "a subagent never falls back to the launch seed");
	assert.equal(childProblem.problem?.requested, "subagent");

	// ------------------------------------- 2. immutability + inherited via ctx
	assert.equal(ROOT_SESSION_KEY, "root");
	assert.equal(PROFILE_STATUS_KEY, "0agp");

	const inheritedPi = makePi();
	const inheritedRuntime = createSessionRuntime(asPi(inheritedPi), { root: ROOT_TEST });
	const envBeforeBind = process.env.AGP_PROFILE;
	const inherited = await inheritedRuntime.bindSession(
		asCtx(makeCtx({ sessionId: "inherited-1", providers: ["codex"] })),
	);
	assert.equal(inherited.changed, true);
	assert.equal(inherited.snapshot.id, "test", "plain provider names identify no environment");
	assert.equal(inherited.snapshot.source, "launch-flag");
	assert.equal(process.env.AGP_PROFILE, envBeforeBind, "bindSession must never write AGP_PROFILE");

	const piA = makePi();
	const runtime = createSessionRuntime(asPi(piA), { root: ROOT_PROD });
	const ctxA = makeCtx({ sessionId: "a" });
	const first = await runtime.bindSession(asCtx(ctxA));
	assert.equal(first.changed, true);
	assert.equal(first.snapshot.id, "prod");
	const second = await runtime.bindSession(asCtx(ctxA));
	assert.equal(second.changed, false, "a second bind must be a no-op");
	assert.equal(
		second.snapshot.generation,
		first.snapshot.generation,
		"a re-bind must not bump the generation",
	);
	assert.equal(runtime.bindingFor("a")?.id, "prod");
	assert.equal(process.env.AGP_PROFILE, envBeforeBind, "bindSession must never write AGP_PROFILE");

	// ------------------------------------------------- 3. generation gate
	const gatePi = makePi();
	const gateRuntime = createSessionRuntime(asPi(gatePi), { root: ROOT_PROD });
	const ctx = makeCtx({ sessionId: "s1" });
	const bound = await gateRuntime.bindSession(asCtx(ctx));
	assert.equal(bound.snapshot.id, "prod");
	assert.ok(gatePi.registered.includes("codex"));
	const stale = gateRuntime.snapshotFor(asCtx(ctx));
	assert.equal(stale.discoveryScope, prodScope);

	const registeredBefore = gatePi.registered.length;
	const envBeforeSwitch = process.env.AGP_PROFILE;
	const switched = await gateRuntime.switchEnvironment(asCommandCtx(ctx), "test");
	assert.equal(switched.ok, true, switched.message);
	assert.equal(process.env.AGP_PROFILE, envBeforeSwitch, "switchEnvironment must never write AGP_PROFILE");
	assert.equal(gateRuntime.isCurrent(stale), false, "the left environment's snapshot is stale");
	const now = gateRuntime.snapshotFor(asCtx(ctx));
	assert.equal(now.id, "test");
	assert.equal(now.discoveryScope, testScope);
	assert.equal(gateRuntime.isCurrent(now), true);
	const registeredDuringSwitch = gatePi.registered.slice(registeredBefore);
	assert.ok(registeredDuringSwitch.includes("codex"), "the switch must register the same plain namespace");
	assert.ok(gatePi.registered.includes("codex"), "the target environment keeps the plain provider names");

	// --------------------------------------------- 4. role mapping + overlay
	const catalogCfg = makeCfg(TEST_ENDPOINT);
	const catalogDiscovery = discoveryOf([
		customEntry("codex/gpt-5.6-terra", "codex"),
		customEntry("codex/gpt-6-astra", "codex"),
		customEntry("opencode/deepseek-v4.1-flash", "opencode"),
	]);
	const catalog = buildProfileCatalog(catalogCfg, catalogDiscovery, "test", ["prod", "test"]);
	assert.equal(catalog.profile, "test");
	assert.ok(catalogHas(catalog, "codex", "gpt-5.6-terra"));
	assert.ok(catalogHas(catalog, "codex", "gpt-6-astra"));
	assert.ok(catalogHas(catalog, "opencode", "deepseek-v4.1-flash"));

	const roles = {
		default: "cpa-codex/gpt-6-astra:max",
		slow: "codex/gpt-5.6-terra",
		task: "opencode/deepseek-v4.1-flash",
		vision: "ds-local/deepseek-v4-pro",
	};
	const remap = remapRoles(roles, ["prod", "test"], catalog);
	assert.deepEqual(remap.mapped, {}, "plain selectors already name this environment and need no rewrite");
	assert.ok(!("default" in remap.mapped), "direct cpa-codex role must stay untouched");
	assert.ok(!("vision" in remap.mapped), "direct ds-local role must stay untouched");

	// An effort suffix is carried through verbatim when the role does belong to
	// this environment.
	const withEffort = remapRoles({ ...roles, research: "codex/gpt-6-astra:max" }, ["prod", "test"], catalog);
	assert.deepEqual(withEffort.mapped, {}, "a plain selector is already the target selector");

	// A model the environment does not serve is reported, never invented.
	const unresolved = remapRoles({ slow: "codex/gpt-5.6-luna" }, ["prod", "test"], catalog);
	assert.deepEqual(unresolved.mapped, {});
	assert.deepEqual(unresolved.unresolved, ["slow=codex/gpt-5.6-luna"]);

	assert.deepEqual(
		remapSpawnPatterns(["codex/gpt-5.6-terra", "ds-local/deepseek-v4-pro"], ["prod", "test"], catalog),
		{ patterns: ["codex/gpt-5.6-terra", "ds-local/deepseek-v4-pro"], changed: false },
	);
	assert.deepEqual(remapSpawnPatterns(["ds-local/deepseek-v4-pro"], ["prod", "test"], catalog), {
		patterns: ["ds-local/deepseek-v4-pro"],
		changed: false,
	});

	// Overlay: valid-looking YAML with the mapped role/agent keys and no secrets.
	const yaml = profileOverlayYaml(
		{ slow: "codex/gpt-5.6-terra" },
		{ explore: "opencode/deepseek-v4.1-flash" },
	);
	assert.match(yaml, /^modelRoles:$/m);
	assert.match(yaml, /^\s+"slow": "codex\/gpt-5\.6-terra"$/m);
	assert.match(yaml, /^task:$/m);
	assert.match(yaml, /^\s+agentModelOverrides:$/m);
	assert.match(yaml, /^\s+"explore": "opencode\/deepseek-v4\.1-flash"$/m);
	assert.doesNotMatch(yaml, /apiKey|Bearer|sk-/i);

	// writeProfileOverlay: 0600 at the profile's own path; empty maps are a no-op.
	const overlayPaths = profilePaths("test");
	assert.equal(
		writeProfileOverlay(
			overlayPaths,
			{ slow: "codex/gpt-5.6-terra" },
			{ explore: "opencode/deepseek-v4.1-flash" },
		),
		true,
	);
	assert.equal(statSync(overlayPaths.overlayPath).mode & 0o777, FILE_MODE);
	assert.match(readFileSync(overlayPaths.overlayPath, "utf8"), /modelRoles:/);
	const overlayBefore = readFileSync(overlayPaths.overlayPath, "utf8");
	assert.equal(writeProfileOverlay(overlayPaths, {}, {}), false);
	assert.equal(
		readFileSync(overlayPaths.overlayPath, "utf8"),
		overlayBefore,
		"empty maps must not rewrite the overlay",
	);

	// Identity helpers: paths stay under profiles/<id> and the label is derived.
	assert.equal(now.paths.dir, join(PROFILES_DIR, "test"));
	assert.equal(originOf(TEST_ENDPOINT), "https://test.test");
	assert.equal(describeProfile(now), "TEST \u00b7 https://test.test");
	assert.equal(process.env.AGP_PROFILE, envSentinel, "the plugin must leave AGP_PROFILE as it found it");

	console.log("ok profile-binding: resolution, gate, role-mapping, overlay");
} finally {
	if (originalProfileEnv === undefined) delete process.env.AGP_PROFILE;
	else process.env.AGP_PROFILE = originalProfileEnv;
	process.env.HOME = originalHome;
	rmSync(home, { recursive: true, force: true });
}
