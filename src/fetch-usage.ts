// Usage client.
//
// Quota comes from one of two sources:
//
//   - the pi-bridge plugin inside CLIProxyAPI, authenticated with the ordinary
//     API key already used for model calls, or
//   - the legacy standalone sidecar at /api/usage, authenticated with a
//     separate usage key.
//
// The plugin is preferred and probed first; the sidecar remains supported so a
// server can be migrated without changing the client in lockstep. Results are
// cached in memory; callers pass `force: true` to bypass it.

import type { ProxyConfig } from "./config.ts";
import { PLUGIN_USER_AGENT } from "./fetch-models.ts";
import { log } from "./log.ts";

const REQUEST_TIMEOUT_MS = 15_000;

/** Response contract this client is written against. */
export const PREFERRED_CONTRACT = 2;

/** Header the bridge reads to select a contract, and echoes back. */
const CONTRACT_HEADER = "X-Pi-Contract";

const PLUGIN_USAGE_PATH = "/v0/resource/plugins/pi-bridge/dev/usage";
const SIDECAR_USAGE_PATH = "/api/usage";

/** Where a usage document came from. */
export type UsageSource = "plugin" | "sidecar";

export interface UsageGroup {
	id: string;
	label: string;
	remainingFraction: number;
	resetTime: string | null;
	models?: string[];
}

export interface UsageAccount {
	provider: string;
	account: string;
	authIndex: string;
	label: string;
	status: string;
	disabled: boolean;
	unavailable: boolean;
	success: number;
	failed: number;
	lastRequestAt: string | null;
	supported: boolean;
	error?: string;
	groups?: UsageGroup[];
}

export interface UsageDocument {
	schemaVersion: number;
	generatedAt: string;
	accounts: UsageAccount[];
	unsupportedProviders: string[];
	/** Contract v2 only: server-side cache provenance. */
	cache?: { updatedAt: string; stale: boolean; ttlMs: number };
	/** Contract v2 only: which key the server authenticated. */
	client?: { keyHint: string };
}

interface CacheEntry {
	fetchedAt: number;
	doc: UsageDocument;
	source: UsageSource;
	contract: number;
}

let cache: CacheEntry | null = null;

export function clearUsageCache(): void {
	cache = null;
}

/** Which source served the cached document, if any. */
export function lastUsageSource(): UsageSource | null {
	return cache?.source ?? null;
}

/** Which contract the cached document was served under, if any. */
export function lastUsageContract(): number | null {
	return cache?.contract ?? null;
}

async function getJSON(
	url: string,
	headers: Record<string, string>,
): Promise<Response> {
	const ctrl = new AbortController();
	const timer = setTimeout(
		() => ctrl.abort(new Error("timeout")),
		REQUEST_TIMEOUT_MS,
	);
	try {
		return await fetch(url, {
			headers: {
				...headers,
				Accept: "application/json",
				"User-Agent": PLUGIN_USER_AGENT,
			},
			signal: ctrl.signal,
		});
	} finally {
		clearTimeout(timer);
	}
}

function parseUsage(body: unknown, origin: string): UsageDocument {
	const doc = body as UsageDocument;
	if (!doc || doc.schemaVersion !== 1 || !Array.isArray(doc.accounts)) {
		throw new Error(`${origin} returned unexpected payload shape`);
	}
	return doc;
}

export async function fetchUsage(
	cfg: ProxyConfig,
	resolvedUsageKey: string,
	opts: { force?: boolean } = {},
): Promise<UsageDocument> {
	if (
		!opts.force &&
		cache &&
		Date.now() - cache.fetchedAt < cfg.usageCacheTtlMs
	) {
		return cache.doc;
	}

	let origin: string;
	try {
		origin = new URL(cfg.proxy.endpoint).origin;
	} catch {
		throw new Error(`proxy.endpoint is not a valid URL: ${cfg.proxy.endpoint}`);
	}
	const apiKey = cfg.proxy.apiKey ?? "";

	// Preferred path: the plugin, using the key already configured for models.
	if (apiKey) {
		try {
			const { doc, contract } = await fetchFromPlugin(origin, apiKey);
			cache = { fetchedAt: Date.now(), doc, source: "plugin", contract };
			log.debug(
				`usage fetched from plugin (contract v${contract}), accounts:`,
				doc.accounts.length,
			);
			return doc;
		} catch (err) {
			// Fall back only when a usage key exists; otherwise surface the error
			// rather than silently reporting "no quota configured".
			if (!resolvedUsageKey) throw err;
			log.debug("plugin usage unavailable, falling back to sidecar:", err);
		}
	}

	if (!resolvedUsageKey) {
		throw new Error(
			"no usage source available: set proxy.apiKey for the pi-bridge plugin, or proxy.usageKey for the legacy sidecar",
		);
	}

	const doc = await fetchFromSidecar(origin, resolvedUsageKey);
	// The sidecar predates contracts and only ever served the v1 shape.
	cache = { fetchedAt: Date.now(), doc, source: "sidecar", contract: 1 };
	log.debug("usage fetched from sidecar, accounts:", doc.accounts.length);
	return doc;
}

/**
 * Ask the bridge for the newest contract this client understands.
 *
 * A bridge that predates contracts ignores the header and answers with the v1
 * document; it is detected by the absent echo, and its response is used as-is.
 * That keeps a new client working against an old bridge without a second
 * round-trip or a version probe.
 */
async function fetchFromPlugin(
	origin: string,
	apiKey: string,
): Promise<{ doc: UsageDocument; contract: number }> {
	const resp = await getJSON(new URL(PLUGIN_USAGE_PATH, origin).toString(), {
		Authorization: `Bearer ${apiKey}`,
		[CONTRACT_HEADER]: String(PREFERRED_CONTRACT),
	});
	if (!resp.ok) {
		throw new Error(`pi-bridge usage returned ${resp.status}`);
	}

	const doc = parseUsage(await resp.json(), "pi-bridge usage");
	const echoed = Number.parseInt(resp.headers.get(CONTRACT_HEADER) ?? "", 10);
	const contract = Number.isNaN(echoed) ? 1 : echoed;
	return { doc, contract };
}

async function fetchFromSidecar(
	origin: string,
	usageKey: string,
): Promise<UsageDocument> {
	const resp = await getJSON(new URL(SIDECAR_USAGE_PATH, origin).toString(), {
		"X-Plugin-Key": usageKey,
	});
	if (!resp.ok) {
		throw new Error(`/api/usage returned ${resp.status}`);
	}
	return parseUsage(await resp.json(), "/api/usage");
}
