// Slash commands (3):
//   /cliproxy          — open the hub (Models / Usage / Diagnostics + actions)
//   /cliproxy-setup    — first-run / re-run wizard for endpoint+keys
//   /cliproxy-profile  — show or switch this session's AGP environment
//
// Refresh, usage, and diagnostics are now actions/tabs inside the hub.

import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";

import { requireGatewayTransport } from "./apply.ts";
import { clearUsageCache } from "./fetch-usage.ts";
import { fetchDiscovery } from "./fetch-models.ts";
import { log } from "./log.ts";
import { PROFILE_ENTRY_TYPE, describeProfile, profileEntryData } from "./profile-context.ts";
import { listProfileIds, readRegistry } from "./profiles.ts";
import { runtimeFor } from "./session-runtime.ts";
import { runHub } from "./ui-hub/index.ts";
import { runSetup } from "./ui-setup.ts";

export function registerCommands(pi: ExtensionAPI): void {
	pi.registerCommand("cliproxy", {
		description: "Manage proxy models, usage, and diagnostics in one hub overlay",
		handler: handleCliproxy.bind(null, pi),
	});

	pi.registerCommand("cliproxy-setup", {
		description: "Set endpoint, API key, and (optional) usage key for the active profile",
		handler: handleSetup.bind(null, pi),
	});

	pi.registerCommand("cliproxy-profile", {
		description: "Show the session's AI Gateway environment, or switch it (starts a new conversation)",
		handler: handleProfile.bind(null, pi),
	});
}

// --------------------------------------------------------------------------- /cliproxy

async function handleCliproxy(
	pi: ExtensionAPI,
	_args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	try {
		await requireGatewayTransport();
	} catch (error) {
		ctx.ui.notify((error as Error).message, "error");
		return;
	}
	const runtime = runtimeFor(pi);
	let snapshot = runtime.snapshotFor(ctx);
	if (!snapshot) {
		// No environment is usable for this session (a launch request that named
		// a missing environment, or a subagent whose origin is undetermined).
		// Setup is not offered on a guessed environment; the user picks one.
		const known = listProfileIds(readRegistry()).join(", ");
		ctx.ui.notify(
			`no AI Gateway environment is usable for this session` +
				(runtime.rootProblem ? ` (${runtime.rootProblem.reason})` : "") +
				` \u2014 configured: ${known}. Move this session with /cliproxy-profile <id>.`,
			"error",
		);
		return;
	}
	if (!snapshot.endpoint || !snapshot.apiKey) {
		ctx.ui.notify("endpoint or API key not set \u2014 launching setup first", "info");
		const ok = await runSetup(ctx, { profileId: snapshot.id, forceAll: true });
		if (!ok) return;
		const after = runtime.snapshotFor(ctx);
		if (!after) return;
		snapshot = after;
	}
	let discovery;
	try {
		discovery = await fetchDiscovery(snapshot.cfg, snapshot.apiKey, snapshot.paths);
	} catch (err) {
		ctx.ui.notify(`discovery failed: ${(err as Error).message}`, "error");
		return;
	}
	await runHub(ctx, runtimeFor(pi), snapshot, discovery);
}

// --------------------------------------------------------------------------- /cliproxy-setup

async function handleSetup(
	pi: ExtensionAPI,
	_args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	try {
		await requireGatewayTransport();
	} catch (error) {
		ctx.ui.notify((error as Error).message, "error");
		return;
	}
	const runtime = runtimeFor(pi);
	const active = runtime.snapshotFor(ctx);
	if (!active) {
		ctx.ui.notify(
			`no AI Gateway environment is usable for this session` +
				(runtime.rootProblem ? ` (${runtime.rootProblem.reason})` : ""),
			"error",
		);
		return;
	}
	const ok = await runSetup(ctx, { profileId: active.id, forceAll: true });
	if (!ok) return;
	// After saving, eagerly reapply so the new endpoint/key actually takes effect.
	const snapshot = runtime.snapshotFor(ctx);
	if (!snapshot) return;
	try {
		const discovery = await fetchDiscovery(snapshot.cfg, snapshot.apiKey, snapshot.paths);
		runtime.registerDiscovery(snapshot, discovery);
		const rep = await runtime.applySnapshot(snapshot, discovery, pi);
		await runtime.applyRoleMapping(snapshot);
		clearUsageCache();
		ctx.ui.notify(
			`setup ok \u00b7 ${snapshot.label} \u00b7 ${rep.registered.length} providers registered (source=${discovery.source})`,
			"info",
		);
	} catch (err) {
		ctx.ui.notify(`setup saved, but apply failed: ${(err as Error).message}`, "warning");
	}
}

// --------------------------------------------------------------------------- /cliproxy-profile

async function handleProfile(
	pi: ExtensionAPI,
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const requested = args.trim().split(/\s+/).filter(Boolean);
	const keepHistory = requested.includes("--keep-history");
	const id = requested.find((token) => !token.startsWith("-"));
	const runtime = runtimeFor(pi);
	const snapshot = runtime.snapshotFor(ctx);

	if (!id) {
		const registry = readRegistry();
		const lines = listProfileIds(registry).map((candidate) => {
			const marker = candidate === snapshot?.id ? "*" : " ";
			const label = registry.profiles[candidate]?.label ?? candidate.toUpperCase();
			return `${marker} ${candidate} (${label})`;
		});
		if (!snapshot) {
			ctx.ui.notify(
				`this session has no AI Gateway environment: ` +
					`${runtime.rootProblem?.reason ?? "none is configured"}`,
				"error",
			);
		} else {
			ctx.ui.notify(`AI Gateway environment: ${describeProfile(snapshot)}`, "info");
		}
		ctx.ui.notify(
			`available: ${lines.join("  \u00b7  ")} \u2014 switch with /cliproxy-profile <id>` +
				" (starts a new conversation; add --keep-history to move this one)",
			"info",
		);
		return;
	}

	const registry = readRegistry();
	if (!registry.profiles[id]) {
		ctx.ui.notify(`unknown environment "${id}" \u2014 available: ${listProfileIds(registry).join(", ")}`, "error");
		return;
	}
	const confirmed = await ctx.ui.confirm(
		`Switch this session to ${id.toUpperCase()}`,
		keepHistory
			? `Continue THIS conversation on ${id.toUpperCase()}? Model context stays, but every later request, quota and cache come from ${id.toUpperCase()}.`
			: `Start a NEW conversation on ${id.toUpperCase()}?` +
					(snapshot ? ` The current conversation stays saved and bound to ${snapshot.label}.` : ""),
	);
	if (!confirmed) return;

	if (keepHistory) {
		// Deliberate move: this conversation changes environment, with the
		// transactional switch (rollback on any failure).
		const result = await runtime.switchEnvironment(ctx, id, pi);
		if (!result.ok) {
			ctx.ui.notify(result.message, "warning");
			return;
		}
		clearUsageCache();
		ctx.ui.notify(result.message, "info");
		log.info(`session moved to ${id} keeping history`);
		return;
	}

	// Default: a NEW conversation. The old conversation keeps its environment,
	// model, binding and transcript untouched; the target is established only in
	// the new session (after it started — the host runs `setup` post-start).
	const prepared = await runtime.beginConversationSwitch(ctx, id);
	if (!prepared.ok) {
		ctx.ui.notify(prepared.message, "warning");
		return;
	}
	ctx.ui.notify(prepared.message, "info");
	const target = prepared.target ?? id;
	const outcome = await ctx.newSession({
		setup: async (sessionManager) => {
			// Durable record for a later resume; the live binding is committed
			// below, because this callback runs after the new session started.
			sessionManager.appendCustomEntry(PROFILE_ENTRY_TYPE, profileEntryData({ id: target }));
		},
	});
	if (outcome.cancelled) {
		runtime.cancelConversationSwitch();
		ctx.ui.notify(
			`the new conversation on ${id.toUpperCase()} was cancelled \u2014 this conversation was not changed`,
			"info",
		);
		return;
	}
	const committed = await runtime.commitConversationSwitch(ctx);
	clearUsageCache();
	ctx.ui.notify(committed.message, committed.ok ? "info" : "warning");
}
