// Regression test for runtime separation and per-session lifecycle.
//
// (a) Two runtimes in one process are independent: each owns its own seed,
//     bindings and generations, so one host's session can never observe or
//     retarget another's.
//
// (b) A child's environment comes from the child's OWN current model while
//     several environments are registered; a live child keeps its binding and
//     the left environment's registrations are KEPT for it; a NEW child still
//     resolves from its own model; and a subagent whose model names no
//     environment FAILS CLOSED (no registration, no fetch).
//
// (c) Switching moves the session's model onto the target (effort and service
//     tiers preserved), leaves a direct-provider session alone, and is
//     transactional: a target that cannot be validated or applied aborts or
//     rolls back, restoring the previous binding, registrations, status and
//     model.
//
// (d) Bindings retire through real lifecycle: a newer main session retires the
//     older one, a finished subagent is retired by endSession, and the retired
//     environment's providers are handed back to the shared registry.

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import type { Api } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ProxyConfig } from "../src/config.ts";
import type { Discovery, DiscoveryCustomEntry } from "../src/fetch-models.ts";
import type { ProfileSeed } from "../src/profile-context.ts";

const home = process.env.PI_GATEWAY_TEST_HOME!;
assert.ok(home && process.env.HOME === home, "Run through scripts/run-isolated.ts");
const originalHome = process.env.HOME;
const originalProfileEnv = process.env.AGP_PROFILE;
const originalFetch = globalThis.fetch;
process.env.HOME = home;

// Dynamic imports: home/config paths are computed at module evaluation, so HOME
// must be isolated before the production modules load (same pattern as the
// other contract tests).
const { profilePaths } = await import("../src/profiles.ts");
const { saveConfig } = await import("../src/config.ts");
const { writeDiscoveryCache } = await import("../src/cache.ts");
const { cacheScope } = await import("../src/cache-scope.ts");
const { PREFERRED_CONTRACT } = await import("../src/fetch-usage.ts");
const { createSessionRuntime } = await import("../src/session-runtime.ts");

const PROD_ENDPOINT = "https://prod.test/v1";
const TEST_ENDPOINT = "https://test.test/v1";
const API_KEY = "k";
const ROOT_PROD: ProfileSeed = { id: "prod", source: "launch-env" };
const ROOT_TEST: ProfileSeed = { id: "test", source: "launch-env" };

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

/** Host mock: records provider + model lifecycle calls so behaviour is observable. */
interface PiMock {
	registered: string[];
	unregistered: string[];
	setModelCalls: unknown[];
	thinkingLevels: string[];
	serviceTiers: Array<[string, unknown]>;
	registerProvider(name: string): void;
	unregisterProvider(name: string): void;
	appendEntry(type: string, data: unknown): void;
	getFlag(name: string): string | boolean | undefined;
	setModel(model: unknown): unknown;
	getThinkingLevel(): string;
	setThinkingLevel(level: string): void;
	getServiceTiers(): Record<string, unknown>;
	setServiceTier(family: string, tier: unknown): void;
}

function makePi(opts: { refuseModel?: boolean } = {}): PiMock {
	const registered: string[] = [];
	const unregistered: string[] = [];
	const setModelCalls: unknown[] = [];
	const thinkingLevels: string[] = [];
	const serviceTiers: Array<[string, unknown]> = [];
	return {
		registered,
		unregistered,
		setModelCalls,
		thinkingLevels,
		serviceTiers,
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
		setModel(model: unknown) {
			setModelCalls.push(model);
			return opts.refuseModel ? false : model;
		},
		getThinkingLevel() {
			return "high";
		},
		setThinkingLevel(level: string) {
			thinkingLevels.push(level);
		},
		getServiceTiers() {
			return { codex: "flex" };
		},
		setServiceTier(family: string, tier: unknown) {
			serviceTiers.push([family, tier]);
		},
	};
}

/** Session context mock: explicit identity, agent kind, current model and resolver. */
interface CtxMock {
	hasUI: boolean;
	statuses: Array<[string, string]>;
	ui: { setStatus(key: string, value: string): void };
	agent: { kind: "main" | "sub" };
	model?: { provider: string; id?: string };
	sessionManager: { getSessionId(): string; getEntries(): Array<{ type: string }> };
	models: {
		list(): Array<{ provider: string }>;
		current(): { provider: string; id?: string } | undefined;
		resolve(spec: string): unknown;
	};
	isIdle(): boolean;
}

function makeCtx(opts: {
	sessionId: string;
	kind: "main" | "sub";
	providers?: string[];
	current?: { provider: string; id?: string };
	model?: { provider: string; id?: string };
	resolve?: (spec: string) => unknown;
	hasUI?: boolean;
}): CtxMock {
	const statuses: Array<[string, string]> = [];
	const ctx: CtxMock = {
		hasUI: opts.hasUI ?? false,
		statuses,
		ui: {
			setStatus(key: string, value: string) {
				statuses.push([key, value]);
			},
		},
		agent: { kind: opts.kind },
		sessionManager: {
			getSessionId: () => opts.sessionId,
			getEntries: () => [],
		},
		models: {
			list: () => (opts.providers ?? []).map((provider) => ({ provider })),
			current: () => opts.current,
			resolve: (spec: string) => (opts.resolve ? opts.resolve(spec) : spec),
		},
		isIdle: () => true,
	};
	if (opts.model) ctx.model = opts.model;
	return ctx;
}

const asCtx = (ctx: CtxMock): ExtensionContext => ctx as unknown as ExtensionContext;
const asCommandCtx = (ctx: CtxMock): ExtensionCommandContext =>
	ctx as unknown as ExtensionCommandContext;
const asPi = (pi: PiMock): ExtensionAPI => pi as unknown as ExtensionAPI;

try {
	saveConfig("prod", makeCfg(PROD_ENDPOINT));
	saveConfig("test", makeCfg(TEST_ENDPOINT));
	// prod: codex serves terra+astra only.
	writeDiscoveryCache(
		profilePaths("prod"),
		discoveryOf([
			customEntry("codex/gpt-5.6-terra", "codex"),
			customEntry("codex/gpt-6-astra", "codex"),
		]),
		cacheScope(PROD_ENDPOINT, API_KEY, PREFERRED_CONTRACT),
	);
	// test: codex serves terra+luna.
	writeDiscoveryCache(
		profilePaths("test"),
		discoveryOf([
			customEntry("codex/gpt-5.6-terra", "codex"),
			customEntry("codex/gpt-5.6-luna", "codex"),
		]),
		cacheScope(TEST_ENDPOINT, API_KEY, PREFERRED_CONTRACT),
	);
	let fetches = 0;
	globalThis.fetch = (async () => {
		fetches++;
		throw new Error("network disabled in fixture");
	}) as typeof fetch;
	const envBefore = process.env.AGP_PROFILE;

	// ------------------------------------------- (a) two runtimes, one process
	const piA = makePi();
	const piB = makePi();
	const runtimeA = createSessionRuntime(asPi(piA), { root: ROOT_PROD });
	const runtimeB = createSessionRuntime(asPi(piB), { root: ROOT_TEST });
	const ctxA = makeCtx({ sessionId: "session-a", kind: "main" });
	const ctxB = makeCtx({ sessionId: "session-b", kind: "main" });
	const a = await runtimeA.bindSession(asCtx(ctxA));
	const b = await runtimeB.bindSession(asCtx(ctxB));

	assert.equal(a.snapshot!.id, "prod");
	assert.equal(b.snapshot!.id, "test");
	assert.notEqual(
		a.snapshot!.discoveryScope,
		b.snapshot!.discoveryScope,
		"scopes must be per environment",
	);
	assert.notEqual(a.snapshot!.usageScope, b.snapshot!.usageScope);
	assert.equal(runtimeA.isCurrent(b.snapshot!), false, "A must not see B's binding as its own");
	assert.equal(runtimeB.isCurrent(a.snapshot!), false, "B must not see A's binding as its own");
	assert.equal(runtimeB.bindingFor("session-a"), undefined, "A's session is unknown to B");
	assert.equal(runtimeA.bindingFor("session-b"), undefined, "B's session is unknown to A");
	assert.equal(runtimeA.bindingFor("session-a")?.id, "prod");
	assert.equal(runtimeB.bindingFor("session-b")?.id, "test");
	assert.ok(piA.registered.includes("agp-prod-codex"));
	assert.ok(piB.registered.includes("agp-test-codex"));
	assert.equal(process.env.AGP_PROFILE, envBefore, "binding must never write AGP_PROFILE");
	assert.equal(fetches, 0, "cache hits must not touch the network");

	// --------------------------- (b) parent switch keeps a live child's env
	const pi = makePi();
	const runtime = createSessionRuntime(asPi(pi), { root: ROOT_TEST });
	assert.equal(runtime.root?.id, "test");

	const parentCtx = makeCtx({ sessionId: "parent", kind: "main" });
	const parent = await runtime.bindSession(asCtx(parentCtx));
	assert.equal(parent.blocked, null);
	assert.equal(parent.snapshot!.id, "test");
	assert.equal(parent.snapshot!.source, "launch-env");
	const parentSnap = parent.snapshot!;

	// A child spawned while the parent was on test: its OWN model says so.
	const childOldCtx = makeCtx({
		sessionId: "child-old",
		kind: "sub",
		current: { provider: "agp-test-codex", id: "gpt-5.6-terra" },
	});
	const childOld = await runtime.bindSession(asCtx(childOldCtx));
	assert.equal(childOld.changed, true);
	assert.equal(childOld.snapshot!.id, "test");
	assert.equal(childOld.snapshot!.source, "inherited", "the child inherits from its own model");
	const childSnap = childOld.snapshot!;
	assert.equal(childSnap.paths.dir, profilePaths("test").dir, "the child's caches are its own environment's");

	// The spawn hook counter proves the host really fires before_subagent_spawn.
	assert.equal(runtime.spawnObservations(), 0);
	runtime.remapSpawn(asCtx(childOldCtx), ["codex/gpt-5.6-terra"]);
	assert.ok(runtime.spawnObservations() >= 1);

	// The parent moves to prod.
	const unregisteredBefore = pi.unregistered.length;
	const switched = await runtime.switchEnvironment(asCommandCtx(parentCtx), "prod");
	assert.equal(switched.ok, true, switched.message);
	assert.equal(runtime.bindingFor("parent")?.id, "prod");
	assert.equal(runtime.isCurrent(parentSnap), false, "the parent's old snapshot is stale");
	// The live child keeps test registered; the switch adds prod.
	assert.ok(pi.registered.includes("agp-test-codex"), "the live child keeps test registered");
	assert.ok(pi.registered.includes("agp-prod-codex"), "the switch registers prod");
	assert.deepEqual(pi.unregistered.slice(unregisteredBefore), [], "nothing is dropped while the child lives");
	assert.equal(runtime.isCurrent(childSnap), true, "the running child keeps its binding");

	// A NEW child created after the switch resolves from its own model even
	// though BOTH environments' providers are now registered in this process.
	const childNewCtx = makeCtx({
		sessionId: "child-new",
		kind: "sub",
		providers: ["agp-prod-codex", "agp-test-codex"],
		current: { provider: "agp-prod-codex", id: "gpt-5.6-terra" },
	});
	const childNew = await runtime.bindSession(asCtx(childNewCtx));
	assert.equal(childNew.changed, true);
	assert.equal(childNew.snapshot!.id, "prod", "the ambiguous registry must not mislead a child");
	assert.equal(childNew.snapshot!.source, "inherited");
	assert.equal(runtime.isCurrent(childSnap), true);

	// ---------------------------------------- (c) ambiguous child fails closed
	const blockedBeforeRegistered = pi.registered.length;
	const blockedBeforeUnregistered = pi.unregistered.length;
	const blockedBeforeFetches = fetches;
	const blockedCtx = makeCtx({
		sessionId: "child-blocked",
		kind: "sub",
		providers: ["agp-prod-codex", "agp-test-codex"],
		current: undefined,
		model: { provider: "ds-local" },
	});
	const blocked = await runtime.bindSession(asCtx(blockedCtx));
	assert.equal(blocked.changed, false);
	assert.ok(blocked.blocked, "a subagent with no determinable environment must be blocked");
	assert.equal(blocked.blocked?.requested, "subagent");
	assert.equal(runtime.bindingFor("child-blocked"), undefined, "a blocked session is never bound");
	assert.equal(pi.registered.length, blockedBeforeRegistered, "a blocked child registers nothing");
	assert.equal(pi.unregistered.length, blockedBeforeUnregistered, "a blocked child unregisters nothing");
	assert.equal(fetches, blockedBeforeFetches, "a blocked child must not fetch discovery");

	// --------------------------------------------- (d) retirement lifecycle
	const retirePi = makePi();
	const retireRuntime = createSessionRuntime(asPi(retirePi), { root: ROOT_PROD });
	const mainActx = makeCtx({ sessionId: "main-A", kind: "main" });
	const mainBctx = makeCtx({ sessionId: "main-B", kind: "main", providers: ["agp-test-codex"] });
	const mainA = await retireRuntime.bindSession(asCtx(mainActx));
	assert.equal(mainA.snapshot!.id, "prod");
	assert.ok(retirePi.registered.includes("agp-prod-codex"));

	// A newer top-level session retires the older one and hands its names back.
	const mainB = await retireRuntime.bindSession(asCtx(mainBctx));
	assert.equal(mainB.snapshot!.id, "test");
	assert.equal(retireRuntime.bindingFor("main-A"), undefined, "the replaced session is retired");
	assert.ok(
		retirePi.unregistered.includes("agp-prod-codex"),
		"the retired environment's provider is released",
	);
	assert.ok(retirePi.registered.includes("agp-test-codex"));

	// A finished subagent retires its binding and releases the environment it held.
	const childCctx = makeCtx({
		sessionId: "child-C",
		kind: "sub",
		current: { provider: "agp-prod-codex", id: "gpt-5.6-terra" },
	});
	const childC = await retireRuntime.bindSession(asCtx(childCctx));
	assert.equal(childC.snapshot!.id, "prod");
	assert.ok(retirePi.registered.includes("agp-prod-codex"), "the child re-registers the prod namespace");
	const prodUnregisteredBeforeEnd = retirePi.unregistered.filter((n) => n === "agp-prod-codex").length;
	await retireRuntime.endSession(asCtx(childCctx));
	assert.equal(retireRuntime.bindingFor("child-C"), undefined, "endSession retires the finished subagent");
	assert.ok(
		retirePi.unregistered.filter((n) => n === "agp-prod-codex").length > prodUnregisteredBeforeEnd,
		"prod is released once the child is over",
	);
	assert.ok(!retirePi.unregistered.includes("agp-test-codex"), "the surviving main session keeps test");
	assert.ok(retirePi.registered.includes("agp-test-codex"));

	// endSession on a main session is a no-op: its binding is per-prompt, not per-run.
	const mainRegisteredBefore = retirePi.registered.length;
	const mainUnregisteredBefore = retirePi.unregistered.length;
	await retireRuntime.endSession(asCtx(mainBctx));
	assert.equal(retireRuntime.bindingFor("main-B")?.id, "test", "a main session is never retired by endSession");
	assert.equal(retirePi.registered.length, mainRegisteredBefore);
	assert.equal(retirePi.unregistered.length, mainUnregisteredBefore);

	// ------------------------------------- (e) switching moves the session model
	// Happy path: the equivalent model on the target is selected, and the effort
	// and service tiers captured before the switch are re-asserted.
	const movePi = makePi();
	const moveRuntime = createSessionRuntime(asPi(movePi), { root: ROOT_TEST });
	const moveCtx = makeCtx({
		sessionId: "move-session",
		kind: "main",
		current: { provider: "agp-test-codex", id: "gpt-5.6-terra" },
	});
	const moved = await moveRuntime.bindSession(asCtx(moveCtx));
	assert.equal(moved.snapshot!.id, "test");
	const moveSwitch = await moveRuntime.switchEnvironment(asCommandCtx(moveCtx), "prod");
	assert.equal(moveSwitch.ok, true, moveSwitch.message);
	assert.deepEqual(movePi.setModelCalls, ["agp-prod-codex/gpt-5.6-terra"], "the target model is selected once");
	assert.deepEqual(movePi.thinkingLevels, ["high"], "the thinking level is preserved");
	assert.deepEqual(movePi.serviceTiers, [["codex", "flex"]], "the service tier is preserved");
	assert.doesNotMatch(moveSwitch.message, /re-selection/);

	// A direct provider is left alone: the switch still succeeds, no model change.
	const directPi = makePi();
	const directRuntime = createSessionRuntime(asPi(directPi), { root: ROOT_TEST });
	const directCtx = makeCtx({
		sessionId: "direct-session",
		kind: "main",
		current: { provider: "ds-local", id: "deepseek-v4-pro" },
	});
	await directRuntime.bindSession(asCtx(directCtx));
	const directSwitch = await directRuntime.switchEnvironment(asCommandCtx(directCtx), "prod");
	assert.equal(directSwitch.ok, true, directSwitch.message);
	assert.deepEqual(directPi.setModelCalls, [], "a direct provider needs no move");
	assert.deepEqual(directPi.thinkingLevels, []);
	assert.doesNotMatch(directSwitch.message, /re-selection/, "a direct provider is handled silently");

	// No equivalent: the session still sits on an AGP namespace of the
	// environment being left and the target serves no such model. Phase 1
	// refuses the switch, so nothing is mutated.
	const reselectPi = makePi();
	const reselectRuntime = createSessionRuntime(asPi(reselectPi), { root: ROOT_TEST });
	const reselectCtx = makeCtx({
		sessionId: "reselect-session",
		kind: "main",
		current: { provider: "agp-test-codex", id: "gpt-5.6-luna" },
	});
	const reselectBind = await reselectRuntime.bindSession(asCtx(reselectCtx));
	const reselectOld = reselectBind.snapshot!;
	const reselectRegisteredBefore = reselectPi.registered.length;
	const reselectUnregisteredBefore = reselectPi.unregistered.length;
	const reselectSwitch = await reselectRuntime.switchEnvironment(asCommandCtx(reselectCtx), "prod");
	assert.equal(reselectSwitch.ok, false);
	assert.match(reselectSwitch.message, /does not serve this session's model/);
	assert.match(reselectSwitch.message, /no automatic fallback/);
	assert.equal(reselectRuntime.bindingFor("reselect-session")?.id, "test");
	assert.equal(reselectRuntime.isCurrent(reselectOld), true);
	assert.deepEqual(reselectPi.setModelCalls, [], "nothing is selected when the target cannot serve the model");
	assert.equal(reselectPi.registered.slice(reselectRegisteredBefore).length, 0);
	assert.equal(reselectPi.unregistered.slice(reselectUnregisteredBefore).length, 0);

	// setModel refuses: phase 2 fails and compensates — binding, registrations,
	// status line and the previously selected model all return to test.
	const rollbackPi = makePi({ refuseModel: true });
	const rollbackRuntime = createSessionRuntime(asPi(rollbackPi), { root: ROOT_TEST });
	const rollbackCtx = makeCtx({
		sessionId: "rollback-session",
		kind: "main",
		current: { provider: "agp-test-codex", id: "gpt-5.6-terra" },
		hasUI: true,
	});
	const rollbackBind = await rollbackRuntime.bindSession(asCtx(rollbackCtx));
	const rollbackOld = rollbackBind.snapshot!;
	const rollbackSwitch = await rollbackRuntime.switchEnvironment(asCommandCtx(rollbackCtx), "prod");
	assert.equal(rollbackSwitch.ok, false);
	assert.match(rollbackSwitch.message, /rolled back/);
	assert.equal(rollbackRuntime.bindingFor("rollback-session")?.id, "test");
	assert.equal(rollbackRuntime.isCurrent(rollbackOld), true, "the previous binding is restored");
	assert.ok(
		rollbackPi.unregistered.includes("agp-prod-codex"),
		"the target's registrations were rolled back",
	);
	assert.equal(
		rollbackPi.registered.at(-1),
		"agp-test-codex",
		"the previous environment is registered again",
	);
	assert.deepEqual(
		rollbackPi.setModelCalls.at(-1),
		{ provider: "agp-test-codex", id: "gpt-5.6-terra" },
		"the previously selected model object is restored",
	);
	assert.equal(rollbackCtx.statuses.at(-1)?.[0], "0agp");
	assert.equal(rollbackCtx.statuses.at(-1)?.[1], "TEST \u00b7 https://test.test");

	// No current model at all: nothing to move, so the switch is silent and the
	// next model resolution uses the roles the switch already mapped.
	const nomodelPi = makePi();
	const nomodelRuntime = createSessionRuntime(asPi(nomodelPi), { root: ROOT_TEST });
	const nomodelCtx = makeCtx({ sessionId: "nomodel-session", kind: "main" });
	await nomodelRuntime.bindSession(asCtx(nomodelCtx));
	const nomodelSwitch = await nomodelRuntime.switchEnvironment(asCommandCtx(nomodelCtx), "prod");
	assert.equal(nomodelSwitch.ok, true, nomodelSwitch.message);
	assert.deepEqual(nomodelPi.setModelCalls, [], "nothing is selected when no model is current");
	assert.doesNotMatch(nomodelSwitch.message, /re-selection/);

	// Malformed target catalogue: phase 1 validates namespaces before touching
	// anything, so the session keeps binding, registrations and model.
	const malformedPi = makePi();
	const malformedRuntime = createSessionRuntime(asPi(malformedPi), { root: ROOT_TEST });
	const malformedCtx = makeCtx({
		sessionId: "malformed-session",
		kind: "main",
		current: { provider: "agp-test-codex", id: "gpt-5.6-terra" },
	});
	const malformedBind = await malformedRuntime.bindSession(asCtx(malformedCtx));
	const malformedOld = malformedBind.snapshot!;
	writeDiscoveryCache(
		profilePaths("prod"),
		discoveryOf([customEntry("codex/bad", "bad namespace")]),
		cacheScope(PROD_ENDPOINT, API_KEY, PREFERRED_CONTRACT),
	);
	const malformedRegisteredBefore = malformedPi.registered.length;
	const malformedUnregisteredBefore = malformedPi.unregistered.length;
	const malformedSwitch = await malformedRuntime.switchEnvironment(asCommandCtx(malformedCtx), "prod");
	assert.equal(malformedSwitch.ok, false);
	assert.match(malformedSwitch.message, /cannot be registered/);
	assert.match(malformedSwitch.message, /staying on/);
	assert.equal(malformedRuntime.bindingFor("malformed-session")?.id, "test");
	assert.equal(malformedRuntime.isCurrent(malformedOld), true);
	assert.deepEqual(malformedPi.setModelCalls, [], "no model change is attempted on a rejected catalogue");
	assert.equal(malformedPi.registered.slice(malformedRegisteredBefore).length, 0);
	assert.equal(malformedPi.unregistered.slice(malformedUnregisteredBefore).length, 0);
	// Restore the fixture for any later run.
	writeDiscoveryCache(
		profilePaths("prod"),
		discoveryOf([
			customEntry("codex/gpt-5.6-terra", "codex"),
			customEntry("codex/gpt-6-astra", "codex"),
		]),
		cacheScope(PROD_ENDPOINT, API_KEY, PREFERRED_CONTRACT),
	);

	assert.equal(process.env.AGP_PROFILE, envBefore, "nothing may write AGP_PROFILE");
	assert.equal(fetches, 0, "every fixture path is served from a cache; nothing may fetch");
	console.log(
		"ok runtime-separation: isolation, inheritance, keep-names, fail-closed, retire, model-move, transactional",
	);
} finally {
	globalThis.fetch = originalFetch;
	if (originalProfileEnv === undefined) delete process.env.AGP_PROFILE;
	else process.env.AGP_PROFILE = originalProfileEnv;
	process.env.HOME = originalHome;
	rmSync(home, { recursive: true, force: true });
}
