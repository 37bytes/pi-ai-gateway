import { readFileSync } from "node:fs";

/** Extension version, read from the manifest so requests and package stay aligned. */
export const PLUGIN_VERSION: string = (() => {
	try {
		const manifest = new URL("../package.json", import.meta.url);
		return JSON.parse(readFileSync(manifest, "utf8")).version ?? "unknown";
	} catch {
		return "unknown";
	}
})();

export const PLUGIN_USER_AGENT = `pi-ai-gateway/${PLUGIN_VERSION}`;

const PLUGIN_BASE = "/v0/resource/plugins/pi-bridge";
const CAPABILITIES_PATH = `${PLUGIN_BASE}/capabilities`;
const REQUEST_TIMEOUT_MS = 5_000;

export interface BridgeCapabilities {
	contract: number;
	latestContract: number;
	usagePath: string;
}

/**
 * Probe the bridge's authenticated capability contract. A missing, older, or
 * malformed capability endpoint returns null so callers retain their upstream
 * direct-route and sidecar fallbacks.
 */
export async function fetchBridgeCapabilities(
	origin: string,
	apiKey: string,
	contract: number,
): Promise<BridgeCapabilities | null> {
	const ctrl = new AbortController();
	const timer = setTimeout(
		() => ctrl.abort(new Error("timeout")),
		REQUEST_TIMEOUT_MS,
	);
	try {
		const resp = await fetch(new URL(CAPABILITIES_PATH, origin).toString(), {
			headers: {
			Authorization: `Bearer ${apiKey}`,
			"X-Pi-Contract": String(contract),
			Accept: "application/json",
			"User-Agent": PLUGIN_USER_AGENT,
		},
			signal: ctrl.signal,
		});
		if (!resp.ok) return null;
		const body = (await resp.json()) as {
			schemaVersion?: unknown;
			plugin?: unknown;
			contract?: unknown;
			latestContract?: unknown;
			endpoints?: { usage?: unknown };
		};
		if (
			body?.schemaVersion !== 1 ||
			body.plugin !== "pi-bridge" ||
			typeof body.contract !== "number" ||
			typeof body.latestContract !== "number" ||
			typeof body.endpoints?.usage !== "string" ||
			!body.endpoints.usage.startsWith("/")
		) {
			return null;
		}
		return {
			contract: body.contract,
			latestContract: body.latestContract,
			usagePath: body.endpoints.usage,
		};
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}
