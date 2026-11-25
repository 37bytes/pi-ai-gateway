import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Discovery } from "./fetch-models.ts";
import type { ProxyConfig } from "./config.ts";
import { registrationConfig } from "./apply.ts";

export interface BbModel { id: string; name: string }
interface NativeProvider { baseUrl?: string; models: Array<{ id: string }> }

// The supported Bun runtime provides YAML; this extension's peer types predate its declaration.
const bunRuntime = globalThis as unknown as { Bun: { YAML: { parse(text: string): unknown } } };

/** Read only selector provenance; credentials never leave the local process. */
export function readNativeProviders(): Record<string, NativeProvider> {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? process.env.OMP_AGENT_DIR ?? join(homedir(), ".omp", "agent");
	const path = join(agentDir, "models.yml");
	if (!existsSync(path)) return {};
	const raw: unknown = bunRuntime.Bun.YAML.parse(readFileSync(path, "utf8"));
	if (!raw || typeof raw !== "object" || !("providers" in raw) || !raw.providers || typeof raw.providers !== "object") throw new Error("AGP native model configuration is invalid");
	const providers: Record<string, NativeProvider> = {};
	for (const [id, entry] of Object.entries(raw.providers)) {
		if (!entry || typeof entry !== "object") throw new Error("AGP native provider configuration is invalid");
		const baseUrl = "baseUrl" in entry && typeof entry.baseUrl === "string" ? entry.baseUrl : undefined;
		const models = "models" in entry && Array.isArray(entry.models) ? entry.models.map((model: unknown) => {
			if (!model || typeof model !== "object" || !("id" in model) || typeof model.id !== "string") throw new Error("AGP native model selector is invalid");
			return { id: model.id };
		}) : [];
		providers[id] = { baseUrl, models };
	}
	return providers;
}

function origin(value: string | undefined): string | null {
	try { return value ? new URL(value).origin : null; } catch { return null; }
}

/** An authenticated registry is not a catalog: retain only current gateway routes and explicit direct models. */
export function selectBbModels(candidates: readonly BbModel[], cfg: ProxyConfig, discovery: Discovery,
	profileId: string, native: Record<string, NativeProvider>, gatewayOrigins: readonly string[]): BbModel[] {
	const available = new Map(candidates.map((model) => [model.id, model]));
	const selected = new Map<string, BbModel>();
	const routes = new Set([
		...discovery.builtinProviders.flatMap((provider) => provider.models.flatMap((model) => [model.id, model.wireId].filter((id): id is string => Boolean(id)))),
		...discovery.customPool.flatMap((model) => [model.id, model.wireId].filter((id): id is string => Boolean(id))),
	]);
	const aliases = Object.entries(native).filter(([, provider]) => {
		const endpoint = origin(provider.baseUrl);
		return endpoint !== null && gatewayOrigins.includes(endpoint);
	});
	if (aliases.length) {
		for (const [providerId] of aliases) for (const model of candidates) {
			const prefix = `${providerId}/`;
			if (model.id.startsWith(prefix) && routes.has(model.id.slice(prefix.length))) selected.set(model.id, model);
		}
	} else {
		const registered = registrationConfig(cfg, discovery, profileId);
		for (const [providerId, provider] of Object.entries(registered.customProviders)) for (const model of provider.models) {
			const entry = discovery.customPool.find((candidate) => candidate.id === model.id);
			const value = entry ? available.get(`${providerId}/${entry.selectorId ?? entry.id}`) : undefined;
			if (value) selected.set(value.id, value);
		}
		for (const [providerId, provider] of Object.entries(registered.builtinProviders)) {
			if (!provider.enabled) continue;
			for (const model of discovery.builtinProviders.find((entry) => entry.name === providerId)?.models ?? []) {
				if (!provider.models.includes(model.id)) continue;
				const value = available.get(`${providerId}/${model.selectorId ?? model.id}`);
				if (value) selected.set(value.id, value);
			}
		}
	}
	for (const [providerId, provider] of Object.entries(native)) {
		if (aliases.some(([id]) => id === providerId)) continue;
		for (const model of provider.models) {
			const value = available.get(`${providerId}/${model.id}`);
			if (value) selected.set(value.id, value);
		}
	}
	return [...selected.values()];
}
