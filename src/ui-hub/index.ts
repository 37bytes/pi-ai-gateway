// Public entry for the /cliproxy hub overlay.

import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";

import type { ProxyConfig } from "../config.ts";
import type { Discovery } from "../fetch-models.ts";
import { setLogQuiet } from "../log.ts";
import type { ProfileSnapshot } from "../profile-context.ts";
import type { SessionRuntime } from "../session-runtime.ts";
import type { OverlayTui, Theme } from "../ui-picker/types.ts";
import { buildHub } from "./hub.ts";

/**
 * The hub edits one environment's config: the draft it mutates is a clone of
 * the session's snapshot, and every save/refresh/apply goes through that
 * snapshot's profile and paths.
 */
export async function runHub(
	ctx: ExtensionCommandContext,
	runtime: SessionRuntime,
	snapshot: ProfileSnapshot,
	discovery: Discovery,
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("interactive UI required for /cliproxy", "warning");
		return;
	}
	// The hub mutates a draft; callers persist via the in-hub save action.
	const draft: ProxyConfig = structuredClone(snapshot.cfg);
	// Mute console logging while the overlay is open: any stdout write prints
	// over the box and shifts it down by exactly one line. Results are shown
	// inside the hub (status flash) instead.
	setLogQuiet(true);
	try {
		await ctx.ui.custom<void>(
			(tui, theme, _kb, done) =>
				buildHub({
					ctx,
					tui: tui as unknown as OverlayTui,
					theme: theme as unknown as Theme,
					runtime,
					snapshot,
					cfg: draft,
					discovery,
					done,
				}),
			{
				overlay: true,
				overlayOptions: { width: 170, maxHeight: "94%" },
			},
		);
	} finally {
		setLogQuiet(false);
	}
}
