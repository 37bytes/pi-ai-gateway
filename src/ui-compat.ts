import * as tui from "@oh-my-pi/pi-tui";
import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";

type Keybindings = Parameters<Parameters<ExtensionCommandContext["ui"]["custom"]>[0]>[2];
const legacy = typeof tui.visibleWidth === "function";
// @ts-expect-error Эти пути есть в хосте 19.2, но отсутствуют в SDK 18.2.
const modern = legacy ? undefined : await Promise.all([import("@oh-my-pi/pi-tui/text/width"), import("@oh-my-pi/pi-tui/driver/input/keys")]);

export const visibleWidth: typeof tui.visibleWidth = legacy ? tui.visibleWidth : modern![0].visibleWidth;
export const matchesKey: typeof tui.matchesKey = legacy ? tui.matchesKey : (raw, id) => {
	const key = modern![1].decodeKey(raw, { kitty: true, backspaceIsCtrl: false });
	return key != null && key.kind !== "release" && key.id === (id === "return" ? "enter" : id);
};

export function cancelKey(kb: Keybindings, raw: string): boolean {
	if (legacy) return kb.matches(raw, "tui.select.cancel");
	const key = modern![1].decodeKey(raw, { kitty: true, backspaceIsCtrl: false });
	return key != null && (kb.matches as unknown as (key: unknown, action: string) => boolean)(key, "tui.select.cancel");
}
