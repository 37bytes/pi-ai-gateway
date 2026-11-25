// "+ new custom group" prompt overlay.

import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import * as tuiLegacy from "@oh-my-pi/pi-tui";
import { cancelKey, matchesKey } from "../ui-compat.ts";

import { withProviderPrefix } from "../compat.ts";
import { frame, frameInner } from "../ui-frame.ts";
import type { Theme } from "./types.ts";

export async function promptNewProviderName(
	ctx: ExtensionCommandContext,
	prefix: string | undefined,
): Promise<string | null> {
	const suggestion = withProviderPrefix(prefix, "group");
	if (typeof tuiLegacy.Input !== "function") {
		let candidate = suggestion;
		let title = "New custom group";
		for (;;) {
			const value = await ctx.ui.editor(title, candidate);
			if (value === undefined) return null;
			candidate = value.trim();
			if (/^[a-z0-9][a-z0-9._-]*$/i.test(candidate)) return candidate;
			title = "New custom group — letters / digits / dot / dash / underscore only";
		}
	}
	return ctx.ui.custom<string | null>(
		(tui, theme, kb, done) =>
			buildNamePrompt(
				tui as unknown as { requestRender(): void },
				kb,
				theme as unknown as Theme,
				suggestion,
				done,
			),
		{ overlay: true, overlayOptions: { width: 80, maxHeight: "40%" } },
	);
}

function buildNamePrompt(
	tui: { requestRender(): void },
	kb: Parameters<typeof cancelKey>[0],
	theme: Theme,
	suggestion: string,
	done: (v: string | null) => void,
): tuiLegacy.Component & { handleInput(data: string): void } {
	const input = new tuiLegacy.Input();
	if (suggestion) input.setValue(suggestion);
	input.focused = true;
	let error: string | null = null;

	input.onSubmit = (raw) => {
		const v = raw.trim();
		if (!/^[a-z0-9][a-z0-9._-]*$/i.test(v)) {
			error = "letters / digits / dot / dash / underscore only";
			tui.requestRender();
			return;
		}
		done(v);
	};
	input.onEscape = () => done(null);

	return {
		render(width: number): string[] {
			const inner = frameInner(width);
			const hint = suggestion
				? `name shown in /model picker, e.g. ${suggestion}`
				: "letters / digits / dot / dash / underscore";
			const inputLines = input.render(inner - 4);
			const lines: string[] = [
				"",
				` ${theme.fg("dim", hint)}`,
				"",
				...inputLines.map((ln) => ` ${theme.fg("accent", `\u276f ${ln}`)}`),
				"",
				error ? ` ${theme.fg("error", `! ${error}`)}` : "",
			];
			return frame(theme, {
				width,
				title: " new custom group ",
				lines,
				footer: { hint: " enter = create  \u00b7  esc = cancel " },
			});
		},
		invalidate(): void {
			input.invalidate();
		},
		handleInput(data: string): void {
			if (cancelKey(kb, data) || matchesKey(data, "escape")) {
				done(null);
				return;
			}
			error = null;
			input.handleInput(data);
			tui.requestRender();
		},
	};
}
