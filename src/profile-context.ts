// Which AGP environment is a session on, and everything that follows from it.
//
// This module is deliberately stateless. A profile is *resolved* by the session
// runtime that owns the session (see session-runtime.ts) and then held for that
// session's whole life: providers are registered from that profile's discovery,
// caches are read and written under that profile's directory, and the
// credential used at the final fetch belongs to that profile.
//
// Resolution inputs, in order of authority:
//   1. the profile this session was already bound to (persisted as a session
//      entry, so a resume stays on its own environment);
//   2. `prod` for a session that already has history but no binding — those are
//      sessions created before profiles existed, when there was one endpoint;
//   3. the environment the session's inherited provider registry actually
//      serves (`agp-<profile>-*` names). In-process child sessions share their
//      parent's registry, so this is how a child inherits the environment
//      explicitly instead of through any process-global variable;
//   4. the launch seed — `AGP_PROFILE`, or the `--agp-profile` flag once the
//      host has parsed extension flags — else the registry default.
//
// Nothing here mutates OMP's own profile/agent directories, and nothing here
// writes `process.env`: the environment variable is read, never used as state.

import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";

import { cacheScope } from "./cache-scope.ts";
import { type ProxyConfig, loadConfig, resolveConfigValue } from "./config.ts";
import { PREFERRED_CONTRACT } from "./fetch-usage.ts";
import { log } from "./log.ts";
import { DEFAULT_PROFILE, type ProfilePaths, isValidProfileId, profilePaths, readRegistry } from "./profiles.ts";
import { ensureProfileLayout } from "./profiles-migration.ts";

/** Extension flag usable as `omp --agp-profile test`. */
export const PROFILE_FLAG = "agp-profile";
/** Launch selection, read once as a seed; never treated as live state. */
export const PROFILE_ENV = "AGP_PROFILE";
/** Session entry that binds a session file to its environment. */
export const PROFILE_ENTRY_TYPE = "com.37b.agp.profile";

/** How a session's environment was reached; shown in status/diagnostics. */
export type ProfileSource =
	| "session"
	| "legacy"
	| "inherited"
	| "launch-env"
	| "launch-flag"
	| "default"
	| "switch";

/** A profile choice before it is bound to a session. */
export interface ProfileSeed {
	id: string;
	source: ProfileSource;
}

export interface ProfileSnapshot {
	id: string;
	label: string;
	source: ProfileSource;
	/** Session this snapshot belongs to; "root" for pre-session work. */
	sessionKey: string;
	/** Bumped whenever that session's environment changes. */
	generation: number;
	paths: ProfilePaths;
	endpoint: string;
	/** Host portion of the endpoint, for status/diagnostics. */
	origin: string;
	cfg: ProxyConfig;
	/** Resolved credential for model calls. Never logged, never persisted. */
	apiKey: string;
	resolvedUsageKey: string;
	discoveryScope: string;
	usageScope: string;
}

/** Why a requested environment cannot be used; surfaced verbatim to the user. */
export interface ProfileProblem {
	requested: string;
	reason: string;
}

function problem(requested: string, reason: string): ProfileProblem {
	return { requested, reason };
}

function knownProfileId(id: string): boolean {
	return isValidProfileId(id) && !!readRegistry().profiles[id];
}

/**
 * The launch selection: the parsed `--agp-profile` flag when the host has it,
 * else `AGP_PROFILE`.
 *
 * A request that names an environment this machine does not have is an ERROR,
 * never a fallback: silently starting on another environment would send a
 * session's requests, quota and cache to an environment the user did not ask
 * for. Only "nothing was requested" leaves the default in play.
 */
export interface LaunchDecision {
	seed: ProfileSeed | null;
	/** Set when the request itself cannot be honoured. */
	problem: ProfileProblem | null;
}

export function launchDecision(getFlag: (name: string) => boolean | string | undefined): LaunchDecision {
	const flag = getFlag(PROFILE_FLAG);
	if (typeof flag === "string" && flag.trim()) return decisionFor(flag.trim(), "launch-flag");
	if (flag === true) {
		return {
			seed: null,
			problem: problem("(flag)", `--${PROFILE_FLAG} needs a profile name`),
		};
	}
	const fromEnv = process.env[PROFILE_ENV]?.trim();
	if (fromEnv) return decisionFor(fromEnv, "launch-env");
	return { seed: null, problem: null };
}

function decisionFor(requested: string, source: ProfileSeed["source"]): LaunchDecision {
	if (!isValidProfileId(requested)) {
		return {
			seed: null,
			problem: problem(requested, `"${requested}" is not a valid environment name`),
		};
	}
	if (!readRegistry().profiles[requested]) {
		return {
			seed: null,
			problem: problem(
				requested,
				`environment "${requested}" is not configured on this machine ` +
					`(known: ${Object.keys(readRegistry().profiles).join(", ")})`,
			),
		};
	}
	return { seed: { id: requested, source }, problem: null };
}

export function defaultSeed(): ProfileSeed {
	return { id: readRegistry().defaultProfile, source: "default" };
}

/**
 * The environment a conversation being resumed by this process was saved on.
 *
 * OMP restores the model before session_start, so providers must be registered
 * for the right environment before that. An explicit `--resume/-r` path is read
 * directly; `--continue/-c` and auto-resume use the newest top-level session in
 * the working directory. A session with history but no profile entry predates
 * profiles and belongs to prod. Unknown paths return null; the launch/default
 * seed then applies.
 */
export function resumedProfileSeed(
	argv: readonly string[] = process.argv,
	cwd: string = process.cwd(),
): ProfileSeed | null {
	const explicit = (() => {
		for (let i = 0; i < argv.length; i++) {
			const arg = argv[i]!;
			if (arg === "--resume" || arg === "-r") {
				const value = argv[i + 1];
				return value && !value.startsWith("-") ? value : null;
			}
			if (arg.startsWith("--resume=")) return arg.slice("--resume=".length) || null;
		}
		return null;
	})();
	const path = explicit ?? latestSessionFile(cwd);
	if (!path) return null;
	let profile: string | null = null;
	let record: ProfileBindingRecord | undefined;
	let history = false;
	try {
		for (const line of readFileSync(path, "utf8").split("\n")) {
			if (!line) continue;
			let entry: { type?: string; customType?: string; data?: Partial<ProfileBindingRecord> };
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (entry.type === "custom" && entry.customType === PROFILE_ENTRY_TYPE) {
				const value = entry.data?.profile;
				if (typeof value === "string") {
					profile = value;
					record = entry.data as ProfileBindingRecord;
				}
			}
			if (entry.type === "message" || entry.type === "compaction" || entry.type === "branch_summary") {
				history = true;
			}
		}
	} catch {
		return null;
	}
	// A binding refused by the profile's replacement boundary is not a launch
	// seed: registering that environment before the session exists would leave
	// its providers reachable even though session binding fails closed.
	if (profile && isValidProfileId(profile) && readRegistry().profiles[profile] && !bindingProblem(profile, record)) {
		return { id: profile, source: "session" };
	}
	if (history) return { id: DEFAULT_PROFILE, source: "legacy" };
	return null;
}

/** Newest top-level session OMP would auto-resume for this working directory. */
function latestSessionFile(cwd: string): string | null {
	const home = homedir();
	let relative = "";
	if (cwd === home) relative = "";
	else if (cwd.startsWith(`${home}${sep}`)) relative = cwd.slice(home.length + 1);
	else relative = cwd.replace(/^[/\\]+/, "");
	const slug = `-${relative.split(/[/\\]+/).join("-")}`;
	const dir = join(home, ".omp", "agent", "sessions", slug);
	try {
		const newest = readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
			.map((entry) => ({ path: join(dir, entry.name), mtime: statSync(join(dir, entry.name)).mtimeMs }))
			.sort((a, b) => b.mtime - a.mtime)[0];
		return newest?.path ?? null;
	} catch {
		return null;
	}
}

/**
 * Why a persisted binding cannot be used on this machine, or null when it can.
 * Only profiles that declare a replacement boundary enforce it; a missing
 * origin/incarnation is stale there, never silently upgraded to the new route.
 */
function bindingProblem(found: string, record: ProfileBindingRecord | undefined): ProfileProblem | null {
	const descriptor = readRegistry().profiles[found];
	if (descriptor?.bindingIncarnation === undefined) return null;
	const current = currentBindingIdentity(found);
	if (record?.incarnation === descriptor.bindingIncarnation && record?.origin === current.origin) return null;
	return problem(
		found,
		`this conversation was bound to ${found.toUpperCase()} at ${record?.origin ?? "an earlier endpoint"}, before that ` +
			`environment was replaced by ${current.origin}; continuing this history there is refused. Start a new ` +
			`conversation with /cliproxy-profile ${found}, or deliberately move this one with ` +
			`/cliproxy-profile ${found} --keep-history.`,
	);
}

/**
 * The profile this session file was bound to, if the plugin wrote one.
 *
 * An unknown binding is reported as a problem rather than dropped: a resumed
 * session must not quietly continue on whatever the default happens to be.
 */
export function persistedProfile(
	entries: readonly { type: string; customType?: string; data?: unknown }[],
): { id: string | null; problem: ProfileProblem | null } {
	// The newest binding entry wins: a deliberate `--keep-history` move appends a
	// new record after the historical one, and that record is the session's route.
	let found: string | null = null;
	let record: ProfileBindingRecord | undefined;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== PROFILE_ENTRY_TYPE) continue;
		const data = entry.data as ProfileBindingRecord | undefined;
		if (typeof data?.profile === "string") {
			found = data.profile;
			record = data;
		}
	}
	if (!found) return { id: null, problem: null };
	if (!isValidProfileId(found) || !readRegistry().profiles[found]) {
		return {
			id: null,
			problem: problem(
				found,
				`this session is bound to environment "${found}", which is not configured on this machine`,
			),
		};
	}
	const stale = bindingProblem(found, record);
	if (stale) return { id: null, problem: stale };
	return { id: found, problem: null };
}

/**
 * Entry types that only record host bookkeeping, never a conversation.
 *
 * A static membership table: these are the host's own entry type names, fixed
 * at author time, so a plain record is the right shape (and it keeps the
 * "is this type bookkeeping?" check a single property read).
 */
const BOOKKEEPING_ENTRY_TYPES: Readonly<Record<string, true>> = {
	model_change: true,
	model_usage: true,
	thinking_level_change: true,
	service_tier_change: true,
	mode_change: true,
	title_change: true,
	label: true,
	custom: true,
	custom_message: true,
	session_init: true,
	ttsr_injection: true,
	credential_pin: true,
	reset_boundary: true,
};

/**
 * Whether a session already carries a conversation.
 *
 * Only real conversation counts. A brand-new session is written with host
 * bookkeeping before `session_start` — 18.11.1 appends a `model_change` (and
 * usually `thinking_level_change`/`session_init`) as soon as it resolves a
 * model — so treating those as history would classify every new session as a
 * pre-profile one and pin it to prod, ignoring the environment the user asked
 * for. Sessions created before profiles existed do have conversation entries,
 * and those must not be dragged onto another environment by a launch default.
 */
export function sessionHasHistory(entries: readonly { type: string }[]): boolean {
	return entries.some(
		(entry) =>
			entry.type === "message" ||
			entry.type === "compaction" ||
			entry.type === "branch_summary",
	);
}

/** Whether the session already exists on disk (a resumed session, not a new one). */
export function sessionIsDurable(ctx: ExtensionContext): boolean | undefined {
	try {
		const manager = ctx.sessionManager as { isSessionOnDisk?: () => boolean } | undefined;
		return typeof manager?.isSessionOnDisk === "function" ? manager.isSessionOnDisk() : undefined;
	} catch (err) {
		log.debug("could not read session durability:", (err as Error).message);
		return undefined;
	}
}

/** Bookkeeping-only entries, exposed for diagnostics/tests. */
export function isBookkeepingEntry(entry: { type: string }): boolean {
	return BOOKKEEPING_ENTRY_TYPES[entry.type] === true;
}

/**
 * Which environment a registry's names belong to, derived from the names the
 * plugin registered (`agp-<profile>-<base>`).
 *
 * Only usable when exactly one environment is present: one process holds one
 * provider registry, and while a session from an earlier environment is still
 * alive both environments' providers stay registered, so more than one match
 * means the registry cannot answer the question at all.
 */
export function profileFromRegisteredNames(
	providerNames: readonly string[],
	profileIds: readonly string[],
): string | null {
	const seen = new Set<string>();
	for (const name of providerNames) {
		const prefix = "agp-";
		if (!name.startsWith(prefix)) continue;
		const rest = name.slice(prefix.length);
		const match = [...profileIds]
			.sort((a, b) => b.length - a.length)
			.find((id) => rest.startsWith(`${id}-`));
		if (match) seen.add(match);
	}
	if (seen.size === 1) return [...seen][0]!;
	if (seen.size > 1) {
		log.debug(
			`this process currently serves ${[...seen].join(" and ")}; ` +
				"an inherited registry can no longer name a single environment",
		);
	}
	return null;
}

/** The environment of a session's own current model, when it names one. */
export function profileFromCurrentModel(
	modelProvider: string | undefined,
	profileIds: readonly string[],
): string | null {
	if (!modelProvider) return null;
	const base = "agp-";
	if (!modelProvider.startsWith(base)) return null;
	const rest = modelProvider.slice(base.length);
	const match = [...profileIds]
		.sort((a, b) => b.length - a.length)
		.find((id) => rest.startsWith(`${id}-`));
	if (!match) return null;
	if (!readRegistry().profiles[match]) return null;
	return match;
}

/**
 * This session's own current model provider, read from the host's live model
 * query (falling back to the context's model snapshot). A subagent's model is
 * chosen by its spawn, so this is the authoritative statement of which
 * environment the child was started on — including after the parent switched,
 * when several environments are registered in the same process.
 */
export function currentModelProvider(ctx: ExtensionContext): string | undefined {
	try {
		const current = ctx.models?.current?.();
		if (current?.provider) return current.provider;
	} catch (err) {
		log.debug("model query unavailable:", (err as Error).message);
	}
	return ctx.model?.provider;
}

/** Whether this session is a subagent (children cannot guess their origin). */
export function agentKindOf(ctx: ExtensionContext): "main" | "sub" | undefined {
	const agent = (ctx as { agent?: { kind?: unknown } }).agent;
	const kind = agent?.kind;
	return kind === "main" || kind === "sub" ? kind : undefined;
}

export interface SessionProfileDecision {
	seed: ProfileSeed | null;
	problem: ProfileProblem | null;
}

/**
 * Which environment a session runs on, or why none can be chosen.
 *
 * A requested-but-missing environment (explicit launch request, or a persisted
 * binding) stops the decision — it never degrades into another environment. The
 * default is reached only when nothing was requested and nothing was bound.
 */
export function pickProfileForSession(input: {
	persisted: { id: string | null; problem: ProfileProblem | null };
	hasHistory: boolean;
	/** Environment named by this session's own current model, when it names one. */
	modelOrigin: string | null;
	/** Environment implied by an inherited registry with exactly one present. */
	registryOrigin: string | null;
	/** True for subagent sessions, which must never guess an environment. */
	isChild: boolean;
	root: ProfileSeed | null;
	rootProblem: ProfileProblem | null;
}): SessionProfileDecision {
	if (input.persisted.problem) return { seed: null, problem: input.persisted.problem };
	if (input.persisted.id) return { seed: { id: input.persisted.id, source: "session" }, problem: null };
	if (input.isChild) {
		// A child is created by the environment its parent is on right now, so
		// its own model names it (the parent's spawn patterns are rewritten for
		// that environment). An ambiguous registry is NOT evidence: with two
		// environments live in one process, names cannot say which one a child
		// came from, and guessing the launch seed would silently move it.
		if (input.modelOrigin) return { seed: { id: input.modelOrigin, source: "inherited" }, problem: null };
		if (input.registryOrigin) return { seed: { id: input.registryOrigin, source: "inherited" }, problem: null };
		return {
			seed: null,
			problem: problem(
				"subagent",
				"this subagent's environment could not be determined (its model names none of the " +
					"configured environments and several are live in this process); it will not be " +
					"started on a guessed environment",
			),
		};
	}
	if (input.hasHistory) return { seed: { id: DEFAULT_PROFILE, source: "legacy" }, problem: null };
	if (input.modelOrigin) return { seed: { id: input.modelOrigin, source: "inherited" }, problem: null };
	if (input.registryOrigin) return { seed: { id: input.registryOrigin, source: "inherited" }, problem: null };
	if (input.root) return { seed: input.root, problem: null };
	return { seed: null, problem: input.rootProblem };
}

/**
 * Cache scopes for one environment, or empty scopes when its endpoint is not a
 * usable URL. An empty scope never matches a stored cache, so an unusable
 * profile degrades to "no cached discovery" instead of throwing while a caller
 * is only trying to describe it.
 */
function scopesFor(endpoint: string, apiKey: string, usageKey: string): { discovery: string; usage: string } {
	try {
		return {
			discovery: cacheScope(endpoint, apiKey, PREFERRED_CONTRACT),
			usage: cacheScope(endpoint, apiKey, PREFERRED_CONTRACT, usageKey),
		};
	} catch (err) {
		log.debug("profile endpoint is not usable for cache scoping:", (err as Error).message);
		return { discovery: "", usage: "" };
	}
}

/** Everything one environment contributes to a session, captured at once. */
export function buildSnapshot(seed: ProfileSeed, sessionKey: string, generation: number): ProfileSnapshot {
	ensureProfileLayout();
	const paths = profilePaths(seed.id);
	const cfg = loadConfig(seed.id, paths);
	const apiKey = resolveConfigValue(cfg.proxy.apiKey);
	const resolvedUsageKey = resolveConfigValue(cfg.proxy.usageKey);
	const registry = readRegistry();
	const scopes = scopesFor(cfg.proxy.endpoint, apiKey, resolvedUsageKey);
	return {
		id: seed.id,
		label: registry.profiles[seed.id]?.label ?? seed.id.toUpperCase(),
		source: seed.source,
		sessionKey,
		generation,
		paths,
		endpoint: cfg.proxy.endpoint,
		origin: originOf(cfg.proxy.endpoint),
		cfg,
		apiKey,
		resolvedUsageKey,
		discoveryScope: scopes.discovery,
		usageScope: scopes.usage,
	};
}

export function originOf(endpoint: string): string {
	try {
		return new URL(endpoint).origin;
	} catch {
		return endpoint || "(unset)";
	}
}

/** `PROD · agp.37b.io` — the identity shown in the footer and the hub. */
export function describeProfile(snapshot: ProfileSnapshot): string {
	return `${snapshot.label} \u00b7 ${snapshot.origin}`;
}

/**
 * The binding identity a session entry records: the profile it names plus the
 * route it was bound to (`origin`) and, when the profile declares a replacement
 * boundary, the incarnation that boundary belongs to.
 */
export interface ProfileBindingRecord {
	profile: string;
	boundAt: string;
	origin?: string;
	incarnation?: string;
}

/** Current route identity of a profile; `incarnation` is unset until the owner declares a boundary. */
function currentBindingIdentity(id: string): { origin: string; incarnation?: string } {
	const incarnation = readRegistry().profiles[id]?.bindingIncarnation;
	return { origin: originOf(loadConfig(id, profilePaths(id)).proxy.endpoint), incarnation };
}

/** Session entry payload for this plugin's binding. */
export function profileEntryData(target: { id: string }): ProfileBindingRecord {
	const identity = currentBindingIdentity(target.id);
	return {
		profile: target.id,
		boundAt: new Date().toISOString(),
		origin: identity.origin,
		...(identity.incarnation ? { incarnation: identity.incarnation } : {}),
	};
}

/** Session id of a live context, when the host exposes one. */
export function sessionIdOf(ctx: ExtensionContext): string | undefined {
	try {
		return ctx.sessionManager?.getSessionId();
	} catch {
		return undefined;
	}
}

/** Provider names present in this session's registry, when the host exposes them. */
export function registeredProviderNames(ctx: ExtensionContext): string[] {
	try {
		const models = ctx.models?.list?.() ?? [];
		return models.map((model) => model.provider).filter((name): name is string => !!name);
	} catch (err) {
		log.debug("model list unavailable for environment inheritance:", (err as Error).message);
		return [];
	}
}
