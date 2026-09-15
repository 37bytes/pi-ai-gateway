// Status-line quota renderer: produces the compact segment shown in the footer.
//
// Format:  <gauge-icon> <braille-5h><braille-7d> <5h%>/<7d%>
// Example: 󰐧 ⣷⣤ 83/23   (claude: 5h=83% green, 7d=23% yellow)
//
// Context-aware: discovery supplies connector identity, never a slug heuristic.
//
// Aggregation: MAX remaining fraction across live accounts (not disabled,
// not unavailable) for each 5h/7d window label.
//
// Colors: green ≥70% · yellow 30–69% · red <30%

// The renderer accepts a structural theme type (anything with fg()) so it
// stays decoupled from Pi's internal Theme class.

import type { UsageAccount, UsageDocument, UsageGroup } from "./fetch-usage.ts";

export interface QuotaBinding {
	providerId?: string;
	/** Explicit server kind is only a fallback when no UUID was supplied. */
	providerKind?: string;
	modelIds?: string[];
}

export function quotaAccounts(doc: UsageDocument, binding: QuotaBinding): UsageAccount[] {
	return doc.accounts.filter((account) =>
		account.scope === "provider_subscription" && (binding.providerId
			? account.providerId === binding.providerId
			: !account.providerId && !!binding.providerKind && account.provider === binding.providerKind),
	);
}

function isUsableGroup(group: UsageGroup): group is UsageGroup & { remainingFraction: number } {
	return group.scope !== "key_entitlement" && (group.state === undefined || group.state === "supported") &&
		typeof group.remainingFraction === "number" && Number.isFinite(group.remainingFraction);
}

/** nf-md-gauge (Nerd Font Material Design speedometer). */
const GAUGE_ICON = "\u{F0627}";

/** Braille fill chars, 8 levels (empty → full). */
const BRAILLE = ["⡀", "⠂", "⣀", "⣄", "⣤", "⣶", "⣷", "⣾"];


/** Is an account "live" — usable and contributing quota? */
function isLiveAccount(a: UsageAccount): boolean {
	return (
		!a.disabled &&
		!a.unavailable &&
		!a.stale && a.status !== "stale" && a.state !== "stale" && a.state !== "unknown" &&
		a.supported &&
		Array.isArray(a.groups) &&
		a.groups.length > 0
	);
}

/** Does a group label refer to a 5-hour window? */
function is5hGroup(g: UsageGroup): boolean {
	const s = `${g.id} ${g.label ?? ""}`.toLowerCase();
	return s.includes("5h") || s.includes("five-hour") || s.includes("five hour");
}

/** Does a group label refer to a 7-day window? */
function is7dGroup(g: UsageGroup): boolean {
	const s = `${g.id} ${g.label ?? ""}`.toLowerCase();
	return s.includes("7d") || s.includes("seven-day") || s.includes("seven day");
}

/**
 * A model-scoped weekly window, e.g. `seven-day-fable`, as opposed to the
 * account-wide `seven-day`.
 */
function scopedModelName(g: UsageGroup): string | null {
	const id = g.id.toLowerCase();
	const prefix = "seven-day-";
	return id.startsWith(prefix) ? id.slice(prefix.length) || null : null;
}

/**
 * Does a scoped window belong to the model currently selected?
 *
 * Windows are named after the model family (`Fable` -> `seven-day-fable`) while
 * model ids carry a version (`claude-fable-5`), so this looks for the family
 * name as a delimited word inside the id rather than comparing the two
 * directly. Done without a regex because the scope comes from the server.
 */
function scopeMatchesModel(scope: string, modelID: string): boolean {
	const isWordChar = (c: string | undefined) =>
		c !== undefined && /[a-z0-9]/.test(c);
	const id = modelID.toLowerCase();
	for (let i = id.indexOf(scope); i !== -1; i = id.indexOf(scope, i + 1)) {
		const before = id[i - 1];
		const after = id[i + scope.length];
		if (!isWordChar(before) && !isWordChar(after)) return true;
	}
	return false;
}

interface WindowAggregate {
	fraction: number;
}

/**
 * Aggregate a window period across live accounts.
 *
 * Semantics: within each account, take the MIN remaining among matching
 * windows, then the MAX across eligible accounts. This is available provider
 * capacity, not a guarantee about the router's affinity-bound account.
 */
function aggregateWindow(
	accounts: UsageAccount[],
	predicate: (g: UsageGroup) => boolean,
): WindowAggregate | null {
	let maxAcross = -1;
	for (const a of accounts) {
		if (!isLiveAccount(a)) continue;
		let minWithin = Infinity;
		for (const g of a.groups ?? []) {
			if (predicate(g) && isUsableGroup(g)) {
				if (g.remainingFraction < minWithin) minWithin = g.remainingFraction;
			}
		}
		if (minWithin !== Infinity && minWithin > maxAcross) {
			maxAcross = minWithin;
		}
	}
	if (maxAcross < 0) return null;
	return { fraction: clamp(maxAcross) };
}

function clamp(f: number): number {
	return Math.max(0, Math.min(1, f));
}

/** Braille fill char for a given fraction (8 levels). */
function brailleFor(fraction: number): string {
	const idx = Math.min(
		BRAILLE.length - 1,
		Math.floor(fraction * BRAILLE.length),
	);
	return BRAILLE[idx]!;
}

/** Theme color name for a given remaining fraction. */
function colorForFraction(fraction: number): "success" | "warning" | "error" {
	if (fraction >= 0.7) return "success";
	if (fraction >= 0.3) return "warning";
	return "error";
}

/** Percent as integer string (0–100). */
function pct(fraction: number): number {
	return Math.round(fraction * 100);
}

/**
 * Render the quota status segment for the current provider, or null if the
 * provider has no quota windows (segment should be hidden).
 *
 * @param doc     - usage document from /api/usage
 * @param binding - connector UUID and explicit kind from gateway discovery
 * @param theme   - Pi theme for coloring (from ctx.ui.theme)
 * @param modelID - id of the selected model (e.g. "claude-fable-5"). When the
 *   provider reports a weekly window scoped to that model, it is shown as its
 *   own segment and excluded from the account-wide figure.
 */
export function renderQuotaSegment(
	doc: UsageDocument,
	binding: QuotaBinding,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	theme: {
		fg(color: "success" | "warning" | "error" | "dim", text: string): string;
	},
	modelID?: string,
): string | null {
	const accounts = quotaAccounts(doc, binding);
	if (accounts.length === 0) return null;
	if (doc.cache?.stale || accounts.every((a) => a.stale || a.status === "stale" || a.state === "stale")) return theme.fg("dim", "quota stale");
	const selectedIds = new Set([modelID, ...(binding.modelIds ?? [])].filter((id): id is string => !!id));
	const explicitModels = (g: UsageGroup) => g.models?.length ? g.models : g.model ? [g.model] : [];
	const matchesSelection = (g: UsageGroup) => {
		const ids = explicitModels(g);
		return !ids.length || ids.some((id) => selectedIds.has(id));
	};

	// A weekly window scoped to the selected model, e.g. Fable. It is a sub-cap
	// on the weekly pool rather than a separate allowance, so it is shown
	// alongside the account-wide weekly figure, never instead of it.
	const isSelectedModelWindow = (g: UsageGroup) => {
		if (explicitModels(g).length) return is7dGroup(g) && matchesSelection(g);
		const scope = scopedModelName(g);
		return !!modelID && scope !== null && scopeMatchesModel(scope, modelID);
	};

	const w5 = aggregateWindow(accounts, (g) => is5hGroup(g) && matchesSelection(g));
	// Other models' scoped windows say nothing about the model in use, and
	// including them used to drag the weekly figure down for no reason.
	const w7 = aggregateWindow(
		accounts,
		(g) => is7dGroup(g) && scopedModelName(g) === null && !explicitModels(g).length,
	);
	const wModel = aggregateWindow(accounts, isSelectedModelWindow);
	// Other server-defined periods (monthly, subscription, daily, etc.) retain
	// their own labels. A known capacity must not disappear just because it is
	// not a 5h/7d window, and unlike periods must never be added together.
	const genericLabels = new Map<string, string>();
	for (const account of accounts) {
		if (!isLiveAccount(account)) continue;
		for (const group of account.groups ?? []) {
			if (isUsableGroup(group) && matchesSelection(group) && !is5hGroup(group) && !is7dGroup(group)) {
				genericLabels.set(group.id, group.label?.trim() || group.id);
			}
		}
	}
	const genericWindows: Array<{ label: string; fraction: number }> = [];
	for (const [id, label] of genericLabels) {
		const aggregate = aggregateWindow(accounts, (group) => group.id === id && matchesSelection(group));
		if (aggregate) genericWindows.push({ label, fraction: aggregate.fraction });
	}

	// An authorized subscription without a fresh measurement is not zero quota.
	if (!w5 && !w7 && !wModel && genericWindows.length === 0) {
		const stale = accounts.some((a) => a.stale || a.status === "stale" || a.state === "stale" || a.groups?.some((g) => g.state === "stale" && matchesSelection(g)));
		return theme.fg("dim", stale ? "quota stale" : accounts.some((a) => a.supported) ? "quota unknown" : "quota unsupported");
	}

	const parts: string[] = [theme.fg("dim", GAUGE_ICON)];
	const push = (label: string, fraction: number) => {
		const color = colorForFraction(fraction);
		parts.push(
			`${theme.fg("dim", label)} ${theme.fg(color, brailleFor(fraction))} ${theme.fg(color, String(pct(fraction)))}`,
		);
	};

	if (w5) push("5h", w5.fraction);
	if (w7) push("7d", w7.fraction);
	if (wModel) {
		const group = accounts.flatMap((a) => isLiveAccount(a) ? a.groups ?? [] : []).find((g) => isUsableGroup(g) && isSelectedModelWindow(g));
		push(group?.label?.replace(/^7d\s+/i, "").trim() || "model", wModel.fraction);
	}
	for (const window of genericWindows) push(window.label, window.fraction);

	return parts.join(" ");
}

