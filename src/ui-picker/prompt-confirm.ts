// Confirm-remove prompt overlay used when the user deletes a custom group.

import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { cancelKey, matchesKey } from "../ui-compat.ts";

import { frame } from "../ui-frame.ts";
import type { Theme } from "./types.ts";

export async function confirmRemoveProvider(
	ctx: ExtensionCommandContext,
	slug: string,
): Promise<boolean> {
	return ctx.ui.custom<boolean>(
		(_tui, theme, kb, done) =>
			buildConfirmPrompt(
				theme as unknown as Theme,
				kb,
				`Remove custom group \u201c${slug}\u201d?`,
				"All model assignments in this group will be discarded.",
				done,
			),
		{ overlay: true, ...("composer" in ctx.ui ? {} : { overlayOptions: { width: 80, maxHeight: "40%" } }) },
	);
}

function buildConfirmPrompt(
	theme: Theme,
	kb: Parameters<typeof cancelKey>[0],
	title: string,
	body: string,
	done: (v: boolean) => void,
) {
	return {
		render(width: number): string[] {
			return frame(theme, {
				width,
				title: " confirm ",
				titleColor: "error",
				lines: ["", ` ${theme.bold(title)}`, ` ${theme.fg("dim", body)}`, ""],
				footer: {
					hint: " y / enter = remove  \u00b7  n / esc = cancel ",
				},
			});
		},
		invalidate(): void {
			/* stateless */
		},
		handleInput(data: string): void {
			if (
				cancelKey(kb, data) ||
				matchesKey(data, "escape") ||
				matchesKey(data, "n") ||
				matchesKey(data, "q")
			) {
				done(false);
				return;
			}
			if (matchesKey(data, "y") || matchesKey(data, "enter") || matchesKey(data, "return")) {
				done(true);
				return;
			}
		},
	};
}
