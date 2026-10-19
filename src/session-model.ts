// Moving a session's selected model between environments.
//
// Two callers: a live switch, which must move the model the session dispatches
// on onto the environment it just moved to, and the migration of a session that
// predates profiles, whose stored model names the old, unprefixed providers.
// Both go through the host's own model change (never a transcript rewrite) and
// both keep the session's thinking level and per-family service tiers.
//
// Re-selecting the model of a session that predates environment profiles.
//
// Before profiles there was one environment, so a session file records models
// under the server's own namespace (`codex/gpt-5.6-terra`). Those providers are
// now registered per environment (`agp-prod-codex`), and on resume the host
// cannot restore the stored selector: it warns "Could not restore model …" and
// falls back. Re-picking by hand is not acceptable for a migration that claims
// to preserve behaviour, so the plugin does it once, explicitly:
//
//   * only for a session classified as a pre-profile session (no persisted
//     binding + history) that has just been bound to its environment;
//   * only when the environment's own catalogue serves that exact model, so
//     nothing is invented;
//   * by asking the host to change the model — a normal model change that the
//     host records and displays — never by rewriting the transcript;
//   * preserving the session's thinking level and per-family service tiers, and
//     saying so once in the UI.
//
// Everything else (a direct provider, an unknown model, an already-namespaced
// selector) is left exactly as it was.

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import { log } from "./log.ts";
import type { ProfileSnapshot } from "./profile-context.ts";
import { agpProfileOf, LEGACY_DIRECT_NAMES } from "./provider-names.ts";
import type { ProfileCatalog } from "./role-map.ts";
import { mapSelector, splitSelector } from "./role-map.ts";

/** The selector this session would use, as recorded by the host. */
function storedModelSelector(entries: readonly { type: string; model?: unknown }[]): string | null {
	let stored: string | null = null;
	for (const entry of entries) {
		if (entry.type !== "model_change") continue;
		if (typeof entry.model === "string" && entry.model.trim()) stored = entry.model.trim();
	}
	return stored;
}

/**
 * Structural view of the host's tier API. The tier family/tier unions are wide
 * across hosts, and this code only re-asserts values it just read back, so the
 * shape is described locally instead of importing host-version-specific types.
 */
interface TierReadback {
	getServiceTiers?: () => Record<string, unknown> | undefined;
	setServiceTier?: (family: string, tier: unknown) => void;
}

/**
 * Change the session's model to `selector`, keeping the session's effort and
 * per-family service tiers. The host records the change itself (a normal model
 * change), so nothing is written to the transcript by this module.
 */
export async function applyModelChange(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	selector: string,
	what: string,
): Promise<boolean> {
	const resolved = ctx.models?.resolve?.(selector);
	if (!resolved) {
		log.warn(
			`${what} names ${selector} on this environment but this host could not resolve it — ` +
				"pick a model to continue",
		);
		return false;
	}
	// Capture what the session is on before changing the model, so the change
	// keeps the user's effort and service-tier choices.
	const thinking = pi.getThinkingLevel?.();
	const tiers = (pi as unknown as TierReadback).getServiceTiers?.() ?? {};
	try {
		const selected = await pi.setModel(resolved);
		if (!selected) {
			log.warn(`host declined the model change to ${selector} (no usable credential)`);
			return false;
		}
		if (thinking !== undefined) pi.setThinkingLevel?.(thinking);
		const tierApi = pi as unknown as TierReadback;
		for (const [family, tier] of Object.entries(tiers)) {
			if (tier === undefined) continue;
			tierApi.setServiceTier?.(family, tier);
		}
	} catch (err) {
		log.warn(`could not move the session model to ${selector}:`, (err as Error).message);
		return false;
	}
	log.info(`${what}: session model moved to ${selector}`);
	if (ctx.hasUI) {
		try {
			ctx.ui.notify(
				`session model moved to ${splitSelector(selector)?.model ?? selector} ` +
					`on ${what}; effort and service tier kept`,
				"info",
			);
		} catch (err) {
			log.debug("could not report the model change:", (err as Error).message);
		}
	}
	return true;
}

/**
 * What moving the session's model onto `snapshot`'s environment would take.
 *
 * Planning is separate from applying so a switch can decide BEFORE it touches
 * anything: a target that cannot serve the session's current AGP model must
 * abort the switch rather than leave the session on the old transport behind a
 * new label.
 */
export type ModelMovePlan =
	/** Nothing selected yet: this environment's mapped roles resolve the model. */
	| { kind: "none" }
	/** A direct or local provider: never ours to move (explicit reserve). */
	| { kind: "direct"; provider: string }
	/** Move the session to this exact selector on the target environment. */
	| { kind: "move"; selector: string }
	/** The session's AGP model has no equivalent here: refuse the switch. */
	| { kind: "impossible"; selector: string };

export function planModelMove(
	ctx: ExtensionContext,
	snapshot: ProfileSnapshot,
	catalog: ProfileCatalog | undefined,
	profileIds: readonly string[],
): ModelMovePlan {
	if (!catalog) return { kind: "none" };
	const current = ctx.models?.current?.() ?? ctx.model;
	if (!current) return { kind: "none" };
	const provider = current.provider;
	const id = current.id;
	if (!provider || !id) return { kind: "impossible", selector: "(unknown model)" };
	const selector = `${provider}/${id}`;
	const renamedProvider = LEGACY_DIRECT_NAMES[provider];
	if (renamedProvider) {
		const renamedSelector = `${renamedProvider}/${id}`;
		if (ctx.models?.resolve?.(renamedSelector)) return { kind: "move", selector: renamedSelector };
		return { kind: "direct", provider };
	}
	const mapped = mapSelector(selector, profileIds, catalog);
	if (mapped) return { kind: "move", selector: mapped.mapped };
	const namespace = agpProfileOf(provider, profileIds);
	// A direct provider is not an AGP registration: leaving it alone is the
	// documented behaviour, not a fallback.
	if (!namespace) return { kind: "direct", provider };
	// The model already belongs to this environment and it still serves it.
	if (namespace === snapshot.id && catalogHasAny(catalog, id)) return { kind: "none" };
	return { kind: "impossible", selector };
}

/** Whether any namespace of this environment serves `model`. */
function catalogHasAny(catalog: ProfileCatalog, model: string): boolean {
	for (const models of catalog.providers.values()) if (models.has(model)) return true;
	return false;
}

/**
 * Restore the model a resumed session recorded, when its selector predates a
 * rename or environment namespacing and the target environment serves it.
 *
 * A session with history but no binding (pre-profile) and a bound session whose
 * provider was renamed both hit this path. The stored selector is the user's
 * intent; we move to the equivalent served model through the host's normal
 * model change, and never invent one. An explicit `--model` wins over history.
 */
export async function adoptStoredSessionModel(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	snapshot: ProfileSnapshot,
	catalog: ProfileCatalog | undefined,
	profileIds: readonly string[],
): Promise<boolean> {
	if (process.argv.some((arg) => arg === "--model" || arg.startsWith("--model=") || arg === "--provider" || arg.startsWith("--provider="))) {
		return false;
	}
	let entries: { type: string; model?: unknown }[] = [];
	try {
		entries = (ctx.sessionManager?.getEntries() ?? []) as { type: string; model?: unknown }[];
	} catch (err) {
		log.debug("cannot inspect the session model:", (err as Error).message);
		return false;
	}
	const stored = storedModelSelector(entries);
	if (!stored) return false;
	const current = ctx.models?.current?.() ?? ctx.model;
	const parts = splitSelector(stored);
	const renamed = parts ? LEGACY_DIRECT_NAMES[parts.provider] : undefined;
	if (parts && renamed) {
		const selector = `${renamed}/${parts.model}${parts.effort}`;
		if (!ctx.models?.resolve?.(selector)) return false;
		if (current?.provider === renamed && current.id === parts.model) return false;
		const moved = await applyModelChange(pi, ctx, selector, snapshot.label);
		if (moved) log.info(`session model ${stored} moved to ${selector} (renamed direct provider)`);
		return moved;
	}
	if (!catalog) return false;
	const mapped = mapSelector(stored, profileIds, catalog);
	if (!mapped) return false;
	const target = splitSelector(mapped.mapped);
	if (target && current?.provider === target.provider && current.id === target.model) return false;
	const moved = await applyModelChange(pi, ctx, mapped.mapped, snapshot.label);
	if (moved) log.info(`session model ${stored} moved to ${mapped.mapped} on ${snapshot.id}`);
	return moved;
}

