// A session created before environment profiles stored its model under the
// server's own namespace (`codex/gpt-5.6-terra`). Those providers are now
// registered per environment (`agp-prod-codex`), so on resume the host cannot
// restore the stored selector and warns before falling back. This asserts the
// migration that removes that manual step: the session is bound to its
// environment (prod, as every pre-profile session was), the stored model is
// re-selected on that environment through the host's own model-change path, and
// the session's thinking level and service tier survive — with no history entry
// rewritten or fabricated.
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
const { createSessionRuntime } = await import("../src/session-runtime.ts");
const { PROFILE_ENTRY_TYPE } = await import("../src/profile-context.ts");
const { adoptLegacySessionModel } = await import("../src/session-model.ts");

const ENDPOINT = "https://prod.test/v1";
const API_KEY = "prod-key";

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

/** One catalogue entry as the gateway reports it for a connector-backed model. */
function codexEntry(selectorId) {
	const id = `codex/${selectorId}`;
	return {
		id,
		wireId: id,
		selectorId,
		providerId: "8fc22fba-0000-4000-8000-000000000000",
		providerKind: "codex",
		canonicalModel: selectorId,
		name: `codex \u00b7 ${selectorId}`,
		api: "openai-responses",
		metadataState: "catalog",
		priceState: "unknown",
		suggestedProvider: "codex",
		ownedBy: "codex",
	};
}

const discovery = {
	source: "well-known",
	upstreamVersion: "fixture",
	builtinProviders: [],
	customPool: [codexEntry("gpt-5.6-terra"), codexEntry("gpt-6-astra")],
	serverDiscoveryExcludes: [],
	upstreamTotal: 2,
};

writeDiscoveryCache(profilePaths("prod"), discovery, cacheScope(ENDPOINT, API_KEY, PREFERRED_CONTRACT));

// ---------------------------------------------------------- the migration
{
	const setModel = [];
	const setThinking = [];
	const setTier = [];
	const appended = [];
	const roleOverrides = {};
	const entries = [
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "hello" }] } },
		{ type: "model_change", model: "codex/gpt-5.6-terra", role: "default" },
	];
	const resolved = { provider: "agp-prod-codex", id: "gpt-5.6-terra", api: "openai-responses" };
	const notified = [];
	const pi = {
		getFlag: () => undefined,
		on() {},
		registerFlag() {},
		registerCommand() {},
		registerProvider() {},
		unregisterProvider() {},
		appendEntry(customType, data) {
			appended.push({ customType, data });
		},
		async setModel(next) {
			setModel.push(next);
			return true;
		},
		getThinkingLevel: () => "high",
		setThinkingLevel(level) {
			setThinking.push(level);
		},
		getServiceTiers: () => ({ openai: "priority" }),
		setServiceTier(family, tier) {
			setTier.push([family, tier]);
		},
		pi: {
			settings: {
				getModelRoles: () => ({ ...roleOverrides }),
				overrideModelRoles(next) {
					Object.assign(roleOverrides, next);
				},
				get: () => undefined,
				override() {},
				clearOverride() {},
			},
		},
	};
	const ctx = {
		ui: {
			notify(message) {
				notified.push(message);
			},
			setStatus() {},
		},
		mode: "tui",
		hasUI: true,
		hasPendingMessages: () => false,
		isIdle: () => true,
		cwd: process.cwd(),
		sessionManager: { getSessionId: () => "legacy-session", getEntries: () => [...entries] },
		models: {
			list: () => [resolved],
			current: () => undefined,
			resolve: (spec) => (spec === "agp-prod-codex/gpt-5.6-terra" ? resolved : undefined),
			family: () => "codex",
		},
	};

	const runtime = createSessionRuntime(pi, { root: { id: "prod", source: "launch-env" } });
	runtime.registerDiscovery(runtime.rootSnapshot(), discovery);
	const result = await runtime.bindSession(ctx, { allowNetwork: false });

	assert.equal(result.legacy, true, "history with no binding is a pre-profile session");
	assert.equal(result.snapshot.id, "prod", "pre-profile sessions belong to prod");
	assert.equal(result.snapshot.source, "legacy");
	assert.deepEqual(
		setModel,
		[resolved],
		"the stored codex/gpt-5.6-terra model is re-selected as agp-prod-codex/gpt-5.6-terra",
	);
	assert.deepEqual(setThinking, ["high"], "the session's thinking level is re-asserted");
	assert.deepEqual(setTier, [["openai", "priority"]], "the session's service tier is re-asserted");
	assert.equal(
		appended.filter((entry) => entry.customType === PROFILE_ENTRY_TYPE).length,
		1,
		"the plugin persists the profile binding",
	);
	assert.equal(appended.length, 1, "the plugin appends no model or message entry of its own");
	assert.deepEqual(
		entries.map((entry) => entry.type),
		["message", "model_change"],
		"the transcript is not rewritten",
	);
	assert.ok(
		notified.some((message) => message.includes("session model moved")),
		"the migration is stated once in the UI",
	);

	// The binding is immutable: binding again neither re-registers nor re-selects.
	setModel.length = 0;
	const again = await runtime.bindSession(ctx, { allowNetwork: false });
	assert.equal(again.changed, false, "an already-bound session is not rebound");
	assert.equal(setModel.length, 0, "the model is not re-selected on every session start");
}

// --------------------------------------------------------- no fabrication
{
	const outcomes = [];
	for (const stored of ["ds-local/deepseek-v4-pro", "codex/gpt-5.6-luna"]) {
		const setModel = [];
		const entries = [
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
			{ type: "model_change", model: stored, role: "default" },
		];
		const pi = {
			getFlag: () => undefined,
			on() {},
			registerFlag() {},
			registerCommand() {},
			registerProvider() {},
			unregisterProvider() {},
			appendEntry() {},
			async setModel(next) {
				setModel.push(next);
				return true;
			},
			getThinkingLevel: () => undefined,
			setThinkingLevel() {},
			getServiceTiers: () => ({}),
			setServiceTier() {},
			pi: { settings: {} },
		};
		const ctx = {
			ui: { notify() {}, setStatus() {} },
			mode: "tui",
			hasUI: true,
			hasPendingMessages: () => false,
			isIdle: () => true,
			cwd: process.cwd(),
			sessionManager: { getSessionId: () => `no-move:${stored}`, getEntries: () => [...entries] },
			models: { list: () => [], current: () => undefined, resolve: () => undefined, family: () => "" },
		};
		const runtime = createSessionRuntime(pi, { root: { id: "prod", source: "launch-env" } });
		runtime.registerDiscovery(runtime.rootSnapshot(), discovery);
		const moved = await adoptLegacySessionModel(
			pi,
			ctx,
			runtime.rootSnapshot(),
			runtime.catalogFor("prod"),
			runtime.profileIds(),
		);
		outcomes.push({ stored, moved, setModel: setModel.length });
	}
	assert.deepEqual(
		outcomes,
		[
			{ stored: "ds-local/deepseek-v4-pro", moved: false, setModel: 0 },
			{ stored: "codex/gpt-5.6-luna", moved: false, setModel: 0 },
		],
		"a direct provider and a model this environment does not serve are left exactly as they were",
	);
}

// --------------------------------------------- renamed direct provider
// `ds-local`/`cpa-codex` were renamed to `direct-deepseek`/`direct-cpa-codex`.
// A session recorded before that rename keeps its explicit reserve: the plugin
// re-selects the renamed provider, never an AGP environment and never a guess.
{
	const setModel = [];
	const resolved = { provider: "direct-deepseek", id: "deepseek-v4-pro", api: "openai-completions" };
	const entries = [
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
		{ type: "model_change", model: "ds-local/deepseek-v4-pro", role: "default" },
	];
	const pi = {
		getFlag: () => undefined,
		on() {},
		registerFlag() {},
		registerCommand() {},
		registerProvider() {},
		unregisterProvider() {},
		appendEntry() {},
		async setModel(next) {
			setModel.push(next);
			return true;
		},
		getThinkingLevel: () => undefined,
		setThinkingLevel() {},
		getServiceTiers: () => ({}),
		setServiceTier() {},
		pi: { settings: {} },
	};
	const ctx = {
		ui: { notify() {}, setStatus() {} },
		mode: "tui",
		hasUI: true,
		hasPendingMessages: () => false,
		isIdle: () => true,
		cwd: process.cwd(),
		sessionManager: { getSessionId: () => "renamed-direct", getEntries: () => [...entries] },
		models: {
			list: () => [],
			current: () => undefined,
			resolve: (selector) => (selector === "direct-deepseek/deepseek-v4-pro" ? resolved : undefined),
			family: () => "",
		},
	};
	const runtime = createSessionRuntime(pi, { root: { id: "prod", source: "launch-env" } });
	runtime.registerDiscovery(runtime.rootSnapshot(), discovery);
	const moved = await adoptLegacySessionModel(
		pi,
		ctx,
		runtime.rootSnapshot(),
		runtime.catalogFor("prod"),
		runtime.profileIds(),
	);
	assert.equal(moved, true, "the renamed direct provider is resolved on the current host");
	assert.deepEqual(setModel, [resolved], "the session keeps its direct reserve under the new name");
}

rmSync(join(home, ".pi"), { recursive: true, force: true });
console.log("ok legacy-resume: bound, model-moved, effort+tier kept, no history rewrite");
