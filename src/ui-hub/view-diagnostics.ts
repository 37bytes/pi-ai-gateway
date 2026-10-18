// Diagnostics view — connectivity, key resolution, and discovery shape.
// Built synchronously from the config + the discovery already fetched by the
// hub, plus a read-only conflict scan.

import { matchesKey } from "@oh-my-pi/pi-tui";

import type { ProxyConfig } from "../config.ts";
import { resolveConfigValue } from "../config.ts";
import { detectConflicts } from "../conflicts.ts";
import type { Discovery } from "../fetch-models.ts";
import { PLUGIN_USER_AGENT } from "../bridge.ts";
import type { ProfileSnapshot } from "../profile-context.ts";
import { agpProviderName } from "../provider-names.ts";
import { pad } from "../ui-picker/render-text.ts";
import type { Theme } from "../ui-picker/types.ts";
import { clampOffset, takeSlice } from "./shell.ts";
import type { HubView } from "./types.ts";

export interface DiagnosticsViewDeps {
	theme: Theme;
	cfg: ProxyConfig;
	getDiscovery: () => Discovery;
	/** Environment this hub is editing; shown with its origin and namespace. */
	getSnapshot: () => ProfileSnapshot;
	/** Role-mapping outcomes worth surfacing (unresolved selectors, no API). */
	getNotes: () => string[];
	/** How often this host has actually fired before_subagent_spawn. */
	getSpawnObservations: () => number;
}

export function buildDiagnosticsView(deps: DiagnosticsViewDeps): HubView {
	const { theme, cfg } = deps;
	let offset = 0;

	const buildLines = (): string[] => {
		const d = deps.getDiscovery();
		const ok = (s: string) => theme.fg("success", s);
		const bad = (s: string) => theme.fg("error", s);
		const dim = (s: string) => theme.fg("dim", s);
		const lines: string[] = [];

		const snapshot = deps.getSnapshot();
		lines.push(
			`${dim("environment")}   ${snapshot.label} \u00b7 ${snapshot.origin} ` +
				`(${snapshot.id}, ${snapshot.source}, generation ${snapshot.generation})`,
		);
		lines.push(
			`${dim("namespace")}     ${agpProviderName(snapshot.id, "<provider>")} \u00b7 cache ${dim(snapshot.paths.dir)}`,
		);
		lines.push(`${dim("endpoint")}      ${cfg.proxy.endpoint || bad("(unset)")}`);
		lines.push(
			`${dim("apiKey")}        ${resolveConfigValue(cfg.proxy.apiKey) ? ok("resolves") : bad("empty after resolution")}`,
		);
		lines.push(
			`${dim("usageKey")}      ${
				cfg.proxy.usageKey
					? resolveConfigValue(cfg.proxy.usageKey)
						? ok("resolves")
						: bad("set but empty")
					: dim("not configured")
			}`,
		);
		lines.push(`${dim("user-agent")}    ${PLUGIN_USER_AGENT}`);
		lines.push("");
		lines.push(`${dim("discovery")}     source=${d.source}`);
		lines.push(
			`${dim("upstream")}      v=${d.upstreamVersion ?? "(unknown)"} \u00b7 ${d.upstreamTotal} ids`,
		);
		const builtins =
			d.builtinProviders.map((p) => `${p.name}=${p.models.length}`).join(", ") || dim("(none)");
		lines.push(`${dim("built-in")}      ${builtins}`);
		lines.push(`${dim("custom pool")}   ${d.customPool.length} models`);

		const spawns = deps.getSpawnObservations();
		lines.push(
			`${dim("subagent hook")}  ${spawns > 0 ? ok(`${spawns} spawn(s) observed`) : dim("not observed yet")} ` +
				dim("(before_subagent_spawn)"),
		);
		const notes = deps.getNotes();
		if (notes.length) {
			lines.push(`${dim("role mapping")}  ${theme.fg("warning", notes.join(" \u00b7 "))}`);
		}
		const conflicts = detectConflicts(cfg);
		lines.push("");
		if (conflicts.length === 0) {
			lines.push(`${dim("conflicts")}     ${ok("none")}`);
		} else {
			lines.push(`${dim("conflicts")}`);
			for (const c of conflicts) lines.push(`  ${theme.fg("warning", `[${c.kind}]`)} ${c.detail}`);
		}
		return lines;
	};

	const render = (width: number, height: number): string[] => {
		const body = buildLines();
		offset = clampOffset(offset, height, body.length);
		return takeSlice(body, offset, height).map((ln) => pad(` ${ln}`, width));
	};

	const handleInput = (data: string): boolean => {
		const total = buildLines().length;
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			offset = Math.max(0, offset - 1);
			return true;
		}
		if (matchesKey(data, "down") || matchesKey(data, "j")) {
			offset = Math.min(Math.max(0, total - 1), offset + 1);
			return true;
		}
		if (matchesKey(data, "pageUp") || matchesKey(data, "b")) {
			offset = Math.max(0, offset - 10);
			return true;
		}
		if (matchesKey(data, "pageDown") || matchesKey(data, "f")) {
			offset = Math.min(Math.max(0, total - 1), offset + 10);
			return true;
		}
		return false;
	};

	return {
		id: "diagnostics",
		label: "Diagnostics",
		render,
		handleInput,
		footerHint: () => " \u2191\u2193 scroll \u00b7 r refresh discovery ",
	};
}
