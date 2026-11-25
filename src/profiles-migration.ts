// One-time migration from the single-endpoint plugin layout to profiles.
//
// Before profiles there was exactly one config and one pair of caches:
//
//   ~/.pi/agent/ai-gateway/config.json
//   ~/.pi/agent/ai-gateway/discovery-cache.json
//   ~/.pi/agent/ai-gateway/usage-cache.json
//   ~/.pi/agent/ai-gateway/usage-cache.lock
//
// The single endpoint was production, so that state moves into the `prod`
// profile. Caches are content-addressed by (endpoint, credentials, contract),
// so a legacy cache is moved only when its recorded scope equals the scope the
// migrated prod config resolves to — a cache recorded against some other
// endpoint must never be served as prod's, and it is left exactly where it is
// rather than deleted. Nothing here logs config content, key material or scope
// values, and the marker records only that the pass ran.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { cacheScope } from "./cache-scope.ts";
import { CONFIG_PATH, loadConfig, resolveConfigValue } from "./config.ts";
import { PREFERRED_CONTRACT } from "./fetch-usage.ts";
import { log } from "./log.ts";
import {
	AGP_DIR,
	DEFAULT_PROFILE,
	LEGACY_DISCOVERY_CACHE_PATH,
	LEGACY_USAGE_CACHE_PATH,
	LEGACY_USAGE_LOCK_PATH,
	ensureDir,
	movePrivateFile,
	profilePaths,
	readRegistry,
	writePrivateFileAtomic,
} from "./profiles.ts";

const MIGRATION_MARKER_PATH = join(AGP_DIR, ".profile-migration.json");

/**
 * Duplicate alias groups to hide on the migrated profile.
 *
 * The gateway reports `deepseek/*` and `ds/*` for the SAME provider id
 * (8fc22fba-f90e-4968-9371-2643d7ffcce6) with the same canonical models, so the
 * alias group only adds a second provider and a second set of model selectors
 * for models the canonical group already offers. `discoveryExcludes` is the
 * operator's existing filter for what this machine offers; a group-scoped
 * pattern hides exactly those two ids (verified against the live catalogue: the
 * pattern matches no other id, and the default `*:*` matches none). Server wire
 * ids and routes are untouched — the canonical group keeps serving them.
 */
export const ALIAS_GROUP_EXCLUDES: readonly string[] = ["ds/*"];

/**
 * Add this machine's alias-group filters to a migrated profile config, once and
 * idempotently. The config is rewritten in place (0600) with every other field
 * preserved verbatim, including `!cmd`/`$ENV` credential expressions.
 */
function applyAliasExcludes(configPath: string): void {
	if (!existsSync(configPath)) return;
	try {
		const raw = JSON.parse(readFileSync(configPath, "utf8")) as {
			discoveryExcludes?: unknown;
		};
		const current = Array.isArray(raw.discoveryExcludes)
			? raw.discoveryExcludes.filter((value): value is string => typeof value === "string")
			: [];
		const missing = ALIAS_GROUP_EXCLUDES.filter((pattern) => !current.includes(pattern));
		if (missing.length === 0) return;
		raw.discoveryExcludes = [...current, ...missing];
		writePrivateFileAtomic(configPath, `${JSON.stringify(raw, null, 2)}\n`);
		log.info(
			`profile ${DEFAULT_PROFILE}: hiding the duplicate alias group(s) ${missing.join(", ")} ` +
				"(same provider id and canonical models as the canonical group); " +
				"edit discoveryExcludes to change this",
		);
	} catch (err) {
		log.warn("could not update the migrated profile's discovery exclusions:", (err as Error).message);
	}
}

interface LegacyCacheMove {
	legacyPath: string;
	targetPath: string;
	/** Which scope the legacy file must carry to belong to prod. */
	scope: string;
	label: string;
}

function readCacheScope(path: string): string | null {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { scope?: unknown };
		return typeof parsed?.scope === "string" ? parsed.scope : null;
	} catch (err) {
		log.warn(`legacy cache ${path} is unreadable:`, (err as Error).message);
		return null;
	}
}

function migrateLegacyCaches(): void {
	const prodPaths = profilePaths(DEFAULT_PROFILE);
	const prodConfig = loadConfig(DEFAULT_PROFILE, prodPaths);
	const resolvedKey = resolveConfigValue(prodConfig.proxy.apiKey);
	if (!resolvedKey) {
		// No readable credential: a legacy cache cannot be proven to belong to
		// prod, so leave every legacy file untouched and retry on a later start.
		log.info("legacy caches kept: the migrated prod config has no resolvable key yet");
		return;
	}
	const resolvedUsageKey = resolveConfigValue(prodConfig.proxy.usageKey);
	const moves: LegacyCacheMove[] = [
		{
			legacyPath: LEGACY_DISCOVERY_CACHE_PATH,
			targetPath: prodPaths.discoveryCachePath,
			scope: cacheScope(prodConfig.proxy.endpoint, resolvedKey, PREFERRED_CONTRACT),
			label: "discovery",
		},
		{
			legacyPath: LEGACY_USAGE_CACHE_PATH,
			targetPath: prodPaths.usageCachePath,
			scope: cacheScope(prodConfig.proxy.endpoint, resolvedKey, PREFERRED_CONTRACT, resolvedUsageKey),
			label: "usage",
		},
	];
	for (const move of moves) {
		if (!existsSync(move.legacyPath)) continue;
		const scope = readCacheScope(move.legacyPath);
		if (scope !== move.scope) {
			// Never delete: only prod's own cache may be claimed as prod's.
			log.info(
				`legacy ${move.label} cache left in place: it was recorded for a different endpoint or key`,
			);
			continue;
		}
		movePrivateFile(move.legacyPath, move.targetPath);
		log.info(`legacy ${move.label} cache migrated to profile ${DEFAULT_PROFILE}`);
	}
	// A leftover lock carries no state; removing it cannot strand a fetch.
	if (existsSync(LEGACY_USAGE_LOCK_PATH)) rmSync(LEGACY_USAGE_LOCK_PATH, { force: true });
}

/**
 * Bring the on-disk profile layout up to date. Idempotent and safe to call from
 * every entry point: after the marker exists it is a single file existence check.
 */
export function ensureProfileLayout(): void {
	readRegistry();
	const prodPaths = profilePaths(DEFAULT_PROFILE);
	ensureDir(prodPaths.dir);
	if (existsSync(MIGRATION_MARKER_PATH)) return;
	try {
		if (existsSync(CONFIG_PATH) && !existsSync(prodPaths.configPath)) {
			movePrivateFile(CONFIG_PATH, prodPaths.configPath);
			log.info(
				`migrated the single-endpoint config into profile ${DEFAULT_PROFILE} (0600); ` +
					"its credentials still resolve from the original shared path",
			);
		}
		applyAliasExcludes(prodPaths.configPath);
		migrateLegacyCaches();
		writePrivateFileAtomic(
			MIGRATION_MARKER_PATH,
			`${JSON.stringify({ schemaVersion: 1, completedAt: new Date().toISOString() }, null, 2)}\n`,
		);
	} catch (err) {
		// Leave the marker absent so the next start retries instead of silently
		// running a half-migrated layout forever.
		log.warn("profile layout migration failed:", (err as Error).message);
	}
}
