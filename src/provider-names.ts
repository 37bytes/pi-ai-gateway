// Environment namespacing for every provider this plugin registers.
//
// Prod and test may be live in two processes at once, and OMP's provider and
// model registries are process-global and name-keyed. A bare `codex` would
// therefore mean "whichever environment registered last", so every AGP provider
// is registered under `agp-<profile>-<server name>`:
//
//   agp-prod-openai      (builtin provider reported by discovery)
//   agp-test-codex       (connector-backed server namespace)
//   agp-prod-opencode
//
// The wire model id, the registered API family, the route table and the exact
// final-URL check are untouched — only the local provider name is namespaced.
// `agp-` is reserved: nothing else in this plugin registers a bare or prefixed
// variant of the same server namespace, so a selector can never be satisfied by
// the other environment.

/** Reserved namespace for every provider this plugin registers. */
export const AGP_PROVIDER_PREFIX = "agp";

/** Same slug rules as the legacy display-name folding, shared to stay in lockstep. */
export function providerSlug(name: string): string {
	return (
		name
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "pool"
	);
}

/** The registered name for one environment's view of a server namespace. */
export function agpProviderName(profile: string, base: string): string {
	return `${AGP_PROVIDER_PREFIX}-${profile}-${providerSlug(base)}`;
}

/**
 * The environment a registered name belongs to, or null when the name is not
 * an AGP registration. Only profile ids actually present in the registry are
 * honoured, so a server namespace that merely starts with `agp-` is never
 * mistaken for a prefixed one.
 */
export function agpProfileOf(name: string, profileIds: readonly string[]): string | null {
	const prefix = `${AGP_PROVIDER_PREFIX}-`;
	if (!name.startsWith(prefix)) return null;
	const rest = name.slice(prefix.length);
	for (const id of [...profileIds].sort((a, b) => b.length - a.length)) {
		if (rest.startsWith(`${id}-`)) return id;
	}
	return null;
}

/** Strip any environment prefix, whatever profile it names. */
export function agpBaseName(name: string, profileIds: readonly string[]): string {
	const profile = agpProfileOf(name, profileIds);
	return profile ? name.slice(`${AGP_PROVIDER_PREFIX}-${profile}-`.length) : name;
}

/**
 * Direct providers renamed when the environments were split.
 *
 * A session (or a child task) recorded before that rename still names the old
 * provider. The model is the same explicit reserve, so the plugin resolves the
 * renamed provider instead of falling back to an AGP environment: prod and test
 * must not silently replace a direct provider the user selected.
 */
export const LEGACY_DIRECT_NAMES: Readonly<Record<string, string>> = {
	"cpa-codex": "direct-cpa-codex",
	"ds-local": "direct-deepseek",
};
