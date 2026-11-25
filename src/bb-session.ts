import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { sessionIdOf } from "./profile-context.ts";
import type { SessionRuntime } from "./session-runtime.ts";
import { fetchDiscovery } from "./fetch-models.ts";
import { refreshAliases } from "./refresh-aliases.ts";

export function sessionSocketPath(threadId: string): string {
	if (!/^thr_[a-z0-9]+$/.test(threadId)) throw new Error("OMP session thread identity is invalid");
	const user = createHash("sha256").update(homedir()).digest("hex").slice(0, 12);
	return join(tmpdir(), `agp-bb-${user}`, `${threadId}.sock`);
}

export function registerBbSession(pi: ExtensionAPI, runtime: SessionRuntime): void {
	const threadId = process.env.BB_THREAD_ID;
	if (!threadId || !process.argv.includes("acp")) return;
	let server: Server | undefined;
	let context: ExtensionContext | undefined;
	let switching = false;
	let transition: Promise<void> = Promise.resolve();
	const socketPath = sessionSocketPath(threadId);
	const ownerPath = `${socketPath}.pid`;
	const state = () => {
		if (!context) throw new Error("OMP session is not bound");
		const snapshot = runtime.snapshotFor(context);
		const sessionId = sessionIdOf(context);
		if (!snapshot || !sessionId) throw new Error("OMP session profile is not bound");
		const model = context.models.current();
		return { sessionId, profileId: snapshot.id, label: snapshot.label, origin: snapshot.origin,
			generation: snapshot.generation, busy: switching || !context.isIdle(),
			modelId: model ? `${model.provider}/${model.id}` : null,
			models: context.models.list().map((entry) => ({ id: `${entry.provider}/${entry.id}`, name: entry.name })), live: true };
	};
	const bind = (_event: unknown, ctx: ExtensionContext) => {
		if ("agent" in ctx && ctx.agent && typeof ctx.agent === "object" && "kind" in ctx.agent && ctx.agent.kind === "sub") return;
		context = ctx;
		const uid = process.getuid?.();
		if (server || uid === undefined) return;
		const dir = join(socketPath, "..");
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const directory = lstatSync(dir);
		if (!directory.isDirectory() || directory.uid !== uid || (directory.mode & 0o077) !== 0) return;
		try {
			const existing = lstatSync(socketPath);
			if (!existing.isSocket() || existing.uid !== uid) return;
			const owner = Number(readFileSync(ownerPath, "utf8"));
			if (!Number.isSafeInteger(owner) || owner <= 0) return;
			try { process.kill(owner, 0); return; } catch (error) {
				if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") return;
			}
			unlinkSync(socketPath);
			unlinkSync(ownerPath);
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
		}
		server = createServer((socket) => {
			let buffer = "";
			let handled = false;
			socket.setTimeout(30_000, () => socket.destroy());
			socket.on("error", () => {});
			socket.on("data", (chunk) => {
				buffer += chunk.toString();
				if (buffer.length > 4096) return socket.destroy();
				if (handled || !buffer.includes("\n")) return;
				handled = true;
				void (async () => {
					const input = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
					if (input.threadId !== threadId) throw new Error("OMP session thread identity changed");
					if (input.operation === "session") {
						const current = state();
						if (input.sessionId !== current.sessionId) throw new Error("OMP session identity changed");
						return current;
					}
                    if (input.operation === "refreshModels") {
                        const before = state();
                        if (before.sessionId !== input.expectedSessionId || before.generation !== input.expectedGeneration || before.busy || !context)
                            throw new Error("OMP session changed or is busy");
                        const snapshot = runtime.snapshotFor(context);
                        if (!snapshot || snapshot.id !== input.profileId) throw new Error("OMP session profile changed");
                        switching = true;
                        const gate = Promise.withResolvers<void>();
                        transition = gate.promise;
                        try {
                            const discovery = await fetchDiscovery(snapshot.cfg, snapshot.apiKey, snapshot.paths);
                            if (!context.isIdle() || context.hasPendingMessages()) throw new Error("OMP session became busy");
                            runtime.registerDiscovery(snapshot, discovery);
                            await runtime.applySnapshot(snapshot, discovery, pi);
                            try { refreshAliases(pi, context, snapshot.endpoint); }
                            catch { throw new Error("OMP alias registration failed"); }
                            return state();
                        } finally { switching = false; gate.resolve(); }
                    }
					if (input.operation !== "switch" || typeof input.profileId !== "string") throw new Error("OMP session operation is invalid");
					const before = state();
					if (before.sessionId !== input.expectedSessionId || before.generation !== input.expectedGeneration) throw new Error("OMP session changed; refresh before switching");
					if (before.busy || !context) throw new Error("OMP session is busy; finish the current turn before switching");
					switching = true;
					const gate = Promise.withResolvers<void>();
					transition = gate.promise;
					try {
						const outcome = await runtime.switchEnvironment(context, input.profileId, pi);
						if (!outcome.ok) throw new Error("OMP session profile switch refused; previous profile retained");
					} finally { switching = false; gate.resolve(); }
					return state();
                })().then((result) => socket.end(JSON.stringify({ result }) + "\n"), (error) => {
                    const reason = error instanceof Error && ["OMP session changed or is busy", "OMP session profile changed", "OMP session became busy", "OMP alias registration failed"].includes(error.message) ? error.message : "OMP session refresh failed";
                    socket.end(JSON.stringify({ error: reason }) + "\n");
                });
			});
		});
		server.on("error", () => { server = undefined; });
		server.listen(socketPath, () => {
			chmodSync(socketPath, 0o600);
			writeFileSync(ownerPath, String(process.pid), { mode: 0o600 });
		});
		server.unref();
	};
	pi.on("session_start", bind);
	pi.on("session_switch", bind);
	pi.on("before_agent_start", async () => { await transition; });
	pi.on("session_shutdown", (_event, ctx) => {
		if (sessionIdOf(ctx) !== (context ? sessionIdOf(context) : undefined)) return;
		context = undefined;
		if (!server) return;
		server.close();
		server = undefined;
		try { unlinkSync(socketPath); } catch {}
		try { unlinkSync(ownerPath); } catch {}
	});
}
