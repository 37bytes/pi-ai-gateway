// Children run on the environment their own session resolves — never on a
// process-global selection.
//
// The runtime keeps no module-level selection: a profile is resolved once per
// session from that session's own inputs (persisted binding > history > the
// session's current model > an inherited registry that names exactly one
// environment > the launch seed). This test pins the transports that make
// child inheritance real:
//
//   1. a subagent's own current model names the environment it was spawned on,
//      even when the launch seed says otherwise;
//   2. when neither the model nor an unambiguous registry can name it, a child
//      FAILS CLOSED instead of starting on a guessed environment;
//   3. the runtime role override that in-process children share, verified by
//      reading the host's effective value back;
//   4. the before-subagent-spawn pattern rewrite, resolved per session.
//
// Runs against a temp HOME through scripts/run-isolated.ts.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ProxyConfig } from "../src/config.ts";
import type { Discovery, DiscoveryCustomEntry } from "../src/fetch-models.ts";

const home = process.env.PI_GATEWAY_TEST_HOME!;
assert.ok(home && process.env.HOME === home, "Run through scripts/run-isolated.ts");
const originalHome = process.env.HOME;
const originalProfileEnv = process.env.AGP_PROFILE;
const originalFetch = globalThis.fetch;

process.env.HOME = home;

/** The runtime must never write this: inheritance is observed, not exported. */
const PROFILE_SENTINEL = "prod";
process.env.AGP_PROFILE = PROFILE_SENTINEL;

/** Any outbound request in this test is a failure, not a fallback. */
let fetches = 0;
globalThis.fetch = (async () => {
	fetches++;
	throw new Error("no network in this test");
}) as typeof fetch;

interface FakePi {
	registerProvider(name: string, config: unknown): void;
	unregisterProvider(name: string): void;
	registerCommand(...args: unknown[]): void;
	registerFlag(...args: unknown[]): void;
	getFlag(_name: string): string | boolean | undefined;
	on(...args: unknown[]): void;
	appendEntry(...args: unknown[]): void;
	pi: { settings?: unknown };
}

/** Minimal host: only the calls the tested paths make are implemented. */
function createPi(settings?: unknown): {
	pi: ExtensionAPI;
	registered: string[];
	unregistered: string[];
	appended: unknown[][];
} {
	const registered: string[] = [];
	const unregistered: string[] = [];
	const appended: unknown[][] = [];
	const fake: FakePi = {
		registerProvider(name) {
			registered.push(name);
		},
		unregisterProvider(name) {
			unregistered.push(name);
		},
		registerCommand() {},
		registerFlag() {},
		getFlag() {
			return undefined;
		},
		on() {},
		appendEntry(...args) {
			appended.push(args);
		},
		pi: settings === undefined ? {} : { settings },
	};
	return { pi: fake as unknown as ExtensionAPI, registered, unregistered, appended };
}

interface CtxOptions {
	entries?: unknown[];
	/** Every provider name the session's registry holds. */
	providers?: string[];
	/** The session's own current model, as the host would report it. */
	current?: { provider: string; id?: string };
	/** "sub" for a subagent session, "main" for a top-level one. */
	agent?: "main" | "sub";
}

/** Session context mock: only the fields the tested paths read. */
function createCtx(sessionId: string, options: CtxOptions = {}): ExtensionContext {
	const entries = options.entries ?? [];
	const providers = options.providers ?? [];
	const ctx = {
		sessionManager: {
			getSessionId: () => sessionId,
			getEntries: () => entries,
		},
		models: {
			list: () => providers.map((provider) => ({ provider })),
			current: () => options.current,
		},
		model: undefined,
		agent: options.agent ? { kind: options.agent } : undefined,
		hasUI: false,
		isIdle: () => true,
		ui: {
			setStatus: () => {},
			notify: () => {},
		},
	};
	return ctx as unknown as ExtensionContext;
}

const testConfig: ProxyConfig = {
	proxy: { endpoint: "https://test.test/v1", apiKey: "test-key" },
	builtinProviders: {},
	customProviders: {},
	registerAll: true,
	discoveryExcludes: [],
	overrides: {},
	refreshIntervalMinutes: 0,
	usageCacheTtlMs: 15_000,
};

const prodConfig: ProxyConfig = {
	proxy: { endpoint: "https://prod.test/v1", apiKey: "prod-key" },
	builtinProviders: {},
	customProviders: {},
	registerAll: true,
	discoveryExcludes: [],
	overrides: {},
	refreshIntervalMinutes: 0,
	usageCacheTtlMs: 15_000,
};

const discovery: Discovery = {
	source: "well-known",
	upstreamVersion: "fixture",
	builtinProviders: [],
	customPool: [
		...["gpt-5.6-terra", "gpt-6-astra"].map(
			(model): DiscoveryCustomEntry => ({
				id: `codex/${model}`,
				wireId: `codex/${model}`,
				selectorId: model,
				providerId: "connector-codex",
				providerKind: "codex",
				canonicalModel: `openai/${model}`,
				name: model,
				api: "openai-responses",
				suggestedProvider: "codex",
				ownedBy: "codex",
				metadataState: "catalog",
				priceState: "known",
			}),
		),
		{
			// No provider id: this is a local group, not a gateway connector.
			id: "glm-4.7",
			wireId: "glm-4.7",
			selectorId: "glm-4.7",
			canonicalModel: "z-ai/glm-4.7",
			name: "GLM 4.7",
			api: "openai-completions",
			suggestedProvider: "local-glm",
			ownedBy: "local-glm",
			metadataState: "catalog",
			priceState: "known",
		},
	],
	serverDiscoveryExcludes: [],
	upstreamTotal: 3,
};

try {
	// Dynamic import after HOME isolation: config/profiles bind their paths at
	// module evaluation, so a static import would bind the real user's HOME.
	const { saveConfig } = await import("../src/config.ts");
	const { ensureProfileLayout } = await import("../src/profiles-migration.ts");
	const { profilePaths } = await import("../src/profiles.ts");
	const { PROFILE_ENTRY_TYPE, PROFILE_ENV } = await import("../src/profile-context.ts");
	const { createSessionRuntime } = await import("../src/session-runtime.ts");

	ensureProfileLayout();
	saveConfig("prod", prodConfig);
	saveConfig("test", testConfig);
	assert.ok(existsSync(profilePaths("prod").configPath), "prod config must exist before bindSession");
	assert.ok(existsSync(profilePaths("test").configPath), "test config must exist before bindSession");

	const host = createPi();
	const runtime = createSessionRuntime(host.pi, {
		root: { id: "prod", source: "launch-env" },
	});
	assert.deepEqual(runtime.root, { id: "prod", source: "launch-env" });

	// 1a. A subagent's OWN model names its environment: the launch seed says
	// prod and the registry still holds prod, but the model says test — the
	// child binds to test with source "inherited".
	const byModel = createCtx("child-by-model", {
		agent: "sub",
		providers: ["agp-prod-codex"],
		current: { provider: "agp-test-codex" },
	});
	const byModelResult = await runtime.bindSession(byModel, { allowNetwork: false });
	assert.equal(byModelResult.changed, true);
	assert.equal(byModelResult.legacy, false);
	assert.equal(byModelResult.blocked, null);
	assert.equal(byModelResult.snapshot.id, "test");
	assert.deepEqual(
		{ id: runtime.snapshotFor(byModel).id, source: runtime.snapshotFor(byModel).source },
		{ id: "test", source: "inherited" },
	);
	assert.equal(host.appended[0]?.[0], PROFILE_ENTRY_TYPE);
	const bindingEntry = host.appended[0]?.[1];
	if (!bindingEntry || typeof bindingEntry !== "object" || !("profile" in bindingEntry)) {
		throw new Error("the inherited session binding was not persisted");
	}
	assert.equal(bindingEntry.profile, "test");

	// Serve this session's environment so the catalogue and names exist.
	runtime.registerDiscovery(byModelResult.snapshot, discovery);
	await runtime.applySnapshot(byModelResult.snapshot, discovery);
	assert.equal(runtime.knownProfiles().join(","), "test");

	// 1b. The model names nothing, but the registry names exactly one
	// environment: the child inherits from the registry, same result.
	const byRegistry = createCtx("child-by-registry", {
		agent: "sub",
		providers: ["agp-test-codex"],
	});
	const byRegistryResult = await runtime.bindSession(byRegistry, { allowNetwork: false });
	assert.equal(byRegistryResult.blocked, null);
	assert.equal(byRegistryResult.snapshot.id, "test");
	assert.equal(byRegistryResult.snapshot.source, "inherited");

	// 2. Two environments live in one process make the registry ambiguous: a
	// subagent whose model names no environment must fail closed — nothing is
	// registered and nothing is fetched, so it never starts on a guess.
	const prodSnapshot = runtime.rootSnapshot();
	runtime.registerDiscovery(prodSnapshot, discovery);
	await runtime.applySnapshot(prodSnapshot, discovery);
	assert.deepEqual(runtime.knownProfiles().sort(), ["prod", "test"]);

	const ambiguous = createCtx("child-ambiguous", {
		agent: "sub",
		providers: ["agp-prod-codex", "agp-test-codex"],
		current: { provider: "ds-local", id: "deepseek-v4-pro" },
	});
	const registeredBefore = host.registered.length;
	const ambiguousResult = await runtime.bindSession(ambiguous, { allowNetwork: false });
	const blocked = ambiguousResult.blocked;
	assert.ok(blocked, "a subagent that cannot name its environment must be blocked");
	assert.equal(blocked.requested, "subagent");
	assert.match(blocked.reason, /guessed environment/);
	assert.equal(ambiguousResult.changed, false);
	assert.equal(ambiguousResult.snapshot, null, "a blocked child resolves no config");
	assert.equal(runtime.bindingFor("child-ambiguous"), undefined);
	assert.equal(host.registered.length, registeredBefore, "a blocked child registers nothing");
	assert.equal(fetches, 0, "a blocked child fetches nothing");

	// 3. A top-level session after a switch: its own model outranks the launch
	// seed, so a new conversation binds to the environment it is actually on.
	const mainPrecedence = createCtx("main-precedence", {
		agent: "main",
		current: { provider: "agp-test-codex" },
	});
	const mainResult = await runtime.bindSession(mainPrecedence, { allowNetwork: false });
	assert.equal(mainResult.blocked, null);
	assert.equal(mainResult.snapshot.id, "test");
	assert.equal(mainResult.snapshot.source, "inherited");

	// 4. A persisted binding wins over the model's environment; history without
	// a binding is a pre-profile session and stays on prod.
	const persisted = createCtx("main-persisted", {
		agent: "main",
		entries: [{ type: "custom", customType: PROFILE_ENTRY_TYPE, data: { profile: "test" } }],
		providers: ["agp-prod-codex"],
		current: { provider: "agp-prod-codex" },
	});
	const persistedResult = await runtime.bindSession(persisted, { allowNetwork: false });
	assert.equal(persistedResult.snapshot.id, "test");
	assert.equal(persistedResult.snapshot.source, "session");
	assert.deepEqual(
		{
			id: runtime.bindingFor("main-persisted")?.id,
			source: runtime.bindingFor("main-persisted")?.source,
		},
		{ id: "test", source: "session" },
	);

	const legacy = createCtx("main-legacy", {
		agent: "main",
		entries: [{ type: "message" }],
		providers: ["agp-test-codex"],
		current: { provider: "agp-test-codex" },
	});
	const legacyResult = await runtime.bindSession(legacy, { allowNetwork: false });
	assert.equal(legacyResult.legacy, true);
	assert.equal(legacyResult.snapshot.id, "prod");
	assert.equal(legacyResult.snapshot.source, "legacy");
	assert.deepEqual(
		{ id: runtime.bindingFor("main-legacy")?.id, source: runtime.bindingFor("main-legacy")?.source },
		{ id: "prod", source: "legacy" },
	);

	// 5. Host bookkeeping is not history. 18.11.1 writes model_change (and often
	// thinking_level_change/session_init) into a brand-new session before
	// session_start; treating those as conversation would pin every new session
	// to prod and ignore the environment the user asked for.
	const bookkeepingOnly = createCtx("main-bookkeeping", {
		agent: "main",
		entries: [
			{ type: "model_change", model: "opencode/deepseek-v4.1-flash" },
			{ type: "thinking_level_change", thinkingLevel: "high" },
			{ type: "session_init" },
		],
		providers: ["agp-test-codex"],
		current: { provider: "agp-test-codex" },
	});
	const bookkeepingResult = await runtime.bindSession(bookkeepingOnly, { allowNetwork: false });
	assert.equal(bookkeepingResult.legacy, false, "bookkeeping alone is not a pre-profile session");
	assert.equal(
		bookkeepingResult.snapshot.id,
		"test",
		"a new session follows its own model's environment, not prod",
	);
	assert.equal(bookkeepingResult.snapshot.source, "inherited");
	// ...while real conversation in a resumed session still classifies as legacy.
	const conversation = createCtx("main-conversation", {
		agent: "main",
		entries: [{ type: "message" }, { type: "model_change", model: "codex/gpt-5.6-terra" }],
		providers: ["agp-test-codex"],
		current: { provider: "agp-test-codex" },
	});
	const conversationResult = await runtime.bindSession(conversation, { allowNetwork: false });
	assert.equal(conversationResult.legacy, true);
	assert.equal(conversationResult.snapshot.id, "prod");

	// 6. The spawn hook rewrites only selectors this session's environment
	// serves: direct providers and sessions with no binding are left alone.
	assert.deepEqual(runtime.remapSpawn(byModel, ["codex/gpt-5.6-terra", "agent-lm/whatever"]), {
		patterns: ["agp-test-codex/gpt-5.6-terra", "agent-lm/whatever"],
		changed: true,
	});
	assert.deepEqual(runtime.remapSpawn(byModel, ["ds-local/deepseek-v4-pro"]), {
		patterns: ["ds-local/deepseek-v4-pro"],
		changed: false,
	});
	const unbound = createCtx("child-unbound");
	assert.deepEqual(runtime.remapSpawn(unbound, ["codex/gpt-5.6-terra"]), {
		patterns: ["codex/gpt-5.6-terra"],
		changed: false,
	});
	assert.equal(runtime.catalogFor("test")?.providers.has("agent-lm"), false);
	assert.equal(runtime.catalogFor("test")?.providers.has("ds-local"), false);

	// 6. In-process children share the process settings, so the runtime must
	// point the host's role override at this environment only — and the host
	// must read the written value back for that to count as support.
	let roleStore: Record<string, string> = {
		task: "codex/gpt-5.6-terra",
		review: "agent-lm/whatever",
		direct: "ds-local/deepseek-v4-pro",
	};
	const roleCalls: Array<Record<string, string>> = [];
	const roleHost = createPi({
		getModelRoles: () => ({ ...roleStore }),
		overrideModelRoles: (roles: Record<string, string>) => {
			roleCalls.push({ ...roles });
			roleStore = { ...roleStore, ...roles };
		},
	});
	const roleRuntime = createSessionRuntime(roleHost.pi, {
		root: { id: "test", source: "launch-env" },
	});
	const roleCtx = createCtx("child-roles", {
		agent: "sub",
		current: { provider: "agp-test-codex" },
	});
	const roleBinding = await roleRuntime.bindSession(roleCtx, { allowNetwork: false });
	assert.equal(roleBinding.blocked, null);
	assert.equal(roleBinding.snapshot.id, "test");
	roleRuntime.registerDiscovery(roleBinding.snapshot, discovery);
	await roleRuntime.applySnapshot(roleBinding.snapshot, discovery);
	await roleRuntime.applyRoleMapping(roleBinding.snapshot);

	assert.equal(roleRuntime.settings.support.roles, "settings");
	assert.equal(roleCalls.length, 1, "role mapping must go through the override layer exactly once");
	const appliedRoles = roleCalls[0]!;
	assert.deepEqual(appliedRoles, { task: "agp-test-codex/gpt-5.6-terra" });
	assert.equal("direct" in appliedRoles, false, "a direct-provider role must never be rewritten");
	assert.equal("review" in appliedRoles, false);
	assert.equal(roleStore.task, "agp-test-codex/gpt-5.6-terra", "the host must read back what it wrote");
	assert.equal(roleStore.direct, "ds-local/deepseek-v4-pro", "a direct role stays as configured");

	// 7. A host with no role override surface is reported, never faked. Its
	// settings can read the configured task-agent overrides (so the mapping is
	// genuinely attempted) but expose no getModelRoles/overrideModelRoles.
	const capabilityHost = createPi({
		get: (path: string) =>
			path === "task.agentModelOverrides" ? { task: "codex/gpt-5.6-terra" } : undefined,
	});
	const capabilityRuntime = createSessionRuntime(capabilityHost.pi, {
		root: { id: "test", source: "launch-env" },
	});
	const capabilityCtx = createCtx("child-capability", {
		agent: "sub",
		current: { provider: "agp-test-codex" },
	});
	const capabilityBinding = await capabilityRuntime.bindSession(capabilityCtx, {
		allowNetwork: false,
	});
	assert.equal(capabilityBinding.blocked, null);
	assert.equal(capabilityBinding.snapshot.id, "test");
	capabilityRuntime.registerDiscovery(capabilityBinding.snapshot, discovery);
	await capabilityRuntime.applySnapshot(capabilityBinding.snapshot, discovery);
	await capabilityRuntime.applyRoleMapping(capabilityBinding.snapshot);

	assert.equal(capabilityRuntime.settings.support.roles, "unavailable");
	assert.equal(
		await capabilityRuntime.settings.applyRoles({ task: "agp-test-codex/gpt-5.6-terra" }),
		false,
	);
	const capabilityNotes = capabilityRuntime.roleMappingNotes().join("\n");
	assert.match(capabilityNotes, /TEST/);
	assert.match(capabilityNotes, /role overrides not applied by this host/);
	assert.doesNotMatch(capabilityNotes, /partially unsupported/);

	// 8. Nothing above may have exported the environment: the runtime resolves
	// per session and never writes AGP_PROFILE.
	assert.equal(process.env[PROFILE_ENV], PROFILE_SENTINEL);
	assert.equal(process.env.AGP_PROFILE, PROFILE_SENTINEL);
	assert.equal(fetches, 0);

	console.log("ok child-inheritance: env, spawn-patterns, roles, capability-report");
} finally {
	globalThis.fetch = originalFetch;
	if (originalProfileEnv === undefined) delete process.env.AGP_PROFILE;
	else process.env.AGP_PROFILE = originalProfileEnv;
	process.env.HOME = originalHome;
}
