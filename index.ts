/**
 * AI Gateway — Pi extension that manages model providers through AI Gateway
 * Platform, one environment profile per session.
 *
 * On factory boot we:
 *   1. bring the profile layout up to date (one-time migration of the single
 *      pre-profile config into `prod`) and resolve the launch environment
 *   2. load ~/.pi/agent/ai-gateway/profiles/<id>/config.json
 *   3. fetch or reuse that profile's discovery, then register every provider
 *      under the environment namespace (`agp-prod-*`, `agp-test-*`)
 *   4. register slash commands /cliproxy, /cliproxy-setup, /cliproxy-profile
 *   5. bind the session's environment (persisted, so a resume stays on it) and
 *      map model roles onto it, including for subagents
 *   6. register the footer's environment + quota segments
 *
 * All discovery + apply errors are logged but never abort extension load —
 * a missing/broken proxy must not prevent Pi from starting.
 */

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";

import { registrationConfig, requireGatewayTransport } from "./src/apply.ts";
import { agpBaseName } from "./src/provider-names.ts";
import { readDiscoveryCache } from "./src/cache.ts";
import { registerCommands } from "./src/commands.ts";
import { detectConflicts } from "./src/conflicts.ts";
import { fetchDiscovery } from "./src/fetch-models.ts";
import { type UsageDocument, fetchUsage, lastUsageContract, lastUsageSource, PREFERRED_CONTRACT } from "./src/fetch-usage.ts";
import { log, setLogSink } from "./src/log.ts";
import { PROFILE_FLAG, type ProfileSnapshot, describeProfile } from "./src/profile-context.ts";
import { ensureProfileLayout } from "./src/profiles-migration.ts";
import { type SessionRuntime, runtimeFor } from "./src/session-runtime.ts";
import { renderQuotaSegment } from "./src/status-quota.ts";
import {
	isUsageFresh,
	readUsageCache,
	releaseUsageLock,
	tryAcquireUsageLock,
	writeUsageCache,
} from "./src/usage-shared-cache.ts";

/** Status-line key. The leading "0" makes it sort before alphabetic keys so
 * the quota segment appears first on the footer's extension-status line. */
const QUOTA_STATUS_KEY = "0quota";
/** Minimum gap between network fetches triggered by turn_end, even if the
 * shared file cache is stale (prevents burst fetches during rapid turns). */
const TURN_FETCH_DEBOUNCE_MS = 5_000;

/** Guards the legacy-source warning so it appears once per session. */
let legacyUsageWarned = false;

/** Where an operator learns how to install or update the bridge plugin. */
const BRIDGE_DOCS_URL = "https://github.com/abix5/pi-cliproxyapi-bridge#pi-bridge";

/** Pi's taskflow children run in JSON/print mode and need providers only. */
export function isHeadlessRun(argv = process.argv): boolean {
	const modeIndex = argv.indexOf("--mode");
	const mode = modeIndex >= 0 ? argv[modeIndex + 1] : undefined;
	return mode === "json" || mode === "print" || argv.includes("-p") || argv.includes("--print");
}

// Events the running host emits but the peer typings this package is built
// against do not declare (18.11.1 vs 18.2). Declared here rather than cast
// inline at the registration site so the payload we rely on stays visible.
interface SubagentSpawnEvent {
	type: "before_subagent_spawn";
	agent: string;
	invocationKind: string;
	modelRole?: string;
	/** Attempt-ordered model patterns this spawn would resolve. */
	patterns: string[];
	spawnKey?: string;
}
interface SubagentSpawnResult {
	model?: string | string[];
	block?: boolean;
	reason?: string;
	note?: string;
}
interface HostEventExtensions {
	on(
		event: "before_subagent_spawn",
		handler: (event: SubagentSpawnEvent, ctx: ExtensionContext) => SubagentSpawnResult | void,
	): void;
}

/**
 * Fetch usage data through the profile's shared file cache: if the on-disk
 * cache is fresh (within TTL), return it without any network call; otherwise
 * acquire that profile's cross-process lock and fetch at most once. The result
 * carries local cache staleness separately from unchanged server
 * observation/cache provenance.
 */
async function loadUsageCached(
	snapshot: ProfileSnapshot,
	opts: { readOnly?: boolean } = {},
): Promise<{ doc: UsageDocument; stale: boolean } | null> {
	const cached = readUsageCache(snapshot.paths, snapshot.usageScope);
	const fallback = cached ? { doc: cached.doc, stale: !isUsageFresh(cached.ageMs) } : null;
	if (fallback && !fallback.stale) return fallback;
	// readOnly mode (debounce path): never fetch, serve stale cache if available.
	if (opts.readOnly) return fallback;
	// Stale or missing — try to become the fetcher.
	const token = tryAcquireUsageLock(snapshot.paths);
	if (!token) {
		// Another instance on this profile is fetching; serve stale data if we have it.
		return fallback;
	}
	try {
		const doc = await fetchUsage(snapshot.cfg, snapshot.resolvedUsageKey, {
			force: true,
			resolvedApiKey: snapshot.apiKey,
		});
		writeUsageCache(snapshot.paths, doc, snapshot.usageScope);
		return { doc, stale: false };
	} catch (e) {
		log.debug("usage fetch failed in shared cache:", (e as Error).message);
		return fallback;
	} finally {
		releaseUsageLock(snapshot.paths, token);
	}
}

/**
 * Refresh discovery over the network after the cached copy was applied.
 *
 * The extension handle captured at startup becomes invalid once pi replaces or
 * reloads the session, so a slow refresh that finishes afterwards must not try
 * to register providers with it. That case is expected, not an error. A refresh
 * whose environment was left behind while it was in flight is dropped by the
 * apply gate inside the runtime.
 */
async function revalidateDiscovery(
	runtime: SessionRuntime,
	snapshot: ProfileSnapshot,
): Promise<void> {
	try {
		const fresh = await fetchDiscovery(snapshot.cfg, snapshot.apiKey, snapshot.paths);
		if (!runtime.isCurrent(snapshot)) {
			log.info(`discovery for ${snapshot.id} arrived after the environment changed — dropped`);
			return;
		}
		runtime.registerDiscovery(snapshot, fresh);
		await runtime.applySnapshot(snapshot, fresh);
		await runtime.applyRoleMapping(snapshot);
		log.debug("discovery revalidated from network");
	} catch (e) {
		const message = (e as Error).message ?? "";
		if (message.includes("stale after session replacement")) {
			log.debug("discovery revalidate skipped: session was replaced");
			return;
		}
		log.warn("background discovery revalidate failed:", message);
	}
}

/** Warn once per session when quota still comes from a pre-contract source, so
 * a deprecated path is visible rather than silently permanent. */
function warnIfLegacyUsageSource(ui: {
	notify(message: string, level: "info" | "warning" | "error"): void;
}): void {
	if (legacyUsageWarned) return;
	const source = lastUsageSource();
	const contract = lastUsageContract();
	if (source === null) return;

	if (source === "sidecar") {
		legacyUsageWarned = true;
		ui.notify(
			"quota is served by the legacy sidecar. Install the pi-bridge plugin " +
				"in AI Gateway to use your normal API key " +
				`and drop proxy.usageKey: ${BRIDGE_DOCS_URL}`,
			"warning",
		);
		return;
	}
	if (contract !== null && contract < PREFERRED_CONTRACT) {
		legacyUsageWarned = true;
		ui.notify(
			`the pi-bridge plugin answered with contract v${contract}; this extension ` +
				`prefers v${PREFERRED_CONTRACT}. Quota still works, but update the plugin ` +
				`in CLIProxyAPI for cache and account details: ${BRIDGE_DOCS_URL}`,
			"warning",
		);
	}
}

/**
 * Update quota for the exact gateway namespace of the selected model.
 *
 * Everything is resolved from one snapshot of the session's environment, so a
 * quota read can never mix one environment's discovery with another's key or
 * cache file.
 */
async function refreshQuotaStatus(
	runtime: SessionRuntime,
	ctx: ExtensionContext,
	opts: { readOnly?: boolean } = {},
): Promise<void> {
	// Setup may have switched endpoint/key inside this profile since the
	// callbacks were bound, so take a fresh snapshot of THIS session's binding
	// every time; a session that was never bound reads the launch seed.
	const snapshot = runtime.snapshotFor(ctx);
	const { ui } = ctx;
	const model = ctx.model;
	if (!snapshot) {
		ui.setStatus(QUOTA_STATUS_KEY, undefined);
		return;
	}
	if (!model) {
		ui.setStatus(QUOTA_STATUS_KEY, undefined);
		return;
	}
	const usage = await loadUsageCached(snapshot, opts);
	if (!usage) {
		ui.setStatus(QUOTA_STATUS_KEY, undefined);
		return;
	}
	const discovery = readDiscoveryCache(snapshot.paths, snapshot.discoveryScope)?.discovery;
	if (!discovery) {
		ui.setStatus(QUOTA_STATUS_KEY, undefined);
		return;
	}
	const current = registrationConfig(snapshot.cfg, discovery, snapshot.id);
	// The selected model's provider is registered under this environment's
	// namespace; discovery still speaks the server's own namespace.
	const base = agpBaseName(model.provider, runtime.profileIds());
	const entry =
		discovery.customPool.find(
			(candidate) =>
				(candidate.selectorId ?? candidate.id) === model.id &&
				current.customProviders[model.provider]?.models.some(
					(configured) => configured.id === candidate.id,
				),
		) ??
		discovery.builtinProviders
			.find((provider) => provider.name === base)
			?.models.find(
				(candidate) =>
					(candidate.selectorId ?? candidate.id) === model.id &&
					current.builtinProviders[model.provider]?.models.includes(candidate.id),
			);
	const rendered = entry
		? renderQuotaSegment(
				usage.doc,
				{
					providerId: entry.providerId,
					providerKind: entry.providerKind,
					modelIds: [entry.id, entry.wireId, entry.selectorId, entry.canonicalModel].filter(
						(id): id is string => !!id,
					),
				},
				ui.theme,
				model.id,
				{ localStale: usage.stale },
			)
		: null;
	ui.setStatus(QUOTA_STATUS_KEY, rendered ?? undefined);
}

/**
 * True when THIS module is the globally-installed copy (its file lives under a
 * `node_modules` tree), as opposed to a working-tree checkout.
 */
function isInstalledCopy(): boolean {
	try {
		return import.meta.url.includes("/node_modules/");
	} catch {
		return false;
	}
}

/**
 * True when the current project is a dev checkout of this extension that loads
 * its own working-tree source through `.pi/extensions/ai-gateway.ts`.
 */
function localDevLoaderPresent(cwd: string): boolean {
	try {
		return (
			fs.existsSync(path.join(cwd, ".pi", "extensions", "ai-gateway.ts")) &&
			fs.existsSync(path.join(cwd, "src", "fetch-usage.ts"))
		);
	} catch {
		return false;
	}
}

export default async function aiGateway(pi: ExtensionAPI): Promise<void> {
	// Mode guard: inside this extension's own checkout the project-local loader
	// already supplies the working-tree source. If the published package is also
	// installed globally, both copies would load in one process and register the
	// same providers twice, so the installed copy stands down and the dev source
	// wins.
	if (isInstalledCopy() && localDevLoaderPresent(process.cwd())) {
		return;
	}

	// The environment selects everything downstream — config, caches, keys,
	// provider names — so it is resolved before any of them is touched. The flag
	// is an interactive convenience on top of AGP_PROFILE; a host without
	// extension flags (upstream Pi) simply relies on the environment.
	if (typeof pi.registerFlag === "function") {
		pi.registerFlag(PROFILE_FLAG, {
			description: "AI Gateway environment profile for this session (e.g. prod, test)",
			type: "string",
		});
	}
	ensureProfileLayout();
	const runtime = runtimeFor(pi);
	// Work that happens before a session exists is bound to the launch seed; the
	// first session then binds its own environment and, when they differ, this
	// pre-session registration is superseded (see the runtime's root binding).
	const rootSnapshot = runtime.rootSnapshot(pi);
	// A launch request naming an environment this machine lacks is fatal: no
	// providers are registered, no config is resolved and no discovery is
	// fetched, so a typo cannot run the session on a different environment than
	// the one requested.
	const blocked = runtime.rootProblem;
	const snapshot = rootSnapshot;
	const headless = isHeadlessRun();

	if (!headless) {
		registerCommands(pi);
		// Route later messages through Pi's notification channel. Startup runs
		// before any session exists, so messages remain off the terminal then.
		pi.on("session_start", (_event, ctx) => {
			setLogSink(ctx.hasUI ? ctx.ui : null);
		});
	}

	try {
		await requireGatewayTransport();
	} catch (error) {
		log.error((error as Error).message);
		return;
	}

	if (blocked) {
		log.error(`AI Gateway is not registering providers: ${blocked.reason}`);
		if (!headless) {
			pi.on("session_start", (_event, ctx) => {
				ctx.ui.notify(`AI Gateway: ${blocked.reason}`, "error");
			});
		}
	}

	// Conflict scanning only feeds the interactive diagnostics UI.
	if (!headless && snapshot) {
		const conflicts = detectConflicts(snapshot.cfg);
		for (const c of conflicts) log.warn(`conflict (${c.kind}): ${c.detail}`);
	}

	// Initial registration: this profile's cached pool when present (instant,
	// no network), otherwise a fetch. Headless runs never fetch and never
	// register commands or UI — they only need the providers. A blocked launch
	// registers nothing here; the session handlers further down still run, so a
	// session that carries its own valid binding can recover without this
	// process ever guessing an environment.
	try {
		if (!snapshot) {
			log.debug("no environment to register for this process");
		} else {
			const cached = readDiscoveryCache(snapshot.paths, snapshot.discoveryScope);
			if (cached) {
				log.info(
					`discovery from cache for ${snapshot.id} (age ${Math.round(cached.ageMs / 1000)}s): ` +
						`${cached.discovery.builtinProviders.length} builtin, ${cached.discovery.customPool.length} custom`,
				);
				runtime.registerDiscovery(snapshot, cached.discovery);
				try {
					await runtime.applySnapshot(snapshot, cached.discovery);
				} catch (err) {
					// The cached pool is unusable — its cache was dropped, so fetch a
					// usable one now instead of starting without providers.
					log.warn("cached discovery unusable — fetching a fresh one:", (err as Error).message);
					const fresh = await fetchDiscovery(snapshot.cfg, snapshot.apiKey, snapshot.paths);
					runtime.registerDiscovery(snapshot, fresh);
					await runtime.applySnapshot(snapshot, fresh, pi);
				}
				if (!headless) {
					// Revalidate in the background, but bind the work to the session
					// that started it: pi invalidates the extension handle when the
					// session is replaced or reloaded, and using a captured handle
					// afterwards throws.
					void revalidateDiscovery(runtime, snapshot);
				}
			} else if (headless) {
				log.warn(
					`discovery cache missing for ${snapshot.id} in headless run — no providers registered`,
				);
			} else {
				const discovery = await fetchDiscovery(snapshot.cfg, snapshot.apiKey, snapshot.paths);
				runtime.registerDiscovery(snapshot, discovery);
				await runtime.applySnapshot(snapshot, discovery, pi);
			}
			await runtime.applyRoleMapping(snapshot);
		}
	} catch (err) {
		log.error(`initial apply failed:`, (err as Error).message);
		// Commands stay registered so the environment can be fixed or switched;
		// nothing was registered for this session.
	}

	// OMP restores the saved model before session_start, and a saved session may
	// belong to the other environment. Register every configured profile's cached
	// providers now so that restore never hits an unknown model; bindSession
	// releases the preloads that the real session does not need.
	try {
		await runtime.preloadProfiles(pi);
	} catch (err) {
		log.warn("could not preload environment providers:", (err as Error).message);
	}

	// -------- session environment binding
	//
	// A resumed session keeps the environment it was created on, so history and
	// quota context never move silently. Registration above used the launch
	// selection; this reconciles it with the session's own binding.
	let roleNotesReported = false;
	const bindSession = async (ctx: ExtensionContext): Promise<void> => {
		try {
			const { snapshot: resolved, legacy, blocked: sessionProblem } = await runtime.bindSession(ctx, {
				allowNetwork: !headless,
				api: pi,
			});
			if (sessionProblem || !resolved) {
				const reason = sessionProblem?.reason ?? "no AI Gateway environment is usable for this session";
				log.error(reason);
				if (ctx.hasUI) ctx.ui.notify(`AI Gateway: ${reason}`, "error");
				return;
			}
			runtime.reportStatus(ctx, resolved);
			const notes = runtime.roleMappingNotes();
			if (!roleNotesReported && notes.length > 0 && ctx.hasUI) {
				// Role selectors that could not be mapped are the one thing a user
				// cannot see from the status line, so say it once per session.
				roleNotesReported = true;
				ctx.ui.notify(`AI Gateway: ${notes.join("; ")}`, "warning");
			}
			if (legacy && ctx.hasUI) {
				ctx.ui.notify(
					`this session predates environments — bound to ${describeProfile(resolved)}`,
					"info",
				);
			}
		} catch (err) {
			log.warn("failed to bind the session environment:", (err as Error).message);
		}
	};
	pi.on("session_start", async (_event, ctx) => {
		await bindSession(ctx);
	});
	pi.on("session_switch", async (_event, ctx) => {
		await bindSession(ctx);
	});

	// -------- session lifecycle
	//
	// A subagent that produced its result is over: release its environment
	// binding so the shared provider registry keeps only environments that live
	// sessions still need. A revived child re-binds from its own persisted
	// entry, so this never strands it. A main session's agent loop ends per
	// prompt, and the runtime ignores it.
	pi.on("agent_end", (_event, ctx) => {
		void runtime.endSession(ctx).catch((err: unknown) =>
			log.debug("failed to release the session binding:", (err as Error).message),
		);
	});

	// -------- subagent inheritance
	//
	// Children are rebound to this module graph and share its process settings,
	// so they inherit the environment directly. Their spawn patterns, however,
	// may still be written for another environment (an agent definition or a
	// task-agent override from the global config): rewrite them for this one.
	(pi.on as unknown as HostEventExtensions["on"])("before_subagent_spawn", (event, ctx) => {
		const rewrite = runtime.remapSpawn(ctx, event.patterns ?? []);
		if (!rewrite.changed) return undefined;
		const current = runtime.snapshotFor(ctx);
		if (!current) return { block: true, reason: "AGP environment is not bound for this session" };
		return {
			model: rewrite.patterns,
			note: `${current.label} environment (${current.origin})`,
		};
	});

	if (!headless && snapshot && snapshot.cfg.refreshIntervalMinutes > 0) {
		const intervalMs = snapshot.cfg.refreshIntervalMinutes * 60_000;
		pi.on("session_start", (_event, ctx) => {
			ctx.setInterval(() => {
				void (async () => {
					const fresh = runtime.snapshotFor(ctx);
					if (!fresh?.apiKey) return;
					try {
						const discovery = await fetchDiscovery(fresh.cfg, fresh.apiKey, fresh.paths);
						runtime.registerDiscovery(fresh, discovery);
						const report = await runtime.applySnapshot(fresh, discovery);
						if (!report.superseded) await runtime.applyRoleMapping(fresh);
						log.debug("background refresh ok");
					} catch (e) {
						log.warn("background refresh failed:", (e as Error).message);
					}
				})();
			}, intervalMs);
		});
		log.info(`background refresh every ${snapshot.cfg.refreshIntervalMinutes}m`);
	}

	// -------- status-line quota segment
	//
	// The footer binds the selected discovery entry to its connector UUID.
	// It never guesses codex/claude identity from a local provider name.
	// Quota is available through the pi-bridge plugin (ordinary API key) or the
	if (!headless && snapshot && (snapshot.resolvedUsageKey || snapshot.apiKey)) {
		let lastTurnFetchMs = 0;
		let modelPoll: NodeJS.Timeout | undefined;

		// session_start: render immediately from cache (no fetch needed if fresh).
		pi.on("session_start", async (_event, ctx) => {
			if (!ctx.hasUI) return;
			await refreshQuotaStatus(runtime, ctx);
			warnIfLegacyUsageSource(ctx.ui);
			clearInterval(modelPoll);
			let provider = ctx.model?.provider;
			let modelId = ctx.model?.id;
			// OMP has no model_select event. Observe its public current-model
			// getter, and refresh on a real change: a cached window older than the
			// shared TTL would otherwise render as stale until the next turn. A
			// fresh cache still short-circuits the fetch, and the shared lock keeps
			// rapid switching to at most one network read per TTL window.
			modelPoll = setInterval(() => {
				if (provider === ctx.model?.provider && modelId === ctx.model?.id) return;
				provider = ctx.model?.provider;
				modelId = ctx.model?.id;
				void refreshQuotaStatus(runtime, ctx).catch(() =>
					log.debug("quota model-switch refresh failed"),
				);
			}, 500);
			modelPoll.unref();
		});

		pi.on("session_shutdown", () => {
			clearInterval(modelPoll);
			modelPoll = undefined;
		});

		// Revalidate authority and selected-model quota before each real turn.
		pi.on("before_agent_start", async (_event, ctx) => {
			if (!ctx.hasUI) return;
			await refreshQuotaStatus(runtime, ctx);
		});

		// turn_end: after an LLM response the quota has changed. Trigger a fetch
		// (if the shared cache is stale) but debounce to avoid burst-fetching on
		// rapid consecutive turns.
		pi.on("turn_end", async (_event, ctx) => {
			if (!ctx.hasUI) return;
			const now = Date.now();
			if (now - lastTurnFetchMs < TURN_FETCH_DEBOUNCE_MS) {
				// Within debounce window — re-render from cache only (no fetch), so
				// rapid consecutive turns never trigger burst /api/usage calls.
				await refreshQuotaStatus(runtime, ctx, { readOnly: true });
				return;
			}
			lastTurnFetchMs = now;
			await refreshQuotaStatus(runtime, ctx);
		});
	} else {
		log.debug("usageKey not configured — quota status segment disabled");
	}
}
