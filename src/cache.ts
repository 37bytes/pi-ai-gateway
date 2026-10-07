// Disk cache for Discovery — stale-while-revalidate.
//
// The well-known/v1-models round-trip costs ~5s on every Pi startup (the proxy
// answers /.well-known/pi slowly), and Pi re-spawns the agent for every
// provider-feature probe, so that cost is paid constantly. We persist the last
// good Discovery and serve it instantly on boot, then revalidate over the
// network in the background.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { CONFIG_DIR } from "./config.ts";
import type { Discovery } from "./fetch-models.ts";
import { log } from "./log.ts";

export const DISCOVERY_CACHE_PATH = join(CONFIG_DIR, "discovery-cache.json");

interface CacheEnvelope {
	savedAt: number;
	scope: string;
	discovery: Discovery;
}

export interface CachedDiscovery {
	discovery: Discovery;
	ageMs: number;
}

export function readDiscoveryCache(scope: string): CachedDiscovery | null {
	if (!existsSync(DISCOVERY_CACHE_PATH)) return null;
	try {
		const env = JSON.parse(
			readFileSync(DISCOVERY_CACHE_PATH, "utf8"),
		) as CacheEnvelope;
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

export function writeDiscoveryCache(discovery: Discovery, scope: string): void {
	try {
		mkdirSync(dirname(DISCOVERY_CACHE_PATH), { recursive: true });
		const env: CacheEnvelope = { savedAt: Date.now(), scope, discovery };
		writeFileSync(DISCOVERY_CACHE_PATH, JSON.stringify(env), { encoding: "utf8", mode: 0o600 });
	} catch (err) {
		log.warn("failed to write discovery cache:", (err as Error).message);
	}
}

/**
 * Drop the cached discovery.
 *
 * Called when the host rejects a discovery, so a pool it cannot route is never
 * served from disk again. Keeping such a copy is what turned one rejected route
 * into a lasting outage: every later start applied the same poisoned cache,
 * failed the same way, and never reached the network.
 */
export function invalidateDiscoveryCache(): void {
	try {
		if (existsSync(DISCOVERY_CACHE_PATH)) {
			rmSync(DISCOVERY_CACHE_PATH, { force: true });
			log.info("discovery cache invalidated");
		}
	} catch (err) {
		log.warn("failed to invalidate discovery cache:", (err as Error).message);
	}
}
