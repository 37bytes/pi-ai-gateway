import { createHash } from "node:crypto";

/** Local cache format, separate from the negotiated HTTP response contract. */
export const CACHE_SCHEMA_VERSION = 2;

/** Hash all authority inputs; neither endpoint secrets nor raw keys reach disk. */
export function cacheScope(
	endpoint: string,
	apiKey: string,
	contract: number,
	usageKey = "",
): string {
	const normalized = new URL(endpoint);
	normalized.hash = "";
	normalized.pathname = normalized.pathname.replace(/\/+$/, "");
	return createHash("sha256")
		.update(JSON.stringify([CACHE_SCHEMA_VERSION, normalized.toString(), apiKey, usageKey, contract]))
		.digest("hex");
}
