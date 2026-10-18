// Register local selectors separately from exact authenticated gateway routes.
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { streamSimple } from "@oh-my-pi/pi-ai";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import type { buildModel as BuildNativeModel } from "@oh-my-pi/pi-catalog/build";
import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";

import { invalidateDiscoveryCache } from "./cache.ts";

import { ALLOWED_APIS, baseUrlFor, isExcluded } from "./compat.ts";
import type { BuiltinProviderConfig, CustomProviderConfig, CustomProviderModelConfig, ProxyConfig } from "./config.ts";
import { resolveConfigValue } from "./config.ts";
import type { Discovery, DiscoveryModelEntry } from "./fetch-models.ts";
import { log } from "./log.ts";
import { createLatencyDiagnostics } from "./latency.ts";
import type { ProfilePaths } from "./profiles.ts";
import { agpBaseName, agpProviderName, providerSlug } from "./provider-names.ts";
import { type ProfileCatalog, addCatalogModel } from "./role-map.ts";

type GatewayFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type GatewayStreamOptions = NonNullable<Parameters<typeof streamSimple>[2]> & {
	fetch?: GatewayFetch;
	maxInFlightRequests?: Record<string, number>;
};

const appliedProviderNames = new WeakMap<ExtensionAPI, Set<string>>();

type NativeModelBuilder = typeof BuildNativeModel;
let nativeModelBuilder: NativeModelBuilder | undefined;

/** Plugin dependency readiness, not a custom host capability or version marker. */
export async function requireGatewayTransport(): Promise<NativeModelBuilder> {
	if (nativeModelBuilder) return nativeModelBuilder;
	// Static loading would abort extension initialization on an incomplete
	// plugin install, before we can refuse credential resolution actionably.
	try {
		const catalog = await import("@oh-my-pi/pi-catalog/build");
		if (typeof catalog.buildModel !== "function") throw new Error("missing builder");
		nativeModelBuilder = catalog.buildModel;
		return nativeModelBuilder;
	} catch {
		throw new Error(
			"AI Gateway transport unavailable: reinstall this plugin with its pinned @oh-my-pi/pi-catalog@18.2.0 dependency and restart standard OMP. No gateway credentials were resolved and no providers were registered.",
		);
	}
}

// Availability marker only. Never expose the gateway credential to the host's
// provider-wide lookup, which may also serve refreshed first-party models.
const GATEWAY_AUTH_MARKER = "agp-plugin-managed-not-a-credential";

export interface ApplyReport {
	registered: Array<{ provider: string; modelCount: number; api: Api }>;
	skipped: Array<{ provider: string; reason: string }>;
	/** Set when a profile/generation gate rejected the apply; nothing was registered. */
	superseded?: boolean;
}

/** OMP's explicit-state contract; upstream Pi's peer types still require numbers. */
export interface GatewayModelConfig extends CustomProviderModelConfig {
	name: string;
	api: Api;
	metadataState: DiscoveryModelEntry["metadataState"];
	priceState: DiscoveryModelEntry["priceState"];
}

/**
 * Apply the environment namespace to every provider this profile registers.
 *
 * Server namespaces stay authoritative for connector-backed groups, and an
 * explicitly configured group keeps its own name — both are then prefixed, so
 * `codex` becomes `agp-prod-codex` on prod and `agp-test-codex` on test. A
 * registered name therefore always states which environment it belongs to, and
 * no selector can be satisfied by the other environment's registration.
 */
export function registrationConfig(
	cfg: ProxyConfig,
	discovery: Discovery,
	profile: string,
): ProxyConfig {
	const builtinProviders: Record<string, BuiltinProviderConfig> = {};
	for (const [name, provider] of Object.entries(cfg.builtinProviders)) {
		builtinProviders[agpProviderName(profile, name)] = {
			...provider,
			models: [...(provider.models ?? [])],
		};
	}
	const customProviders: Record<string, CustomProviderConfig> = {};
	/** Groups the operator configured by name: their API family is authoritative. */
	const explicitGroups = new Set<string>();
	for (const [name, provider] of Object.entries(cfg.customProviders)) {
		const namespaced = agpProviderName(profile, name);
		customProviders[namespaced] = { ...provider, models: [...provider.models] };
		explicitGroups.add(namespaced);
	}
	if (!cfg.registerAll) return { ...cfg, builtinProviders, customProviders };

	// `discoveryExcludes` is the operator's filter for what this machine should
	// offer, so it applies to every discovery source — including the
	// authoritative well-known catalogue, which the server does not filter per
	// operator. A duplicate alias group of a provider the operator already has
	// (same provider id and canonical models under another group name) is
	// hidden with a group-scoped pattern such as `ds/*`.
	const excludes = cfg.discoveryExcludes ?? [];
	for (const p of discovery.builtinProviders) {
		builtinProviders[agpProviderName(profile, p.name)] = {
			...builtinProviders[agpProviderName(profile, p.name)],
			enabled: true,
			models: p.models.filter((m) => !isExcluded(m.id, excludes)).map((m) => m.id),
		};
	}
	// A matching wire ID is not proof that an explicit group was generated by
	// AGP. Preserve every explicit group; discovery adds its stable namespace
	// separately, without mutating or silently discarding operator settings.
	for (const m of discovery.customPool) {
		if (isExcluded(m.id, excludes)) continue;
		const explicitOwner = !m.providerId
			? Object.entries(cfg.customProviders).find(([, provider]) =>
					provider.models.some((entry) => entry.id === m.id),
				)?.[0]
			: undefined;
		if (m.providerId && !/^[a-z0-9][a-z0-9._-]*$/.test(m.suggestedProvider))
			throw new Error(`Invalid gateway provider namespace for ${m.id}`);
		const base =
			explicitOwner ?? (m.providerId ? m.suggestedProvider : registerAllSlug(m.suggestedProvider));
		const name = agpProviderName(profile, base);
		const explicit = customProviders[name];
		const group = (customProviders[name] ??= { api: explicit?.api ?? m.api, models: [] });
		// An explicitly configured group may pin the protocol the operator needs
		// (see the custom-provider loop in applyAll). A conflict between two
		// DISCOVERED families for one group is still refused.
		if (group.api !== m.api && !explicitGroups.has(name))
			throw new Error(`Conflicting API families for provider ${name}`);
		if (!group.models.some((entry) => entry.id === m.id)) {
			group.models.push({ ...explicit?.models.find((entry) => entry.id === m.id), id: m.id });
		}
	}
	return { ...cfg, builtinProviders, customProviders };
}

/**
 * Which base namespaces and models this environment can actually serve.
 *
 * Role mapping uses it to decide what may be rewritten: a provider/model pair
 * has to be in this environment's own catalogue, so a role can never be pointed
 * at a model the environment does not offer.
 */
export function buildProfileCatalog(
	cfg: ProxyConfig,
	discovery: Discovery,
	profile: string,
	profileIds: readonly string[],
): ProfileCatalog {
	const catalog: ProfileCatalog = { profile, providers: new Map() };
	const namespaced = registrationConfig(cfg, discovery, profile);
	// The same filter registration applies: a model the operator excluded is not
	// something a role may be pointed at either.
	const excludes = cfg.discoveryExcludes ?? [];
	for (const [name, provider] of Object.entries(namespaced.builtinProviders)) {
		const base = agpBaseName(name, profileIds);
		catalog.providers.set(base, new Set(provider.models ?? []));
		const fromServer = discovery.builtinProviders.find((p) => p.name === base);
		for (const entry of fromServer?.models ?? []) {
			if (isExcluded(entry.id, excludes)) continue;
			addCatalogModel(catalog, base, entry.id);
			addCatalogModel(catalog, base, entry.selectorId);
			addCatalogModel(catalog, base, entry.wireId);
		}
	}
	for (const [name, provider] of Object.entries(namespaced.customProviders)) {
		const base = agpBaseName(name, profileIds);
		const models = new Set(provider.models.map((entry) => entry.id));
		catalog.providers.set(base, models);
		for (const entry of discovery.customPool) {
			if (entry.suggestedProvider !== base) continue;
			if (isExcluded(entry.id, excludes)) continue;
			addCatalogModel(catalog, base, entry.id);
			addCatalogModel(catalog, base, entry.selectorId);
			addCatalogModel(catalog, base, entry.wireId);
		}
	}
	return catalog;
}

/** Names this profile would register; used to keep live sessions' providers. */
export function profileProviderNames(
	cfg: ProxyConfig,
	discovery: Discovery,
	profile: string,
): string[] {
	try {
		const namespaced = registrationConfig(cfg, discovery, profile);
		return [
			...Object.keys(namespaced.builtinProviders),
			...Object.keys(namespaced.customProviders),
		];
	} catch (err) {
		log.warn(`could not enumerate ${profile} provider names:`, (err as Error).message);
		return [];
	}
}

/** Manual overrides > explicit model settings > server > genuine local catalog. */
export function mergeModelMetadata(
	entry: DiscoveryModelEntry,
	configured: CustomProviderModelConfig,
	override: Partial<CustomProviderModelConfig>,
	api: Api,
	catalog?: Partial<Pick<Model<Api>, "reasoning" | "input" | "contextWindow" | "maxTokens">>,
): GatewayModelConfig {
	const merged: GatewayModelConfig = {
		id: entry.selectorId ?? entry.id,
		name: override.name ?? configured.name ?? entry.name,
		api,
		metadataState: entry.metadataState,
		priceState: "unknown",
	};
	let manualMetadata = false;
	for (const key of ["reasoning", "input", "contextWindow", "maxTokens"] as const) {
		const value = override[key] ?? configured[key] ?? entry[key] ?? catalog?.[key];
		if (value !== undefined && value !== null) Object.assign(merged, { [key]: value });
		if (override[key] !== undefined || configured[key] !== undefined) manualMetadata = true;
	}
	if (manualMetadata) merged.metadataState = "override";
	else if (
		merged.metadataState === "unknown" &&
		catalog &&
		[merged.reasoning, merged.input, merged.contextWindow, merged.maxTokens].some(
			(v) => v !== undefined,
		)
	)
		merged.metadataState = "catalog";
	// Gateway prices are the active AGP snapshot, not a bundled upstream tariff.
	const cost: NonNullable<CustomProviderModelConfig["cost"]> = {};
	for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
		const value = override.cost?.[key] ?? configured.cost?.[key] ?? entry.cost?.[key];
		if (value !== undefined) {
			if (!Number.isFinite(value) || value < 0)
				throw new Error(`Invalid ${key} price for ${entry.id}`);
			cost[key] = value;
		}
	}
	if (Object.keys(cost).length) {
		merged.cost = cost;
		merged.priceState = cost.input !== undefined && cost.output !== undefined ? "known" : "partial";
	}
	for (const key of ["contextWindow", "maxTokens"] as const) {
		const value = merged[key];
		if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0))
			throw new Error(`Invalid ${key} for ${entry.id}`);
	}
	return merged;
}

export interface ApplyOptions {
	profile: string;
	/** Profile ids known to the registry; used to recover a base namespace. */
	profileIds: readonly string[];
	/** Re-checked immediately before anything is registered. */
	gate?: () => boolean;
	/**
	 * Provider names that must stay registered.
	 *
	 * One process has one provider registry, so a live switch would otherwise
	 * strand a session that is still running on the environment being left
	 * behind (an in-process child, for example). Names owned by this plugin and
	 * still referenced by a live session are kept instead.
	 */
	keepNames?: ReadonlySet<string>;
	/** Profile whose discovery cache is invalidated when the host rejects a pool. */
	paths?: ProfilePaths;
}

export async function applyAll(
	pi: ExtensionAPI,
	cfg: ProxyConfig,
	discovery: Discovery,
	options: ApplyOptions,
): Promise<ApplyReport> {
	const { profile, profileIds } = options;
	const buildModel = await requireGatewayTransport();
	const report: ApplyReport = { registered: [], skipped: [] };
	if (options.gate && !options.gate()) {
		// The selected environment changed while the transport was loading: this
		// pool belongs to the environment this session is no longer on.
		report.superseded = true;
		return report;
	}
	const resolvedKey = resolveConfigValue(cfg.proxy.apiKey);
	if (!resolvedKey) {
		log.warn(`proxy apiKey is empty for profile ${profile} — provider registration skipped`);
		return report;
	}
	// The operator's own config, kept before discovery merges into it: it is what
	// distinguishes an explicitly chosen API family from one the gateway reported.
	const operatorConfig = cfg;
	cfg = registrationConfig(cfg, discovery, profile);
	const registeredNames = new Set<string>();
	const ownedNames = appliedProviderNames.get(pi) ?? new Set<string>();
	appliedProviderNames.set(pi, ownedNames);
	const register = (
		name: string,
		api: Api,
		models: GatewayModelConfig[],
		routes: Map<string, string>,
	) => {
		const bridgeAPI = `agp:${name}:${api}`;
		const gatewayBaseUrl = baseUrlFor(api, cfg.proxy.endpoint);
		const endpointSuffix =
			api === "anthropic-messages"
				? "/v1/messages"
				: api === "openai-responses"
					? "/responses"
					: "/chat/completions";
		const gatewayRequestURL = new URL(gatewayBaseUrl.replace(/\/+$/, "") + endpointSuffix);
		const config: ProviderConfig & { fetchDynamicModels(): Promise<ProviderModelConfig[]> } = {
			baseUrl: gatewayBaseUrl,
			apiKey: GATEWAY_AUTH_MARKER,
			authHeader: false,
			api: bridgeAPI,
			// Discovery truth is retained by the plugin. Stock hosts may supply
			// runtime defaults for omitted metadata; the plugin UI stays explicit.
			models: models.map((m) => {
				const unavailable = [
					...(m.contextWindow === undefined ? ["context unknown"] : []),
					...(m.maxTokens === undefined ? ["output limit unknown"] : []),
					...(m.priceState !== "known" ? [`price ${m.priceState}`] : []),
				];
				return {
					...m,
					api: bridgeAPI,
					name: unavailable.length ? `${m.name} [${unavailable.join("; ")}]` : m.name,
				};
			}) as unknown as ProviderModelConfig[],
			// Stock OMP excludes its built-in discovery only when an extension
			// owns a dynamic model manager. Static models alone do not own a namespace.
			async fetchDynamicModels() {
				return config.models ?? [];
			},
			streamSimple(model, context, options) {
				if (
					model.provider !== name ||
					model.api !== bridgeAPI ||
					model.baseUrl !== gatewayBaseUrl
				) {
					throw new Error(
						"Gateway model transport identity does not match its registered provider",
					);
				}
				const wireId = routes.get(model.id);
				if (!wireId) throw new Error(`Unknown gateway selector ${name}/${model.id}`);
				const diagnostics = createLatencyDiagnostics();
				const headers = new Headers(options?.headers);
				const transportHeaders = new Headers(model.headers);
				headers.delete("authorization");
				headers.delete("x-api-key");
				headers.delete("api-key");
				if (
					options?.sessionId &&
					!headers.has("x-session-id") &&
					!transportHeaders.has("x-session-id")
				) {
					headers.set("x-session-id", options.sessionId);
				}
				// OpenCode Go routes by its own conversation header; without it the
				// upstream rejects the request even when the gateway session id is
				// present. A caller-set value always wins.
				if (
					options?.sessionId &&
					!headers.has("x-opencode-session") &&
					!transportHeaders.has("x-opencode-session")
				) {
					headers.set("x-opencode-session", options.sessionId);
				}
				// Dispatch through the supported root API, with the real built-in
				// family restored. Keeping agp:* here would recurse into this hook.
				transportHeaders.delete("authorization");
				transportHeaders.delete("x-api-key");
				transportHeaders.delete("api-key");
				const nativeModel = buildModel({
					...model,
					api,
					baseUrl: gatewayBaseUrl,
					headers: Object.fromEntries(transportHeaders),
					compat: (model as typeof model & { compatConfig?: unknown }).compatConfig,
				} as Parameters<typeof buildModel>[0]);
				const transportModel = {
					...nativeModel,
					cost: model.cost,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
				} as unknown as Parameters<typeof streamSimple>[0];
				// Do not delegate to options.fetch: the outer host wraps it for
				// request debugging and may route it independently. Native transport
				// options (signal, CA/proxy init) already reach this final boundary.
				const send = globalThis.fetch;
				const gatewayFetch: GatewayFetch = async (input, init) => {
					const target = new URL(input instanceof Request ? input.url : String(input));
					if (target.href !== gatewayRequestURL.href || target.username || target.password) {
						throw new Error("Gateway transport rejected an endpoint outside its registered route");
					}
					// Reassert credentials only after validating the final SDK URL. Native
					// environment/auth defaults cannot replace the configured gateway key.
					const requestHeaders = new Headers(
						init?.headers ?? (input instanceof Request ? input.headers : undefined),
					);
					requestHeaders.set("authorization", `Bearer ${resolvedKey}`);
					requestHeaders.delete("x-api-key");
					requestHeaders.delete("api-key");
					if (diagnostics) requestHeaders.set("x-agp-trace-id", diagnostics.traceId);
					const attempt = diagnostics?.dispatch();
					const response = await send(input, {
						...init,
						headers: requestHeaders,
						redirect: "error",
					});
					diagnostics?.headers(response, attempt!);
					return response;
				};
				const transportOptions: GatewayStreamOptions = {
					...options,
					apiKey: GATEWAY_AUTH_MARKER,
					// The outer custom API already owns the provider permit. An empty
					// override disables only this nested acquisition (undefined would
					// fall back to the host's configured cap and deadlock at cap=1).
					maxInFlightRequests: {},
					fetch: gatewayFetch,
					headers: Object.fromEntries(headers),
					onPayload: async (payload, sdkModel) => {
						const next = (await options?.onPayload?.(payload, sdkModel)) ?? payload;
						if (!next || typeof next !== "object" || Array.isArray(next))
							throw new Error("Invalid gateway inference payload");
						return { ...next, model: wireId };
					},
				};
				if (diagnostics) {
					const nativeOptions = transportOptions as GatewayStreamOptions & {
						onSseEvent?: (...args: unknown[]) => void;
					};
					const onSseEvent = nativeOptions.onSseEvent;
					nativeOptions.onSseEvent = (...args) => {
						diagnostics.firstSse();
						onSseEvent?.(...args);
					};
					diagnostics.prepared();
				}
				try {
					const stream = streamSimple(transportModel, context, transportOptions);
					return diagnostics ? diagnostics.observe(stream) : stream;
				} catch (error) {
					diagnostics?.failed();
					throw error;
				}
			},
		};
		pi.registerProvider(name, config);
		registeredNames.add(name);
		ownedNames.add(name);
		report.registered.push({ provider: name, modelCount: models.length, api });
	};

	for (const [name, provider] of Object.entries(cfg.builtinProviders)) {
		if (!provider?.enabled) {
			report.skipped.push({ provider: name, reason: "disabled" });
			continue;
		}
		const base = agpBaseName(name, profileIds);
		const fromServer = discovery.builtinProviders.find((p) => p.name === base);
		const api = provider.apiOverride ?? fromServer?.api;
		if (!api || !ALLOWED_APIS.has(api)) {
			report.skipped.push({ provider: name, reason: "no supported API in discovery" });
			continue;
		}
		let catalog: Model<Api>[] = [];
		try {
			catalog = getBundledModels(base as Parameters<typeof getBundledModels>[0]);
		} catch {
			/* no local catalog */
		}
		const models: GatewayModelConfig[] = [];
		const routes = new Map<string, string>();
		for (const id of provider.models ?? []) {
			const entry = fromServer?.models.find((m) => m.id === id);
			if (!entry) continue;
			const model = mergeModelMetadata(
				entry,
				{ id },
				cfg.overrides[id] ?? {},
				api,
				entry.providerId ? undefined : catalog.find((m) => m.id === id),
			);
			addRoute(name, entry, model.id, routes);
			models.push(model);
		}
		register(name, api, models, routes);
	}

	const byId = new Map(discovery.customPool.map((m) => [m.id, m]));
	for (const [name, provider] of Object.entries(cfg.customProviders)) {
		if (!ALLOWED_APIS.has(provider.api)) {
			report.skipped.push({ provider: name, reason: `api "${provider.api}" not in allowlist` });
			continue;
		}
		// A group the operator configured explicitly may pin the wire protocol it
		// must speak. That is the supported way to serve, say, Codex models over
		// the Responses protocol when a relay reports the connector kind as
		// openai-completions: the operator's family wins, the gateway's is logged
		// so the difference stays visible. Nothing is inferred — an inherited
		// family still refuses a mismatch.
		const operatorApi = operatorConfig.customProviders[agpBaseName(name, profileIds)]?.api;
		const models: GatewayModelConfig[] = [];
		const routes = new Map<string, string>();
		for (const configured of provider.models) {
			const entry = byId.get(configured.id);
			if (!entry) continue;
			if (entry.api !== provider.api) {
				if (operatorApi === provider.api) {
					log.warn(
						`${name}: serving ${entry.id} over ${provider.api} by explicit configuration ` +
							`(the gateway advertised ${entry.api})`,
					);
				} else {
					throw new Error(`Model ${entry.id} requires ${entry.api}, not ${provider.api}`);
				}
			}
			const model = mergeModelMetadata(
				entry,
				configured,
				cfg.overrides[entry.id] ?? {},
				provider.api,
			);
			addRoute(name, entry, model.id, routes);
			models.push(model);
		}
		register(name, provider.api, models, routes);
	}
	const kept: string[] = [];
	for (const name of ownedNames) {
		if (registeredNames.has(name)) continue;
		if (options.keepNames?.has(name)) {
			kept.push(name);
			continue;
		}
		pi.unregisterProvider(name);
	}
	if (kept.length > 0) log.info(`kept ${kept.length} provider registration(s) for live sessions`);
	appliedProviderNames.set(pi, new Set([...registeredNames, ...kept]));
	log.info(
		`applyAll: registered ${report.registered.length} providers, skipped ${report.skipped.length}`,
	);
	return report;
}

function addRoute(
	name: string,
	entry: DiscoveryModelEntry,
	selector: string,
	routes: Map<string, string>,
): void {
	const wireId = entry.wireId ?? entry.id;
	if (entry.providerId && (!wireId.includes("/") || !entry.selectorId || selector.includes("/")))
		throw new Error(`Invalid gateway route: ${entry.id}`);
	if (routes.has(selector)) throw new Error(`Ambiguous selector ${name}/${selector}`);
	routes.set(selector, wireId);
}

/** Legacy display-oriented names are folded into safe provider slugs. */
export function registerAllSlug(suggested: string): string {
	return providerSlug(suggested);
}

/**
 * Apply one discovery, dropping the cached copy when the host rejects it.
 *
 * A pool that cannot be applied must never stay on disk. While it does, every
 * later start applies the same rejected copy, fails identically and never
 * reaches the network, so a single unroutable entry keeps the whole catalog
 * unregistered — the failure this wrapper exists to end. Invalidation happens
 * before the error propagates, so the next start (or the caller's refetch)
 * reads a usable pool. Only the profile that produced the rejected pool loses
 * its cache.
 */
export async function applyDiscovery(
	pi: ExtensionAPI,
	cfg: ProxyConfig,
	discovery: Discovery,
	options: ApplyOptions,
): Promise<ApplyReport> {
	try {
		return await applyAll(pi, cfg, discovery, options);
	} catch (err) {
		if (options.paths) invalidateDiscoveryCache(options.paths);
		log.warn("discovery rejected by the host — cache invalidated:", (err as Error).message);
		throw err;
	}
}
