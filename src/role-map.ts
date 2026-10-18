// Role → environment mapping.
//
// Model roles (`modelRoles`, `task.agentModelOverrides`) are configured once,
// with selectors that name a server namespace: `codex/gpt-5.6-terra`,
// `opencode/deepseek-v4.1-flash`. Registered provider names, however, are
// environment-prefixed — `agp-prod-codex`, `agp-test-codex` — so a selector only
// resolves on one environment.
//
// This module rewrites selectors for the selected environment without inventing
// anything: a selector is rewritten only when its provider is a namespace this
// environment actually registered AND the model it names is in that
// environment's catalogue. Everything else — direct providers, local models,
// unknown ids — is left exactly as the user wrote it, so preserving a direct
// `ds-local` or `cpa-codex` role is the default behaviour rather than a special
// case. The model id, the `:effort` suffix and the service tier are carried
// through verbatim.

import { agpBaseName, agpProviderName } from "./provider-names.ts";

/** Thinking/effort suffixes accepted after `provider/model`, per OMP's selector grammar. */
const EFFORT_SUFFIXES = new Set([
	"auto",
	"none",
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"max",
	"xhigh",
	"extreme",
	"ultrafast",
]);

export interface ProfileCatalog {
	profile: string;
	/** Registered base namespace → the selectors this environment can serve. */
	providers: Map<string, Set<string>>;
}

/** Add one selectable id for a base namespace, keeping aliases the gateway reports. */
export function addCatalogModel(
	catalog: ProfileCatalog,
	base: string,
	id: string | undefined,
): void {
	if (!id) return;
	const models = catalog.providers.get(base);
	if (models) models.add(id);
}

export function catalogHas(catalog: ProfileCatalog, base: string, model: string): boolean {
	return catalog.providers.get(base)?.has(model) === true;
}

/** Split `provider/model:effort` without losing any part of it. */
export function splitSelector(
	selector: string,
): { provider: string; model: string; effort: string } | null {
	const slash = selector.indexOf("/");
	if (slash <= 0 || slash === selector.length - 1) return null;
	const provider = selector.slice(0, slash);
	const rest = selector.slice(slash + 1);
	const colon = rest.lastIndexOf(":");
	if (colon > 0) {
		const suffix = rest.slice(colon + 1);
		if (EFFORT_SUFFIXES.has(suffix.toLowerCase())) {
			return { provider, model: rest.slice(0, colon), effort: rest.slice(colon) };
		}
	}
	return { provider, model: rest, effort: "" };
}

export interface SelectorMapping {
	selector: string;
	mapped: string;
	base: string;
}

/**
 * Map one selector for the selected environment, or null when it must stay as
 * written (unknown provider, unknown model, role alias, bare id).
 */
export function mapSelector(
	selector: string,
	profileIds: readonly string[],
	catalog: ProfileCatalog,
): SelectorMapping | null {
	const trimmed = selector.trim();
	if (!trimmed || trimmed.startsWith("@")) return null;
	const parts = splitSelector(trimmed);
	if (!parts) return null;
	const base = agpBaseName(parts.provider, profileIds);
	if (!catalog.providers.has(base)) return null;
	if (!catalogHas(catalog, base, parts.model)) return null;
	const mapped = `${agpProviderName(catalog.profile, base)}/${parts.model}${parts.effort}`;
	if (mapped === trimmed) return null;
	return { selector: trimmed, mapped, base };
}

export interface RoleRemap {
	/** Only the roles whose selector belongs to this environment. */
	mapped: Record<string, string>;
	/** Selectors that reference this environment but name no model it serves. */
	unresolved: string[];
	/** How many selectors were inspected. */
	inspected: number;
}

/** Remap a role map for one environment; unknown and direct selectors are kept. */
export function remapRoles(
	roles: Readonly<Record<string, string | undefined>>,
	profileIds: readonly string[],
	catalog: ProfileCatalog,
): RoleRemap {
	const mapped: Record<string, string> = {};
	const unresolved: string[] = [];
	let inspected = 0;
	for (const [role, selector] of Object.entries(roles)) {
		if (typeof selector !== "string" || !selector.trim()) continue;
		inspected++;
		const parts = splitSelector(selector.trim());
		const base = parts ? agpBaseName(parts.provider, profileIds) : "";
		if (parts && catalog.providers.has(base) && !catalogHas(catalog, base, parts.model)) {
			unresolved.push(`${role}=${selector}`);
			continue;
		}
		const result = mapSelector(selector, profileIds, catalog);
		if (result) mapped[role] = result.mapped;
	}
	return { mapped, unresolved, inspected };
}

/**
 * Rewrite the attempt-ordered model patterns for a spawn. Used from
 * `before_subagent_spawn` so a child resolves its model on the parent's
 * environment even when the settings it inherited still name another one.
 */
export function remapSpawnPatterns(
	patterns: readonly string[],
	profileIds: readonly string[],
	catalog: ProfileCatalog,
): { patterns: string[]; changed: boolean } {
	let changed = false;
	const next = patterns.map((pattern) => {
		const result = mapSelector(pattern, profileIds, catalog);
		if (!result) return pattern;
		changed = true;
		return result.mapped;
	});
	return { patterns: next, changed };
}
