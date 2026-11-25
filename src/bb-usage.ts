import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { readConfig, resolveConfigValue } from "./config.ts";
import { sessionSocketPath } from "./bb-session.ts";
import { fetchUsage } from "./fetch-usage.ts";
import { AGP_DIR, isValidProfileId, profilePaths } from "./profiles.ts";
import { fetchDiscovery } from "./fetch-models.ts";
import { readNativeProviders, selectBbModels } from "./bb-models.ts";



export function readBbProfiles(): { defaultProfile: string; profiles: Array<{ id: string; label: string }> } {
	const raw = JSON.parse(readFileSync(join(AGP_DIR, "profiles.json"), "utf8"));
	if (raw?.schemaVersion !== 1 || !raw.profiles || typeof raw.profiles !== "object") throw new Error("Invalid AGP profile registry");
	const profiles = Object.entries(raw.profiles).map(([id, value]) => {
		if (!isValidProfileId(id) || !value || typeof value !== "object" || !("label" in value) || typeof value.label !== "string") throw new Error("Invalid AGP profile descriptor");
		return { id, label: value.label };
	});
	if (!profiles.some(({ id }) => id === raw.defaultProfile)) throw new Error("AGP default profile is missing");
	return { defaultProfile: raw.defaultProfile, profiles };
}

function source(profileId: string) {
	const registry = readBbProfiles();
	const profile = registry.profiles.find(({ id }) => id === profileId);
	if (!profile) throw new Error("AGP profile is not registered on this machine");
	const cfg = readConfig(profileId);
	if (typeof cfg?.proxy?.endpoint !== "string" || typeof cfg.proxy.apiKey !== "string") throw new Error("AGP profile configuration is invalid");
	const endpoint = new URL(cfg.proxy.endpoint);
	if (!["https:", "http:"].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error("AGP profile endpoint is invalid");
	const apiKey = resolveConfigValue(cfg.proxy.apiKey);
	const usageKey = resolveConfigValue(cfg.proxy.usageKey);
	if (!apiKey) throw new Error("AGP profile inference key could not be resolved in the local OMP environment");
	const descriptors = JSON.parse(readFileSync(join(AGP_DIR, "profiles.json"), "utf8"));
	const revision = createHash("sha256").update(JSON.stringify([profileId, cfg.proxy.endpoint, apiKey, usageKey, descriptors.profiles[profileId]?.bindingIncarnation ?? null])).digest("hex");
	return { cfg: { ...cfg, usageCacheTtlMs: typeof cfg.usageCacheTtlMs === "number" ? cfg.usageCacheTtlMs : 15_000 }, apiKey, usageKey, revision, origin: endpoint.origin, label: profile.label };
}

async function sessionCall(input: Record<string, unknown>) {
	const { promise, resolve, reject } = Promise.withResolvers<unknown>();
	const socket = connect(sessionSocketPath(String(input.threadId)));
	let buffer = "";
	socket.setTimeout(30_000, () => socket.destroy(new Error("OMP session control timed out")));
	socket.on("connect", () => socket.write(JSON.stringify(input) + "\n"));
	socket.on("data", (chunk) => {
		buffer += chunk.toString();
		if (buffer.length > 2_000_000) return socket.destroy(new Error("OMP session reply is too large"));
		if (!buffer.includes("\n")) return;
		try {
			const result = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
			socket.end();
			if (result.error) reject(new Error(String(result.error)));
			else resolve(result.result);
		} catch { socket.destroy(new Error("Invalid OMP session reply")); }
	});
	socket.on("error", () => reject(new Error("OMP session bridge is unavailable; restart this idle conversation runtime to load the updated extension")));
	socket.on("end", () => { if (!buffer.includes("\n")) reject(new Error("OMP session bridge closed without a result")); });
	return promise;
}

export async function handleBbUsage(input: Record<string, unknown>): Promise<unknown> {
	try {
		if (input.operation === "inventory") return readBbProfiles();
        if (input.operation === "session" || input.operation === "switch" || input.operation === "refreshModels") return await sessionCall(input);
		if (typeof input.profileId !== "string") throw new Error("AGP profile is required");
		const selected = source(input.profileId);
		if (input.operation === "catalog") {
			if (!Array.isArray(input.models)) throw new Error("AGP session model catalog is missing");
			const models = input.models.map((model: unknown) => {
				if (!model || typeof model !== "object" || !("id" in model) || typeof model.id !== "string" || !("name" in model) || typeof model.name !== "string") throw new Error("AGP session model catalog is invalid");
				return { id: model.id, name: model.name };
			});
			const discovery = await fetchDiscovery(selected.cfg, selected.apiKey, profilePaths(input.profileId));
			const origins = readBbProfiles().profiles.map(({ id }) => {
				try { return new URL(readConfig(id).proxy.endpoint).origin; } catch { return ""; }
			}).filter(Boolean);
			return { models: selectBbModels(models, selected.cfg, discovery, input.profileId, readNativeProviders(), origins) };
		}
		if (input.operation === "usage") {
			const document = await fetchUsage(selected.cfg, selected.usageKey, { force: input.force === true, resolvedApiKey: selected.apiKey });
			return { profileId: input.profileId, label: selected.label, origin: selected.origin, revision: selected.revision, observedAt: Date.now(), document };
		}
		if (input.operation === "reset") {
			if (input.revision !== selected.revision) throw new Error("AGP source changed; refresh and confirm the reset again");
			if (typeof input.resourceId !== "string" || typeof input.reason !== "string" || !input.reason.trim()) throw new Error("Reset account and reason are required");
			const response = await fetch(new URL("/v0/resource/plugins/pi-bridge/reset", selected.origin), {
				method: "POST", headers: { Authorization: `Bearer ${selected.apiKey}`, "X-Pi-Contract": "2", "Content-Type": "application/json" },
				body: JSON.stringify({ resourceId: input.resourceId, reason: input.reason, ...(typeof input.creditId === "string" ? { creditId: input.creditId } : {}) }),
				signal: AbortSignal.timeout(15_000), redirect: "error",
			});
			if (!response.ok) throw new Error(`AGP reset refused (HTTP ${response.status})`);
			const result = await response.json() as { code?: unknown; remaining?: unknown };
			if (typeof result.code !== "string" || !(result.remaining === null || Number.isInteger(result.remaining))) throw new Error("Invalid AGP reset result");
			return { code: result.code, remaining: result.remaining };
		}
		throw new Error("Unknown AGP bridge operation");
	} catch (error) {
		const message = error instanceof Error ? error.message : "";
		// Never serialize filesystem contents, command output or credential-bearing network errors.
		if (/^(AGP |Invalid AGP |Reset account|OMP session|Unknown AGP)/.test(message) && !message.includes("http://") && !message.includes("https://")) throw new Error(message);
		throw new Error("AGP profile operation failed; check the profile on the selected machine");
	}
}
