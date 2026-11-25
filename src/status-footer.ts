// The one owner of the extension's footer status line.
//
// The environment contour dot and the quota windows share a single status key
// so they always render as one compact row. Two separate keys used to produce
// two footer lines and let an environment switch leave a previous
// environment's quota behind; both are fixed by keeping one entry per session
// here and by invalidating the quota whenever the bound environment changes.

/** Footer status key. A leading "0" sorts it before alphabetic host keys. */
export const FOOTER_STATUS_KEY = "0agp";

type FooterColor = "success" | "warning" | "error" | "dim";

interface FooterTheme {
	fg?(color: FooterColor, text: string): string;
}

interface FooterUI {
	theme?: FooterTheme;
	setStatus(key: string, value: string | undefined): void;
}

interface FooterContext {
	hasUI?: boolean;
	ui: FooterUI;
}

interface FooterProfile {
	/** Environment id, e.g. `prod` or `test`. */
	id: string;
	/** Session whose footer this is; subagents never write (no UI). */
	sessionKey: string;
}

interface FooterState {
	profileId: string;
	/** Last quota segment for this profile; undefined means "not measured". */
	quota?: string;
}

/** Per-session state keeps one host session from overwriting another's row. */
const states = new Map<string, FooterState>();

/** Short indicator for an authorized subscription with no usable measurement. */
const UNKNOWN_QUOTA = "quota unknown";

/**
 * Render the footer for one profile.
 *
 * `quota` omitted keeps the previous quota for the same profile (bind/switch
 * must not erase a value that is still valid). A different profile always
 * starts without quota, so an old environment's numbers can never survive a
 * switch. `null` explicitly records that no quota is known.
 */
export function reportFooter(
	ctx: FooterContext,
	profile: FooterProfile,
	quota?: string | null,
): void {
	if (!ctx.hasUI) return;
	try {
		let state = states.get(profile.sessionKey);
		if (!state || state.profileId !== profile.id) {
			state = { profileId: profile.id };
			states.set(profile.sessionKey, state);
		}
		if (quota !== undefined) state.quota = quota ?? undefined;
		const theme = ctx.ui.theme;
		const dotColor = profile.id === "prod" ? "error" : "success";
		const dot = theme?.fg ? theme.fg(dotColor, "\u25cf") : "\u25cf";
		const segment =
			state.quota ?? (theme?.fg ? theme.fg("dim", UNKNOWN_QUOTA) : UNKNOWN_QUOTA);
		ctx.ui.setStatus(FOOTER_STATUS_KEY, `${dot} ${segment}`);
	} catch {
		/* the footer is best effort; never break a session over it */
	}
}

/** Forget a finished session's row so a later reused id starts clean. */
export function clearFooter(sessionKey: string): void {
	states.delete(sessionKey);
}
