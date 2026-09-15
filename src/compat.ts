// Local fallback heuristics + helpers for when /.well-known/pi is not available.
// When /.well-known/pi succeeds, we trust the server. This module is the
// secondary classifier (/v1/models path) and a couple of small utilities.

import type { Api } from "@earendil-works/pi-ai";

import type { CustomProviderModelConfig } from "./config.ts";

/** API families routed through AI Gateway Platform. */
export const ALLOWED_APIS: ReadonlySet<Api> = new Set<Api>([
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
]);

/**
 * For openai-* APIs the proxy endpoint is "https://.../v1" — pass it through.
 * For anthropic-messages the SDK expects the host root, so strip the trailing /v1.
 */
export function baseUrlFor(api: Api, endpoint: string): string {
	const trimmed = endpoint.replace(/\/+$/, "");
	if (api === "anthropic-messages") {
		return trimmed.replace(/\/v1$/, "");
	}
	return trimmed;
}

/** Match the well-known glob-ish excludes (server-defined patterns like "*:*"). */
export function isExcluded(id: string, patterns: string[]): boolean {
	if (!id) return true;
	for (const pat of patterns) {
		const rx = new RegExp(
			"^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
		);
		if (rx.test(id)) return true;
	}
	return false;
}

/** Provider namespaces come from discovery; never rename cloud providers. */

export function withProviderPrefix(
	prefix: string | undefined,
	suffix: string,
): string {
	const p = (prefix ?? "").trim();
	return p ? `${p}-${suffix}` : suffix;
}

export function normalizeSuggestedProvider(suggestedProvider: string, prefix: string | undefined): string {
	return withProviderPrefix(prefix, suggestedProvider.trim());
}

export function classifyCustom(ownedBy: string, prefix?: string): { slug: string; api: Api } {
	return { slug: withProviderPrefix(prefix, ownedBy.trim() || "misc"), api: "openai-completions" };
}

/** Make a friendly display name from an id like "glm-4.7" → "Glm 4.7". */
export function prettifyName(id: string): string {
	return id
		.replace(/[/:]/g, " ")
		.split(/[-_]/)
		.filter(Boolean)
		.map((p) => p[0]!.toUpperCase() + p.slice(1))
		.join(" ");
}

/** Presentation hints only: unknown capacity and prices remain absent. */
export function modelDefaults(id: string): CustomProviderModelConfig {
	return { id, name: prettifyName(id) };
}
