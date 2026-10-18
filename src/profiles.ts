// Profile layout for the AI Gateway plugin.
//
// Historically the plugin had ONE endpoint and therefore ONE config file and
// ONE pair of discovery/usage caches, all under ~/.pi/agent/ai-gateway. Two
// environments (AGP prod and AGP test) must coexist in separate OMP sessions
// and even separate processes, so every piece of per-environment state is
// now addressed through a profile:
//
//   ~/.pi/agent/ai-gateway/profiles.json          registry (schemaVersion 1)
//   ~/.pi/agent/ai-gateway/profiles/<id>/config.json        ProxyConfig
//   ~/.pi/agent/ai-gateway/profiles/<id>/discovery-cache.json
//   ~/.pi/agent/ai-gateway/profiles/<id>/usage-cache.json
//   ~/.pi/agent/ai-gateway/profiles/<id>/usage-cache.lock
//   ~/.pi/agent/ai-gateway/profiles/<id>/omp.settings.yml   per-profile role overlay
//
// Rules encoded here:
//   * no profile can read, write or invalidate another profile's files —
//     not even when two processes run different profiles concurrently;
//   * every directory is 0700 and every secret-bearing file is 0600;
//   * the single pre-profile config and its scope-matching caches are migrated
//     once into the `prod` profile, never echoed and never duplicated.

import { randomUUID } from "node:crypto";
import {
	chmodSync,
	constants,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { log } from "./log.ts";

/** Shared plugin root. Profile-independent, so a shared credential file can live here. */
export const AGP_DIR = join(homedir(), ".pi", "agent", "ai-gateway");
export const REGISTRY_PATH = join(AGP_DIR, "profiles.json");
export const PROFILES_DIR = join(AGP_DIR, "profiles");

/** Directory/file modes for everything this plugin owns. */
export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

/** The pre-profile layout, kept only as migration input. */
export const LEGACY_CONFIG_PATH = join(AGP_DIR, "config.json");
export const LEGACY_DISCOVERY_CACHE_PATH = join(AGP_DIR, "discovery-cache.json");
export const LEGACY_USAGE_CACHE_PATH = join(AGP_DIR, "usage-cache.json");
export const LEGACY_USAGE_LOCK_PATH = join(AGP_DIR, "usage-cache.lock");

/** Profile used when nothing else selects one; also where legacy state lands. */
export const DEFAULT_PROFILE = "prod";

export interface ProfileDescriptor {
	label: string;
}

export interface ProfileRegistry {
	schemaVersion: 1;
	defaultProfile: string;
	profiles: Record<string, ProfileDescriptor>;
}

export const DEFAULT_REGISTRY: ProfileRegistry = {
	schemaVersion: 1,
	defaultProfile: DEFAULT_PROFILE,
	profiles: { prod: { label: "PROD" }, test: { label: "TEST" } },
};

/** Everything addressed per environment. All paths are absolute. */
export interface ProfilePaths {
	id: string;
	dir: string;
	configPath: string;
	discoveryCachePath: string;
	usageCachePath: string;
	usageLockPath: string;
	/** Generated OMP settings overlay carrying this profile's model-role mapping. */
	overlayPath: string;
}

const PROFILE_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** Profile ids double as directory names and provider-name segments. */
export function isValidProfileId(id: string): boolean {
	return typeof id === "string" && PROFILE_ID_RE.test(id) && id !== "." && id !== "..";
}

export function profilePaths(id: string): ProfilePaths {
	if (!isValidProfileId(id)) throw new Error(`Invalid profile id "${id}"`);
	const dir = join(PROFILES_DIR, id);
	return {
		id,
		dir,
		configPath: join(dir, "config.json"),
		discoveryCachePath: join(dir, "discovery-cache.json"),
		usageCachePath: join(dir, "usage-cache.json"),
		usageLockPath: join(dir, "usage-cache.lock"),
		overlayPath: join(dir, "omp.settings.yml"),
	};
}

export function ensureDir(dir: string): void {
	mkdirSync(dir, { recursive: true, mode: DIR_MODE });
	try {
		chmodSync(dir, DIR_MODE);
	} catch (err) {
		log.warn("failed to enforce directory mode on", dir, (err as Error).message);
	}
}

/** Write a file so it is never observable half-written and never world-readable. */
export function writePrivateFileAtomic(path: string, content: string): void {
	ensureDir(dirname(path));
	const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporaryPath, content, { encoding: "utf8", mode: FILE_MODE });
		chmodSync(temporaryPath, FILE_MODE);
		renameSync(temporaryPath, path);
	} catch (err) {
		try {
			rmSync(temporaryPath, { force: true });
		} catch {
			/* best effort */
		}
		throw err;
	}
}

/** Move a file, tolerating a cross-device rename, and clamp it to 0600. */
export function movePrivateFile(from: string, to: string): void {
	ensureDir(dirname(to));
	try {
		renameSync(from, to);
	} catch {
		copyFileSync(from, to, constants.COPYFILE_EXCL);
		rmSync(from, { force: true });
	}
	try {
		chmodSync(to, FILE_MODE);
	} catch {
		/* best effort */
	}
}

function normalizeRegistry(raw: unknown): ProfileRegistry | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	if (r.schemaVersion !== 1) return null;
	const profiles: Record<string, ProfileDescriptor> = {};
	const source = (r.profiles ?? {}) as Record<string, unknown>;
	for (const [id, descriptor] of Object.entries(source)) {
		if (!isValidProfileId(id)) continue;
		const label = (descriptor as ProfileDescriptor | undefined)?.label;
		profiles[id] = { label: typeof label === "string" && label.trim() ? label.trim() : id.toUpperCase() };
	}
	if (Object.keys(profiles).length === 0) return null;
	const defaultProfile =
		typeof r.defaultProfile === "string" && profiles[r.defaultProfile]
			? r.defaultProfile
			: DEFAULT_PROFILE in profiles
				? DEFAULT_PROFILE
				: Object.keys(profiles)[0]!;
	return { schemaVersion: 1, defaultProfile, profiles };
}

/**
 * Read the profile registry, creating it with the built-in prod/test descriptors
 * when absent. A corrupt registry is replaced by the defaults rather than
 * aborting extension load — the plugin must never block Pi startup.
 */
export function readRegistry(): ProfileRegistry {
	ensureDir(AGP_DIR);
	if (!existsSync(REGISTRY_PATH)) {
		writeRegistry(DEFAULT_REGISTRY);
		return structuredClone(DEFAULT_REGISTRY);
	}
	try {
		const parsed = normalizeRegistry(JSON.parse(readFileSync(REGISTRY_PATH, "utf8")));
		if (parsed) return parsed;
		log.warn("profiles.json is not a usable registry — rewriting defaults");
	} catch (err) {
		log.warn("failed to read profiles.json:", (err as Error).message, "— rewriting defaults");
	}
	writeRegistry(DEFAULT_REGISTRY);
	return structuredClone(DEFAULT_REGISTRY);
}

export function writeRegistry(registry: ProfileRegistry): void {
	writePrivateFileAtomic(REGISTRY_PATH, `${JSON.stringify(registry, null, 2)}\n`);
}

/** Registry id list, default profile first, then alphabetical. */
export function listProfileIds(registry = readRegistry()): string[] {
	const ids = Object.keys(registry.profiles);
	return ids.sort((a, b) =>
		a === registry.defaultProfile ? -1 : b === registry.defaultProfile ? 1 : a.localeCompare(b),
	);
}
