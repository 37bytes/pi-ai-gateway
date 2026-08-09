// Status-line quota renderer: produces the compact segment shown in the footer.
//
// Format:  <gauge-icon> <braille-5h><braille-7d> <5h%>/<7d%>
// Example: 󰐧 ⣷⣤ 83/23   (claude: 5h=83% green, 7d=23% yellow)
//
// Context-aware: only the windows of the CURRENT model's provider are shown.
// Provider mapping (Pi provider → usage-API provider):
//   anthropic → claude   (5h Session / 7d Weekly)
//   openai    → codex    (5h Window / 7d Window)
//   custom    → (hidden, no quota windows)
//
// Aggregation: MAX remaining fraction across live accounts (not disabled,
// not unavailable) for each 5h/7d window label.
//
// Colors: green ≥70% · yellow 30–69% · red <30%

// The renderer accepts a structural theme type (anything with fg()) so it
// stays decoupled from Pi's internal Theme class.

import type { UsageAccount, UsageDocument, UsageGroup } from "./fetch-usage.ts";

/** nf-md-gauge (Nerd Font Material Design speedometer). */
const GAUGE_ICON = "\u{F0627}";

/** Braille fill chars, 8 levels (empty → full). */
const BRAILLE = ["⡀", "⠂", "⣀", "⣄", "⣤", "⣶", "⣷", "⣾"];

/**
 * Map a Pi provider name to the provider key used by the usage API.
 * Returns null for providers without quota windows (custom providers).
 */
export function providerToUsageKey(piProvider: string): string | null {
	if (piProvider === "anthropic") return "claude";
	if (piProvider === "openai") return "codex";
	return null;
}

/** Is an account "live" — usable and contributing quota? */
function isLiveAccount(a: UsageAccount): boolean {
	return (
		!a.disabled &&
		!a.unavailable &&
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
 * windows (the account's bottleneck for that period). Then take the MAX across
 * accounts (the router will dispatch to the account with the most headroom).
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
			if (predicate(g)) {
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
 * @param piProvider - Pi provider name of the current model (e.g. "anthropic")
 * @param theme   - Pi theme for coloring (from ctx.ui.theme)
 * @param modelID - id of the selected model (e.g. "claude-fable-5"). When the
 *   provider reports a weekly window scoped to that model, it is shown as its
 *   own segment and excluded from the account-wide figure.
 */
export function renderQuotaSegment(
	doc: UsageDocument,
	piProvider: string,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	theme: {
		fg(color: "success" | "warning" | "error" | "dim", text: string): string;
	},
	modelID?: string,
): string | null {
	const usageKey = providerToUsageKey(piProvider);
	if (!usageKey) return null;

	const accounts = doc.accounts.filter((a) => a.provider === usageKey);
	if (accounts.length === 0) return null;

	// A weekly window scoped to the selected model, e.g. Fable. It is a sub-cap
	// on the weekly pool rather than a separate allowance, so it is shown
	// alongside the account-wide weekly figure, never instead of it.
	const scopeOf = (g: UsageGroup) => (modelID ? scopedModelName(g) : null);
	const isSelectedModelWindow = (g: UsageGroup) => {
		const scope = scopeOf(g);
		return scope !== null && scopeMatchesModel(scope, modelID as string);
	};

	const w5 = aggregateWindow(accounts, is5hGroup);
	// Other models' scoped windows say nothing about the model in use, and
	// including them used to drag the weekly figure down for no reason.
	const w7 = aggregateWindow(
		accounts,
		(g) => is7dGroup(g) && scopeOf(g) === null,
	);
	const wModel = aggregateWindow(accounts, isSelectedModelWindow);

	// Nothing to show → hide the segment entirely
	if (!w5 && !w7 && !wModel) return null;

	const parts: string[] = [theme.fg("dim", GAUGE_ICON)];
	const push = (label: string, fraction: number) => {
		const color = colorForFraction(fraction);
		parts.push(
			`${theme.fg("dim", label)} ${theme.fg(color, brailleFor(fraction))} ${theme.fg(color, String(pct(fraction)))}`,
		);
	};

	if (w5) push("5h", w5.fraction);
	if (w7) push("7d", w7.fraction);
	if (wModel)
		push(modelWindowLabel(accounts, modelID as string), wModel.fraction);

	return parts.join(" ");
}

/**
 * Label for the selected model's own weekly window, taken from the group so it
 * reads the way the provider names it ("7d Fable" -> "Fable").
 */
function modelWindowLabel(accounts: UsageAccount[], modelID: string): string {
	for (const a of accounts) {
		for (const g of a.groups ?? []) {
			const scope = scopedModelName(g);
			if (scope && scopeMatchesModel(scope, modelID)) {
				const label = (g.label ?? "").replace(/^7d\s+/i, "").trim();
				return label || scope;
			}
		}
	}
	return "model";
}
