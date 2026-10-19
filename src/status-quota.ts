// Status-line quota renderer: produces the compact quota segment appended to
// the environment contour dot by status-footer.ts.
//
// Format:  <braille-period> <percentage> ...   (one group per real window)
// Example: ⣷ 83  🗓 23   (5h=83% green, 7d=23% yellow)
//
// Context-aware: discovery supplies connector identity, never a slug heuristic.
//
// Periods come from `durationSeconds` when the server reports it; a legacy
// name (5h/7d/weekly/monthly) is only used in its absence. `primary`,
// `secondary`, `rolling` and reset times are never inferred as durations.
//
// Aggregation: MAX remaining fraction across live accounts (not disabled,
// not unavailable) for each actual duration, or each legacy named period.
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

export interface QuotaRenderOptions {
	/** Expired client cache used because refresh failed, was deferred, or was locked. */
	localStale?: boolean;
}

export function quotaAccounts(doc: UsageDocument, binding: QuotaBinding): UsageAccount[] {
	return doc.accounts.filter((account) =>
		account.scope === "provider_subscription" && (binding.providerId
			? account.providerId === binding.providerId
			: !account.providerId && !!binding.providerKind && account.provider === binding.providerKind),
	);
}

function isResetExpired(group: UsageGroup, now: number): boolean {
	const resetAt = typeof group.resetTime === "string" ? Date.parse(group.resetTime) : NaN;
	return Number.isFinite(resetAt) && resetAt <= now;
}

function isUsableGroup(group: UsageGroup, now: number, aggregateStale: boolean): group is UsageGroup & { remainingFraction: number } {
	return group.scope !== "key_entitlement" && (group.state === undefined || group.state === "supported") &&
		(!aggregateStale || group.state === "supported") && !isResetExpired(group, now) &&
		typeof group.remainingFraction === "number" && Number.isFinite(group.remainingFraction);
}

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

/** A rough period family used only for ordering and the compact symbol. */
type WindowPeriod = "hourly" | "weekly" | "monthly" | "other";

/** Sort weight: equivalent seconds for legacy names, unknown periods last. */
const PERIOD_SECONDS: Record<WindowPeriod, number> = {
	hourly: 18_000,
	weekly: 604_800,
	monthly: 2_592_000,
	other: Number.POSITIVE_INFINITY,
};

/** Compact period symbol: hour, week, month, other. */
const PERIOD_SYMBOL: Record<WindowPeriod, string> = {
	hourly: "\u23f1",
	weekly: "\ud83d\uddd3",
	monthly: "\ud83d\udcc5",
	other: "\u2022",
};

/**
 * Actual window length in seconds, or null when the server did not report a
 * usable one. Non-positive, fractional, non-finite and oversized values are
 * unknown — never zero and never a default period.
 */
function durationSecondsOf(g: UsageGroup): number | null {
	const value = g.durationSeconds;
	return typeof value === "number" &&
		Number.isInteger(value) &&
		value > 0 &&
		value <= Number.MAX_SAFE_INTEGER
		? value
		: null;
}

/**
 * Classify a window. Numeric duration wins even when the name contradicts it;
 * names are only a legacy fallback when no duration was reported. `primary`,
 * `secondary` and `rolling` carry no duration evidence (they describe position
 * or reset behavior) and must never be read as hourly.
 */
function windowPeriod(g: UsageGroup): WindowPeriod {
	const reported = g.durationSeconds;
	// A supplied value is authoritative even when malformed: it stays neutral
	// rather than falling back to a name that could claim a period the server
	// did not actually report. Only an absent/null field uses the legacy name.
	if (reported !== undefined && reported !== null) {
		const duration = durationSecondsOf(g);
		if (duration === null) return "other";
		// Short/subday windows share the stopwatch; the weekly icon is reserved
		// for an exact seven-day window, and calendar months are only 28–31 days.
		// Everything else stays neutral even though it still sorts by duration.
		if (duration <= 6 * 3_600) return "hourly";
		if (duration === 7 * 86_400) return "weekly";
		if (
			duration === 28 * 86_400 ||
			duration === 29 * 86_400 ||
			duration === 30 * 86_400 ||
			duration === 31 * 86_400
		) {
			return "monthly";
		}
		return "other";
	}
	const text = `${g.id} ${g.label ?? ""}`.toLowerCase();
	if (/5h|five[- ]hour|hourly/.test(text)) return "hourly";
	if (/7d|seven[- ]day|weekly|\bweek\b/.test(text)) return "weekly";
	if (/monthly|\bmonth\b|30d/.test(text)) return "monthly";
	return "other";
}

/**
 * Bucket identity. Two accounts that report the same id with different actual
 * durations are different windows; without a duration, an explicit named
 * period keeps its semantics and everything else is keyed by its own id.
 */
function windowKey(g: UsageGroup): string {
	const duration = durationSecondsOf(g);
	if (duration !== null) return `duration:${duration}`;
	const period = windowPeriod(g);
	if (period !== "other") return `period:${period}`;
	return `name:${g.id}`;
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
	now: number,
	aggregateStale: boolean,
): WindowAggregate | null {
	let maxAcross = -1;
	for (const a of accounts) {
		if (!isLiveAccount(a)) continue;
		let minWithin = Infinity;
		for (const g of a.groups ?? []) {
			if (predicate(g) && isUsableGroup(g, now, aggregateStale)) {
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
	opts: QuotaRenderOptions = {},
): string | null {
	const accounts = quotaAccounts(doc, binding);
	if (accounts.length === 0) return null;
	const now = Date.now();
	const aggregateStale = doc.cache?.stale === true;
	// Native AGP cache.stale summarizes every observation, not this model or
	// the HTTP transport. Legacy kind-only documents lack that explicit contract.
	if (opts.localStale || (aggregateStale && !binding.providerId)) return theme.fg("dim", "quota stale");
	const selectedIds = new Set([modelID, ...(binding.modelIds ?? [])].filter((id): id is string => !!id));
	const explicitModels = (g: UsageGroup) => g.models?.length ? g.models : g.model ? [g.model] : [];
	const matchesSelection = (g: UsageGroup) => {
		const ids = explicitModels(g);
		if (ids.length) return ids.some((id) => selectedIds.has(id));
		const scope = scopedModelName(g);
		return scope === null || (!!modelID && scopeMatchesModel(scope, modelID));
	};

	const isScopedWindow = (g: UsageGroup) =>
		explicitModels(g).length > 0 || scopedModelName(g) !== null;
	const bucketKey = (g: UsageGroup) =>
		isScopedWindow(g) ? `model:${windowKey(g)}` : windowKey(g);

	// Every usable window contributes to exactly one bucket. Buckets are keyed
	// by actual duration when the server reports one, so the same id with
	// different lengths on different accounts stays two windows; model-scoped
	// caps are separate from the account-wide pool of the same period.
	interface WindowBucket {
		key: string;
		period: WindowPeriod;
		/** Exact reported duration, for stable numeric ordering within a period. */
		duration: number | null;
		label: string;
		scoped: boolean;
	}
	const buckets = new Map<string, WindowBucket>();
	for (const account of accounts) {
		if (!isLiveAccount(account)) continue;
		for (const group of account.groups ?? []) {
			if (!isUsableGroup(group, now, aggregateStale) || !matchesSelection(group)) continue;
			const key = bucketKey(group);
			if (buckets.has(key)) continue;
			const scoped = isScopedWindow(group);
			buckets.set(key, {
				key,
				period: windowPeriod(group),
				duration: durationSecondsOf(group),
				label: group.label?.trim() || group.id,
				scoped,
			});
		}
	}

	const windows: Array<{ bucket: WindowBucket; fraction: number }> = [];
	for (const bucket of buckets.values()) {
		const aggregate = aggregateWindow(
			accounts,
			(group) => matchesSelection(group) && bucketKey(group) === bucket.key,
			now,
			aggregateStale,
		);
		if (aggregate) windows.push({ bucket, fraction: aggregate.fraction });
	}
	// Numeric durations sort globally ascending; explicit legacy names are
	// compared at their equivalent duration. Anything with neither evidence
	// (including a supplied invalid value) stays last. Model-scoped caps keep
	// their own bucket and follow the account-wide window of the same period.
	windows.sort((a, b) => {
		const orderA = a.bucket.duration ?? PERIOD_SECONDS[a.bucket.period];
		const orderB = b.bucket.duration ?? PERIOD_SECONDS[b.bucket.period];
		if (orderA !== orderB) return orderA - orderB;
		return (
			Number(a.bucket.scoped) - Number(b.bucket.scoped) ||
			a.bucket.label.localeCompare(b.bucket.label)
		);
	});

	// An authorized subscription without a fresh measurement is not zero quota.
	if (windows.length === 0) {
		const stale = accounts.some((account) => {
			const accountStale = account.stale || account.status === "stale" || account.state === "stale";
			if (!account.groups?.length) return accountStale;
			return account.groups.some((group) => matchesSelection(group) &&
				(accountStale || group.state === "stale" || isResetExpired(group, now) || (aggregateStale && group.state === undefined)));
		});
		return theme.fg("dim", stale ? "quota stale" : accounts.some((a) => a.supported) ? "quota unknown" : "quota unsupported");
	}

	// The environment contour dot that used to precede this segment is now the
	// single row's leading symbol, so no gauge icon is repeated here.
	const parts: string[] = [];
	for (const window of windows) {
		const color = colorForFraction(window.fraction);
		parts.push(
			`${theme.fg("dim", PERIOD_SYMBOL[window.bucket.period])} ` +
				`${theme.fg(color, brailleFor(window.fraction))} ${theme.fg(color, String(pct(window.fraction)))}`,
		);
	}
	return parts.join("  ");
}

