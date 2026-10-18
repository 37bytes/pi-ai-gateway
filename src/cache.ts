// Disk cache for Discovery — stale-while-revalidate, per profile.
//
// The well-known/v1-models round-trip costs ~5s on every Pi startup (the proxy
// answers /.well-known/pi slowly), and Pi re-spawns the agent for every
// provider-feature probe, so that cost is paid constantly. We persist the last
// good Discovery and serve it instantly on boot, then revalidate over the
// network in the background.
//
// Every path is supplied by the caller's profile snapshot: prod and test hold
// separate files, so one environment can never serve — or invalidate — the
// other's catalogue.

import { existsSync, readFileSync, rmSync } from "node:fs";

import type { Discovery } from "./fetch-models.ts";
import { log } from "./log.ts";
import type { ProfilePaths } from "./profiles.ts";
import { writePrivateFileAtomic } from "./profiles.ts";

interface CacheEnvelope {
	savedAt: number;
	scope: string;
	discovery: Discovery;
}

export interface CachedDiscovery {
	discovery: Discovery;
	ageMs: number;
}

export function readDiscoveryCache(paths: ProfilePaths, scope: string): CachedDiscovery | null {
	if (!existsSync(paths.discoveryCachePath)) return null;
	try {
		const env = JSON.parse(readFileSync(paths.discoveryCachePath, "utf8")) as CacheEnvelope;
		if (
			!env ||
			typeof env.savedAt !== "number" ||
			env.scope !== scope ||
			!env.discovery ||
			!Array.isArray(env.discovery.builtinProviders) ||
			!Array.isArray(env.discovery.customPool)
		) {
			return null;
		}
		return { discovery: env.discovery, ageMs: Date.now() - env.savedAt };
	} catch (err) {
		log.warn("failed to read discovery cache:", (err as Error).message);
		return null;
	}
}

export function writeDiscoveryCache(
	paths: ProfilePaths,
	discovery: Discovery,
	scope: string,
): void {
	try {
		const env: CacheEnvelope = { savedAt: Date.now(), scope, discovery };
		writePrivateFileAtomic(paths.discoveryCachePath, JSON.stringify(env));
	} catch (err) {
		log.warn("failed to write discovery cache:", (err as Error).message);
	}
}

/**
 * Drop the cached discovery for one profile.
 *
 * Called when the host rejects a discovery, so a pool it cannot route is never
 * served from disk again. Keeping such a copy is what turned one rejected route
 * into a lasting outage: every later start applied the same poisoned cache,
 * failed the same way, and never reached the network.
 */
export function invalidateDiscoveryCache(paths: ProfilePaths): void {
	try {
		if (existsSync(paths.discoveryCachePath)) {
			rmSync(paths.discoveryCachePath, { force: true });
			log.info(`discovery cache invalidated for profile ${paths.id}`);
		}
	} catch (err) {
		log.warn("failed to invalidate discovery cache:", (err as Error).message);
	}
}
