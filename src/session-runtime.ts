// Session-scoped environment runtime.
//
// Owns everything that has to stay consistent within one session and can never
// leak into another. All of it lives in this instance — there is no module-level
// selection and no `process.env` write anywhere:
//
//   * a launch *seed*, fixed when the runtime is created (AGP_PROFILE /
//     --agp-profile / registry default) for work that happens before a session
//     exists;
//   * one immutable binding per session, resolved once at that session's
//     session_start and never re-derived, with its own generation counter, so a
//     parent that switches environments cannot retarget a child that is still
//     running on the one it started on;
//   * provider registration for a session's environment, gated on that session
//     and generation, with registrations kept alive for other live sessions;
//   * the role mapping applied to the host's runtime override layer, so model
//     roles and task-agent model overrides resolve on the environment each
//     session is actually on (in-process children share this process's
//     settings);
//   * the subagent spawn hook that rewrites attempt-ordered model patterns when
//     the inherited settings still name another environment.

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";

import {
	type ApplyReport,
	applyDiscovery,
	buildProfileCatalog,
	profileProviderNames,
	registrationConfig,
} from "./apply.ts";
import { readDiscoveryCache } from "./cache.ts";
import type { Discovery } from "./fetch-models.ts";
import { fetchDiscovery } from "./fetch-models.ts";
import { log } from "./log.ts";
import { createRoleSettingsPort, type RoleSettingsPort } from "./omp-settings.ts";
import { writeProfileOverlay } from "./profile-overlay.ts";
import {
	PROFILE_ENTRY_TYPE,
	type LaunchDecision,
	type ProfileProblem,
	type ProfileSeed,
	type ProfileSnapshot,
	type ProfileSource,
	buildSnapshot,
	defaultSeed,
	describeProfile,
	agentKindOf,
	currentModelProvider,
	launchDecision,
	persistedProfile,
	profileEntryData,
	registeredProviderNames,
	profileFromCurrentModel,
	resumedProfileSeed,
	profileFromRegisteredNames,
	pickProfileForSession,
	sessionIdOf,
	sessionHasHistory,
	sessionIsDurable,
} from "./profile-context.ts";
import { readRegistry } from "./profiles.ts";
import type { ProfileCatalog } from "./role-map.ts";
import { remapRoles, remapSpawnPatterns } from "./role-map.ts";
import {
	type ModelMovePlan,
	adoptStoredSessionModel,
	applyModelChange,
	planModelMove,
} from "./session-model.ts";
import { FOOTER_STATUS_KEY, clearFooter, reportFooter } from "./status-footer.ts";

/** Single footer key owned by status-footer.ts; kept exported for callers. */
export const PROFILE_STATUS_KEY = FOOTER_STATUS_KEY;
/** Pseudo-session used for registration work done before any session exists. */
export const ROOT_SESSION_KEY = "root";

export interface SessionBinding {
	id: string;
	source: ProfileSource;
	generation: number;
	/**
	 * The ExtensionAPI handle of the host session that owns this binding.
	 * Provider registration belongs to a host session, so registration always
	 * goes through that session's own handle — never through a handle captured
	 * when the process started.
	 */
	api: ExtensionAPI;
}

export interface SpawnRewrite {
	patterns: string[];
	changed: boolean;
}

export interface BindResult {
	/**
	 * The session's environment, or null when none could be chosen. A blocked
	 * session deliberately has no snapshot: producing one would mean reading a
	 * config and resolving a credential for an environment the plugin has just
	 * refused to use.
	 */
	snapshot: ProfileSnapshot | null;
	/** False when the session was already bound and nothing had to change. */
	changed: boolean;
	/** True when this session predates profiles and had to be classified. */
	legacy: boolean;
	/** Set when no environment could be chosen; nothing was registered. */
	blocked: ProfileProblem | null;
}

export interface SessionRuntime {
	/** Seed used before any session exists; null when the launch request failed. */
	readonly root: ProfileSeed | null;
	/** Set when the launch request named an environment this machine lacks. */
	readonly rootProblem: ProfileProblem | null;
	settings: RoleSettingsPort;
	profileIds(): readonly string[];
	/** Environments whose catalogue this process has seen. */
	knownProfiles(): string[];
	catalogFor(profile: string): ProfileCatalog | undefined;
	registerDiscovery(snapshot: ProfileSnapshot, discovery: Discovery): void;
	/**
	 * Register this environment's providers, gated on session and generation.
	 * `api` names the owning host session's handle; omitted, it resolves from the
	 * snapshot's binding.
	 */
	applySnapshot(
		snapshot: ProfileSnapshot,
		discovery: Discovery,
		api?: ExtensionAPI,
	): Promise<ApplyReport>;
	applyRoleMapping(snapshot: ProfileSnapshot): Promise<void>;
	roleMappingNotes(): string[];
	/** Bind/refresh a session's environment; resolved once, then immutable. */
	bindSession(
		ctx: ExtensionContext,
		opts?: { allowNetwork?: boolean; api?: ExtensionAPI },
	): Promise<BindResult>;
	/** Snapshot of the session a handler belongs to; null when none is usable. */
	snapshotFor(ctx: ExtensionContext): ProfileSnapshot | null;
	/** Work before any session exists (factory-time apply); null when blocked. */
	rootSnapshot(api?: ExtensionAPI): ProfileSnapshot | null;
	bindingFor(sessionKey: string): SessionBinding | undefined;
	isCurrent(snapshot: ProfileSnapshot): boolean;
	reportStatus(ctx: ExtensionContext, snapshot: ProfileSnapshot): void;
	/** Rewrite a spawn's model patterns for the spawning session's environment. */
	remapSpawn(ctx: ExtensionContext, patterns: readonly string[]): SpawnRewrite;
	/** How often this host has actually fired before_subagent_spawn. */
	spawnObservations(): number;
	/**
	 * The host reported this session's run finished. A subagent that produced its
	 * result is over: its binding and the registrations it held are released
	 * (a revived child re-binds from its own persisted entry). A main session's
	 * agent loop ends per prompt, so it is never retired here.
	 */
	endSession(ctx: ExtensionContext): Promise<void>;
	/**
	 * Prepare a switch that starts a NEW conversation: validate the target and
	 * remember the model it needs. The old conversation's binding, model and
	 * transcript stay untouched; the command then starts the session and its own
	 * session_start applies the target.
	 */
	beginConversationSwitch(
		ctx: ExtensionCommandContext,
		id: string,
	): Promise<{ ok: boolean; message: string; target?: string }>;
	/** Forget a prepared conversation switch (the user cancelled the session). */
	cancelConversationSwitch(): void;
	/**
	 * Commit a prepared switch onto the conversation that actually started. The
	 * host runs `newSession({setup})` AFTER the new session's session_start, so
	 * the target has to be established here, explicitly, on the new session and
	 * its own handle.
	 */
	commitConversationSwitch(
		ctx: ExtensionCommandContext,
		api?: ExtensionAPI,
	): Promise<{ ok: boolean; message: string }>;
	/** The host re-bound the extension factories: adopt the newest handle. */
	rebind(api: ExtensionAPI): void;
	/** Move a live session to another environment (deliberate, keeps history). */
	switchEnvironment(
		ctx: ExtensionCommandContext,
		id: string,
		/** The command's own session handle; defaults to the newest one. */
		api?: ExtensionAPI,
	): Promise<{ ok: boolean; message: string }>;
}

function describeApply(report: ApplyReport): string {
	return `${report.registered.length} registered, ${report.skipped.length} skipped`;
}

export function createSessionRuntime(
	pi: ExtensionAPI,
	opts: { launch?: LaunchDecision; root?: ProfileSeed | null } = {},
): SessionRuntime {
	// The handle belongs to THIS runtime: the host binds a fresh ExtensionAPI per
	// host session, and a process may host several independent runtimes. Keeping
	// it per runtime (instead of module-wide) is what makes two runtimes in one
	// process register into their own sessions.
	let ownApi: ExtensionAPI = pi;
	const runtimeApi = (): ExtensionAPI => ownApi;
	// A launch request that names a missing environment is fatal for this
	// process: no providers are registered and no discovery is fetched, so a
	// typo can never run a session on a different environment than requested.
	const launch: LaunchDecision =
		opts.launch ??
		(opts.root !== undefined
			? { seed: opts.root, problem: null }
			: (() => {
					const resumed = resumedProfileSeed();
					return resumed ? { seed: resumed, problem: null } : launchDecision((name) => runtimeApi().getFlag?.(name));
				})());
	const rootProblem = launch.problem;
	const root = launch.seed ?? (rootProblem ? null : defaultSeed());
	const settings = createRoleSettingsPort(pi);
	const catalogs = new Map<string, ProfileCatalog>();
	/** Namespaced provider names each known environment registers. */
	const namesByProfile = new Map<string, Set<string>>();
	/** The exact discovery each environment was registered from (for rollback). */
	const discoveryByProfile = new Map<string, Discovery>();
	/**
	 * Provider names this runtime has actually registered in this process.
	 *
	 * The host's own ownership bookkeeping is per ExtensionAPI handle, while the
	 * provider registry is per process: a new conversation's handle cannot know
	 * which names an earlier session's handle registered, so the runtime keeps
	 * the ledger and releases names itself once no live binding needs them.
	 */
	const registeredNames = new Set<string>();
	const notes: string[] = [];
	const bindings = new Map<string, SessionBinding>();
	let generationSeq = 0;

	const nextGeneration = (): number => ++generationSeq;

	const profileIds = (): readonly string[] => Object.keys(readRegistry().profiles);

	const registerDiscovery = (snapshot: ProfileSnapshot, discovery: Discovery): void => {
		catalogs.set(snapshot.id, buildProfileCatalog(snapshot.cfg, discovery, snapshot.id, profileIds()));
		discoveryByProfile.set(snapshot.id, discovery);
		namesByProfile.set(
			snapshot.id,
			new Set(profileProviderNames(snapshot.cfg, discovery, snapshot.id)),
		);
	};

	/** Provider names still needed by sessions bound to another environment. */
	const namesKeptForOthers = (sessionKey: string): ReadonlySet<string> => {
		const keep = new Set<string>();
		for (const [key, binding] of bindings) {
			if (key === sessionKey) continue;
			for (const name of namesByProfile.get(binding.id) ?? []) keep.add(name);
		}
		return keep;
	};

	/**
	 * Release names this runtime registered for environments no live binding
	 * references any more. `keepProfiles` are the environments that still have a
	 * session (including the one that just applied), so a running child keeps its
	 * transport while an ended conversation stops offering its models.
	 */
	const releaseUnheldNames = (api: ExtensionAPI, keepProfile?: string): void => {
		const keep = new Set<string>(keepProfile ? (namesByProfile.get(keepProfile) ?? []) : []);
		for (const binding of bindings.values()) {
			for (const name of namesByProfile.get(binding.id) ?? []) keep.add(name);
		}
		for (const name of [...registeredNames]) {
			if (keep.has(name)) continue;
			try {
				api.unregisterProvider(name);
				registeredNames.delete(name);
				log.info(`released ${name}: no live session uses that environment`);
			} catch (err) {
				log.warn(`could not release ${name}:`, (err as Error).message);
			}
		}
	};

	/** The top-level session this process is on, for retiring replaced ones. */
	let topLevelKey: string | undefined;

	/**
	 * Drop a session's binding once the host says it is over, and hand its
	 * provider registrations back: an ended conversation must not keep another
	 * environment's providers in the shared registry (that is how the model menu
	 * ends up offering both environments, and how a selector becomes ambiguous).
	 * A session that comes back re-binds from its persisted entry.
	 */
	const retireSession = async (sessionKey: string, why: string): Promise<void> => {
		const retired = bindings.get(sessionKey);
		if (!retired) return;
		bindings.delete(sessionKey);
		clearFooter(sessionKey);
		if (topLevelKey === sessionKey) topLevelKey = undefined;
		log.info(`retiring ${retired.id} binding for ${sessionKey} (${why})`);
		const survivor = [...bindings.values()][0];
		if (survivor) await pruneAfterRetire(sessionKey);
		else releaseUnheldNames(retired.api);
	};

	/** Re-apply one surviving binding so stale names are released promptly. */
	const pruneAfterRetire = async (sessionKey: string): Promise<void> => {
		for (const [key, binding] of bindings) {
			if (key === sessionKey) continue;
			const survivor = buildSnapshot({ id: binding.id, source: binding.source }, key, binding.generation);
			// Prefer the pool the survivor was registered from: it is the pool its
			// providers and aliases describe, and it is available even when the
			// cache was never written (or was invalidated).
			const discovery =
				discoveryByProfile.get(binding.id) ??
				readDiscoveryCache(survivor.paths, survivor.discoveryScope)?.discovery;
			if (!discovery) continue;
			try {
				registerDiscovery(survivor, discovery);
				await applySnapshot(survivor, discovery, binding.api);
				log.info(`re-applied ${survivor.id} after a session ended`);
			} catch (err) {
				log.warn(`could not re-apply ${survivor.id} after a session ended:`, (err as Error).message);
			}
			return;
		}
	};

	const applySnapshot = async (
		snapshot: ProfileSnapshot,
		discovery: Discovery,
		api?: ExtensionAPI,
	): Promise<ApplyReport> => {
		// Register through the handle of the session that owns the snapshot: a
		// host session's registry is its own, so this must never default to an
		// unrelated session's handle.
		const owner = api ?? bindings.get(snapshot.sessionKey)?.api ?? runtimeApi();
		// applyDiscovery owns the rejection path: a pool the host refuses is
		// dropped from THIS profile's cache before the error propagates.
		const report = await applyDiscovery(owner, snapshot.cfg, discovery, {
			profile: snapshot.id,
			profileIds: profileIds(),
			paths: snapshot.paths,
			gate: () => isCurrent(snapshot),
			keepNames: namesKeptForOthers(snapshot.sessionKey),
		});
		if (report.superseded) {
			log.info(
				`discovery for ${snapshot.id} arrived after the environment changed — not registered`,
			);
			return report;
		}
		for (const name of namesByProfile.get(snapshot.id) ?? []) registeredNames.add(name);
		releaseUnheldNames(owner, snapshot.id);
		log.info(`${snapshot.sessionKey} on ${snapshot.id}: ${describeApply(report)}`);
		return report;
	};

	/**
	 * Point the host's model roles and task-agent model overrides at this
	 * environment, and verify the host actually took them. Only selectors that
	 * name a namespace this environment registered, and a model it actually
	 * serves, are rewritten; a mapping the host does not apply is reported as
	 * unsupported rather than assumed to work.
	 */
	const applyRoleMapping = async (snapshot: ProfileSnapshot): Promise<void> => {
		const catalog = catalogs.get(snapshot.id);
		if (!catalog) {
			notes.length = 0;
			notes.push(`${snapshot.label}: no catalogue yet, role mapping deferred`);
			return;
		}
		const roles = remapRoles(settings.effectiveRoles(), profileIds(), catalog);
		const agents = remapRoles(settings.effectiveAgentOverrides(), profileIds(), catalog);
		notes.length = 0;
		if (roles.unresolved.length || agents.unresolved.length) {
			const unresolved = [...roles.unresolved, ...agents.unresolved].join(", ");
			notes.push(`${snapshot.label}: selectors left as configured (model not in this environment): ${unresolved}`);
			log.warn(`role mapping kept these selectors as configured: ${unresolved}`);
		}
		if (Object.keys(roles.mapped).length === 0 && Object.keys(agents.mapped).length === 0) return;
		// Persisted mapping for processes that start later (an explicit --config
		// overlay) and for children OMP spawns outside this process.
		try {
			writeProfileOverlay(snapshot.paths, roles.mapped, agents.mapped);
		} catch (err) {
			log.warn(`could not write the ${snapshot.id} settings overlay:`, (err as Error).message);
		}
		const okRoles = await settings.applyRoles({ ...roles.mapped });
		const okAgents = await settings.applyAgentOverrides({ ...agents.mapped });
		if (!okRoles || !okAgents) {
			notes.push(
				`${snapshot.label}: role overrides not applied by this host ` +
					`(modelRoles=${settings.support.roles}, task.agentModelOverrides=${settings.support.agentOverrides})`,
			);
			log.warn(`role overrides are not fully supported on this host for ${snapshot.id}`);
		}
		// Two runtimes in one process share the host's settings: if the effective
		// value belongs to another environment, say so rather than thrash.
		const competitor = profileFromRegisteredNames(
			Object.values(settings.effectiveRoles()).map((selector) => selector.split("/")[0] ?? ""),
			profileIds(),
		);
		if (competitor && competitor !== snapshot.id) {
			notes.push(
				`${snapshot.label}: this process already maps roles to ${competitor.toUpperCase()} ` +
					"(another session is active on it)",
			);
		}
		log.info(
			`role mapping for ${snapshot.id}: ${Object.keys(roles.mapped).length} role(s), ` +
				`${Object.keys(agents.mapped).length} task agent override(s)`,
		);
	};

	const entriesOf = (ctx: ExtensionContext): { type: string; customType?: string; data?: unknown }[] => {
		try {
			return ctx.sessionManager?.getEntries() ?? [];
		} catch (err) {
			log.debug("session entries unavailable:", (err as Error).message);
			return [];
		}
	};

	const persistBinding = (snapshot: ProfileSnapshot, api: ExtensionAPI = runtimeApi()): void => {
		try {
			api.appendEntry(PROFILE_ENTRY_TYPE, profileEntryData(snapshot));
		} catch (err) {
			log.debug("could not persist the session profile binding:", (err as Error).message);
		}
	};

	/** Resolve and store the immutable binding for a session. */
	const bindSession = async (
		ctx: ExtensionContext,
		opts: { allowNetwork?: boolean; api?: ExtensionAPI } = {},
	): Promise<BindResult> => {
		const api = opts.api ?? runtimeApi();
		const sessionKey = sessionIdOf(ctx) ?? ROOT_SESSION_KEY;
		const existing = bindings.get(sessionKey);
		if (existing) {
			// Provider registration belongs to the host SESSION, not to this
			// process: a new session (or a reloaded one) starts with an empty
			// registry, so the environment has to be re-established even when the
			// binding already exists — through THIS session's handle.
			existing.api = api;
			const snapshot = snapshotFor(existing, sessionKey);
			await ensureRegistrations(snapshot, { ...opts, api });
			await applyRoleMapping(snapshot);
			await alignModelWithBinding(ctx, snapshot, api);
			return { snapshot, changed: false, legacy: existing.source === "legacy", blocked: null };
		}

		const entries = entriesOf(ctx);
		// Plain provider names identify no environment by themselves. A child
		// inherits the environment of the live parent binding; a main session uses
		// its persisted entry or the resumed/launch seed.
		const isChild = agentKindOf(ctx) === "sub";
		const liveProfiles = new Set([...bindings.values()].map((candidate) => candidate.id));
		const parentBinding = topLevelKey ? bindings.get(topLevelKey) : undefined;
		const inheritedProfile = !isChild
			? null
			: (parentBinding?.id ??
				(liveProfiles.size === 1
					? [...liveProfiles][0]!
					: liveProfiles.size === 0
						? (root?.id ?? null)
						: null));
		const picked = pickProfileForSession({
			persisted: persistedProfile(entries),
			// A resumed session file with conversation content is the only legacy
			// shape; a brand-new session may already hold host bookkeeping entries
			// (model_change/thinking_level_change/session_init) before session_start,
			// and those must not pin it to prod. `isSessionOnDisk` distinguishes
			// the two when the host exposes it.
			hasHistory: sessionHasHistory(entries) && sessionIsDurable(ctx) !== false,
			// Authoritative origin for a child: the environment its own model is
			// on (its spawn chose that environment). The registry is only a hint
			// and only when a single environment is live in this process.
			modelOrigin: profileFromCurrentModel(currentModelProvider(ctx), profileIds()),
			registryOrigin: inheritedProfile,
			isChild: agentKindOf(ctx) === "sub",
			root,
			rootProblem,
		});
		if (!picked.seed || picked.problem) {
			// Fail closed: report the environment that could not be used and
			// register nothing. A session is never moved to another environment
			// because the requested one is missing, and no config or credential is
			// resolved for an environment we have just refused.
			const problem = picked.problem;
			log.error(
				`environment "${problem?.requested ?? "(unknown)"}" is unusable for session ${sessionKey}: ` +
					`${problem?.reason}`,
			);
			return { snapshot: null, changed: false, legacy: false, blocked: problem };
		}
		// A new or different top-level session replaces the previous one in this
		// process: retire it so its environment's providers are handed back
		// instead of lingering in the shared registry forever.
		if (agentKindOf(ctx) !== "sub" && topLevelKey && topLevelKey !== sessionKey) {
			await retireSession(topLevelKey, "replaced by a newer session");
		}
		const binding: SessionBinding = {
			id: picked.seed.id,
			source: picked.seed.source,
			generation: nextGeneration(),
			api,
		};
		bindings.set(sessionKey, binding);
		// The startup seed is not a session: once a real session binds, it must not
		// count as a live holder of that environment's providers (it would keep
		// the launch environment's models in the menu forever).
		if (sessionKey !== ROOT_SESSION_KEY) bindings.delete(ROOT_SESSION_KEY);
		if (agentKindOf(ctx) !== "sub") topLevelKey = sessionKey;
		const snapshot = snapshotFor(binding, sessionKey);
		if (binding.source === "legacy") {
			log.info(`session predates profiles — keeping it on ${snapshot.label} (${snapshot.origin})`);
		}
		if (binding.source === "inherited") {
			log.info(`session inherits ${snapshot.label} (${snapshot.origin}) from its parent`);
		}
		if (persistedProfile(entries).id !== snapshot.id) persistBinding(snapshot, api);
		await ensureRegistrations(snapshot, { ...opts, api });
		await applyRoleMapping(snapshot);
		// The environment a session is bound to also owns its selected model: if
		// the model still names another environment (a resumed session started
		// with --model for a different one, or a new conversation prepared by a
		// switch), move it onto this environment — or say it cannot be served.
		await alignModelWithBinding(ctx, snapshot, api);
		// A resumed session may store a selector whose provider was renamed or
		// whose former AGP namespace no longer exists. Restore it on this
		// environment through a normal model change, never by rewriting history.
		await adoptStoredSessionModel(pi, ctx, snapshot, catalogs.get(snapshot.id), profileIds());
		return { snapshot, changed: true, legacy: binding.source === "legacy", blocked: null };
	};

	/** Register this environment's providers when missing (cache first). */
	const ensureRegistrations = async (
		snapshot: ProfileSnapshot,
		opts: { allowNetwork?: boolean; api?: ExtensionAPI },
	): Promise<void> => {
		const api = opts.api ?? runtimeApi();
		// Always register into the current host session. The catalogue map only
		// tells us what we know ABOUT an environment, never that some other
		// session's registry already has it — `ctx.newSession()` and a reloaded
		// session begin with an empty registry, and skipping there produced
		// "No API key found for agp-<env>-<base>" on the first prompt.
		const cached = readDiscoveryCache(snapshot.paths, snapshot.discoveryScope);
		if (cached) {
			registerDiscovery(snapshot, cached.discovery);
			await applySnapshot(snapshot, cached.discovery, api);
			return;
		}
		if (!snapshot.apiKey || opts.allowNetwork === false) {
			log.warn(
				`no cached discovery for ${snapshot.id}${opts.allowNetwork === false ? " (offline run)" : ""} — ` +
					"providers not registered for this session",
			);
			return;
		}
		try {
			const fresh = await fetchDiscovery(snapshot.cfg, snapshot.apiKey, snapshot.paths);
			registerDiscovery(snapshot, fresh);
			await applySnapshot(snapshot, fresh, api);
		} catch (err) {
			log.warn(`discovery for ${snapshot.id} failed:`, (err as Error).message);
		}
	};

	const snapshotFor = (binding: SessionBinding, sessionKey: string): ProfileSnapshot =>
		buildSnapshot({ id: binding.id, source: binding.source }, sessionKey, binding.generation);

	const rootSnapshot = (api: ExtensionAPI = runtimeApi()): ProfileSnapshot | null => {
		const existing = bindings.get(ROOT_SESSION_KEY);
		if (existing) {
			existing.api = api;
			return snapshotFor(existing, ROOT_SESSION_KEY);
		}
		if (!root) {
			// Blocked launch: there is no environment to describe, and describing
			// one would resolve a config we have refused to use.
			return null;
		}
		const binding: SessionBinding = {
			id: root.id,
			source: root.source,
			generation: nextGeneration(),
			api,
		};
		bindings.set(ROOT_SESSION_KEY, binding);
		return snapshotFor(binding, ROOT_SESSION_KEY);
	};

	const snapshotForContext = (ctx: ExtensionContext): ProfileSnapshot | null => {
		const key = sessionIdOf(ctx) ?? ROOT_SESSION_KEY;
		const binding = bindings.get(key);
		return binding ? snapshotFor(binding, key) : rootSnapshot();
	};

	const isCurrent = (snapshot: ProfileSnapshot): boolean => {
		const binding = bindings.get(snapshot.sessionKey);
		return !!binding && binding.id === snapshot.id && binding.generation === snapshot.generation;
	};

	const reportStatus = (ctx: ExtensionContext, snapshot: ProfileSnapshot): void => {
		// One writer owns the footer: it keeps the same profile's quota and
		// drops a previous profile's quota on a switch.
		reportFooter(ctx, { id: snapshot.id, sessionKey: snapshot.sessionKey });
	};

	/**
	 * Keep the selected model on the environment the session is bound to.
	 *
	 * The model is planned against this environment's catalogue (a prepared
	 * conversation switch commits its own selector in `commitConversationSwitch`).
	 * A model that cannot be served here is reported — the persisted environment
	 * wins over a `--model` from another one — and never kept on a foreign
	 * transport silently.
	 */
	const alignModelWithBinding = async (
		ctx: ExtensionContext,
		snapshot: ProfileSnapshot,
		api: ExtensionAPI,
	): Promise<void> => {
		const catalog = catalogs.get(snapshot.id);
		if (!catalog) return;
		const plan = planModelMove(ctx, snapshot, catalog, profileIds());
		if (plan.kind === "move") {
			const moved = await applyModelChange(api, ctx, plan.selector, snapshot.label);
			if (!moved) log.warn(`could not align the session model with ${snapshot.id}`);
			return;
		}
		if (plan.kind === "impossible") {
			const message =
				`this session is bound to ${snapshot.label}, which does not serve its model ` +
				`${plan.selector}; pick a model on this environment`;
			log.warn(message);
			if (ctx.hasUI) {
				try {
					ctx.ui.notify(`AI Gateway: ${message}`, "warning");
				} catch {
					/* notification is best effort */
				}
			}
		}
	};

	const endSession = async (ctx: ExtensionContext): Promise<void> => {
		if (agentKindOf(ctx) !== "sub") return;
		const key = sessionIdOf(ctx);
		if (!key) return;
		await retireSession(key, "subagent run finished");
	};

	let spawnsObserved = 0;

	const remapSpawn = (ctx: ExtensionContext, patterns: readonly string[]): SpawnRewrite => {
		// Counting here turns "the host has this event" into an observed fact
		// instead of an assumption from our side.
		spawnsObserved++;
		const key = sessionIdOf(ctx) ?? ROOT_SESSION_KEY;
		const binding = bindings.get(key);
		const catalog = binding ? catalogs.get(binding.id) : undefined;
		if (!catalog) return { patterns: [...patterns], changed: false };
		return remapSpawnPatterns(patterns, profileIds(), catalog);
	};

	interface PreparedSwitch {
		ok: true;
		target: ProfileSnapshot;
		discovery: Discovery;
		catalog: ProfileCatalog;
		plan: ModelMovePlan;
		previous: SessionBinding | undefined;
		previousSnapshot: ProfileSnapshot | undefined;
		stayingOn: string;
	}

	type SwitchPreparation = PreparedSwitch | { ok: false; message: string };

	/**
	 * Everything a switch needs, proven before anything is touched. Shared by the
	 * two switch shapes so neither can mutate state for a target that cannot
	 * serve this session.
	 */
	const prepareSwitch = async (
		ctx: ExtensionCommandContext,
		id: string,
	): Promise<SwitchPreparation> => {
		const registry = readRegistry();
		if (!registry.profiles[id]) return { ok: false, message: `unknown profile "${id}"` };
		const sessionKey = sessionIdOf(ctx);
		if (!sessionKey) return { ok: false, message: "this session has no id to bind" };
		const previous = bindings.get(sessionKey);
		if (previous?.id === id) return { ok: false, message: `this session is already on ${id.toUpperCase()}` };
		if (!ctx.isIdle()) {
			// A live turn would otherwise keep streaming on the old environment.
			return { ok: false, message: "not idle — finish or cancel the current turn, then switch" };
		}
		const stayingOn = previous ? describeProfile(snapshotFor(previous, sessionKey)) : "no environment";
		const target = buildSnapshot({ id, source: "switch" }, sessionKey, 0);
		if (!target.apiKey) {
			return {
				ok: false,
				message:
					`profile ${id.toUpperCase()} has no resolvable API key — run /cliproxy-setup while on it first ` +
					`(staying on ${stayingOn})`,
			};
		}
		let discovery: Discovery;
		try {
			discovery =
				readDiscoveryCache(target.paths, target.discoveryScope)?.discovery ??
				(await fetchDiscovery(target.cfg, target.apiKey, target.paths));
		} catch (err) {
			return {
				ok: false,
				message: `discovery for ${id} failed: ${(err as Error).message} (staying on ${stayingOn})`,
			};
		}
		let catalog: ProfileCatalog;
		try {
			catalog = buildProfileCatalog(target.cfg, discovery, id, profileIds());
			// Registration validation without side effects: namespaces and family
			// conflicts are rejected here, before any provider is registered.
			registrationConfig(target.cfg, discovery, id);
		} catch (err) {
			return {
				ok: false,
				message:
					`${id.toUpperCase()} cannot be registered: ${(err as Error).message} ` +
					`(staying on ${stayingOn})`,
			};
		}
		const plan = planModelMove(ctx, target, catalog, profileIds());
		if (plan.kind === "impossible") {
			return {
				ok: false,
				message:
					`${id.toUpperCase()} does not serve this session's model ${plan.selector}, and no automatic ` +
					`fallback is used — pick a model on this environment or stay put (still on ${stayingOn})`,
			};
		}
		return {
			ok: true,
			target,
			discovery,
			catalog,
			plan,
			previous,
			previousSnapshot: previous ? snapshotFor(previous, sessionKey) : undefined,
			stayingOn,
		};
	};

	/**
	 * A switch that starts a NEW conversation: the old conversation keeps its own
	 * environment, model and binding byte for byte, and the target is established
	 * only in the new session. The command starts the session; its own
	 * `session_start` applies the binding, registrations, roles and model.
	 */
	let pendingConversation: {
		target: string;
		selector: string | null;
		fromKey: string;
		snapshot: ProfileSnapshot;
		discovery: Discovery;
	} | null = null;

	const beginConversationSwitch = async (
		ctx: ExtensionCommandContext,
		id: string,
	): Promise<{ ok: boolean; message: string; target?: string }> => {
		const prepared = await prepareSwitch(ctx, id);
		if (!prepared.ok) return prepared;
		pendingConversation = {
			target: id,
			selector: prepared.plan.kind === "move" ? prepared.plan.selector : null,
			fromKey: sessionIdOf(ctx) ?? ROOT_SESSION_KEY,
			snapshot: prepared.target,
			discovery: prepared.discovery,
		};
		return {
			ok: true,
			target: id,
			message:
				`starting a new conversation on ${describeProfile(prepared.target)}; ` +
				`this conversation stays on ${prepared.stayingOn}`,
		};
	};

	const cancelConversationSwitch = (): void => {
		pendingConversation = null;
	};

	/**
	 * Establish the prepared target on the conversation the host actually
	 * started. The old conversation is never touched: only this new session's
	 * binding, registrations, roles and model change.
	 */
	const commitConversationSwitch = async (
		ctx: ExtensionCommandContext,
		api: ExtensionAPI = runtimeApi(),
	): Promise<{ ok: boolean; message: string }> => {
		const pending = pendingConversation;
		pendingConversation = null;
		const currentKey = sessionIdOf(ctx);
		if (!pending) {
			// A session whose origin already resolved the target needs no commit.
			const current = currentKey ? bindings.get(currentKey) : undefined;
			if (current && currentKey && currentKey !== ROOT_SESSION_KEY) {
				return {
					ok: true,
					message: `new conversation on ${describeProfile(snapshotFor(current, currentKey))}`,
				};
			}
			return { ok: false, message: "no environment switch was prepared" };
		}
		const sessionKey = currentKey;
		if (!sessionKey || sessionKey === pending.fromKey) {
			return {
				ok: false,
				message: "the new conversation did not start — this conversation was not changed",
			};
		}
		const existing = bindings.get(sessionKey);
		const next: SessionBinding = {
			id: pending.target,
			source: "switch",
			generation: nextGeneration(),
			api,
		};
		bindings.set(sessionKey, next);
		const snapshot = snapshotFor(next, sessionKey);
		let failure: string | null = null;
		let report: ApplyReport | undefined;
		try {
			registerDiscovery(snapshot, pending.discovery);
			report = await applySnapshot(snapshot, pending.discovery, api);
			await applyRoleMapping(snapshot);
			if (pending.selector && !(await applyModelChange(api, ctx, pending.selector, snapshot.label))) {
				failure = `this host would not select ${pending.selector}`;
			}
		} catch (err) {
			failure = (err as Error).message;
		}
		if (failure) {
			// The new conversation is already on disk; put its own binding back so it
			// is never left labelled with a target it could not take.
			if (existing) bindings.set(sessionKey, existing);
			else bindings.delete(sessionKey);
			const back = existing ? discoveryByProfile.get(existing.id) : undefined;
			if (existing && back) {
				const backSnapshot = snapshotFor(existing, sessionKey);
				try {
					registerDiscovery(backSnapshot, back);
					await applyRoleMapping(backSnapshot);
					await applySnapshot(backSnapshot, back, api);
					reportStatus(ctx, backSnapshot);
				} catch (err) {
					log.error("could not restore the new conversation's binding:", (err as Error).message);
				}
			}
			log.error(`new conversation left on its own environment: ${failure}`);
			return { ok: false, message: `the new conversation could not move to ${pending.target.toUpperCase()}: ${failure}` };
		}
		if (persistedProfile(entriesOf(ctx)).id !== snapshot.id) persistBinding(snapshot, api);
		reportStatus(ctx, snapshot);
		log.info(`new conversation ${sessionKey} established on ${snapshot.id}`);
		return {
			ok: true,
			message: `new conversation on ${snapshot.label} — ${report ? describeApply(report) : "providers registered"}`,
		};
	};

	const switchEnvironment = async (
		ctx: ExtensionCommandContext,
		id: string,
		api: ExtensionAPI = runtimeApi(),
	): Promise<{ ok: boolean; message: string }> => {
		const prepared = await prepareSwitch(ctx, id);
		if (!prepared.ok) return prepared;
		const { discovery, plan, previous, previousSnapshot, stayingOn } = prepared;
		const sessionKey = sessionIdOf(ctx) ?? ROOT_SESSION_KEY;

		// -------- phase 2: move the session, with compensation on failure
		const previousModel = ctx.models?.current?.() ?? ctx.model;
		const next: SessionBinding = { id, source: "switch", generation: nextGeneration(), api };
		bindings.set(sessionKey, next);
		const snapshot = snapshotFor(next, sessionKey);
		let failure: string | null = null;
		let report: ApplyReport | undefined;
		try {
			registerDiscovery(snapshot, discovery);
			report = await applySnapshot(snapshot, discovery, api);
			await applyRoleMapping(snapshot);
			if (plan.kind === "move" && !(await applyModelChange(api, ctx, plan.selector, snapshot.label))) {
				failure = `this host would not select ${plan.selector}`;
			}
		} catch (err) {
			failure = (err as Error).message;
		}

		if (failure) {
			// Restore the environment the session had: binding, roles, provider
			// registrations and selected model, so it cannot be left labelled with
			// the target while dispatching on the old transport.
			if (previous) bindings.set(sessionKey, previous);
			else bindings.delete(sessionKey);
			if (previousSnapshot) {
				try {
					await applyRoleMapping(previousSnapshot);
				} catch (err) {
					log.warn("could not restore the previous role mapping:", (err as Error).message);
				}
				const registered = discoveryByProfile.get(previousSnapshot.id);
				if (registered) {
					try {
						registerDiscovery(previousSnapshot, registered);
						await applySnapshot(previousSnapshot, registered, api);
					} catch (err) {
						log.error("could not restore the previous registrations:", (err as Error).message);
					}
				}
				reportStatus(ctx, previousSnapshot);
				if (previousModel) {
					try {
						await api.setModel(previousModel);
					} catch (err) {
						log.warn("could not restore the previous model:", (err as Error).message);
					}
				}
			}
			log.error(`switch to ${id} rolled back: ${failure}`);
			return {
				ok: false,
				message: `switch to ${id.toUpperCase()} failed and was rolled back: ${failure} (still on ${stayingOn})`,
			};
		}

		persistBinding(snapshot, api);
		reportStatus(ctx, snapshot);
		log.info(`session ${sessionKey} switched to ${snapshot.id} (generation ${snapshot.generation})`);
		return {
			ok: true,
			message:
				`now on ${describeProfile(snapshot)} — ` +
				(report ? describeApply(report) : "providers registered"),
		};
	};

	return {
		root,
		rootProblem,
		settings,
		profileIds,
		knownProfiles: () => [...catalogs.keys()],
		catalogFor: (profile) => catalogs.get(profile),
		registerDiscovery,
		applySnapshot,
		applyRoleMapping,
		roleMappingNotes: () => [...notes],
		bindSession,
		snapshotFor: snapshotForContext,
		rootSnapshot,
		bindingFor: (sessionKey) => bindings.get(sessionKey),
		isCurrent,
		reportStatus,
		remapSpawn,
		endSession,
		rebind: (api) => {
			ownApi = api;
		},
		beginConversationSwitch,
		cancelConversationSwitch,
		commitConversationSwitch,
		spawnObservations: () => spawnsObserved,
		switchEnvironment,
	};
}

/**
 * One runtime per process. Commands, event handlers and the factory all depict
 * the same sessions, so they must share bindings, catalogues and notes. Two
 * runtimes remain independent: each owns its own seeds, bindings and
 * generations (used by embedding hosts and by the regression test for that
 * separation).
 */
let shared: SessionRuntime | undefined;
export function runtimeFor(pi: ExtensionAPI): SessionRuntime {
	// The factory runs again for every host session (new conversation, rebind),
	// so the runtime adopts the newest handle for future registrations.
	if (!shared) return (shared = createSessionRuntime(pi));
	shared.rebind(pi);
	return shared;
}
