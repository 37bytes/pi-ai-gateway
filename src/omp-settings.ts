// Per-session settings overrides for role mapping.
//
// The plugin does not edit the user's config: model roles are re-pointed at the
// selected environment through the host's runtime override layer, which is
// in-memory and never persisted. Two host surfaces can carry that override, and
// which one exists depends on the host version:
//
//   * `Settings#overrideModelRoles` / `#clearOverride` (present in 18.2 and, per
//     the running host's own `omp://extensions.md`, still present in 18.11.1), and
//   * the typed settings registry at `@oh-my-pi/pi-coding-agent/config/registry`
//     (`lookup("task.agentModelOverrides").override(settings, value)`), the
//     documented extension surface for settings the Settings class no longer
//     addresses by string path.
//
// An override is only reported as applied when the host's *effective* value
// reads back with exactly what was written. A surface that accepts the write
// without changing the effective value is not support, and neither is a probe
// that never verified anything: the plugin says "unavailable" instead, so the
// caller can tell the user which part of role inheritance this host cannot do.

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import { log } from "./log.ts";

type StringDict = Record<string, string>;

interface SettingsLike {
	getModelRoles?: () => unknown;
	overrideModelRoles?: (roles: StringDict) => void;
	clearOverride?: (path: string) => void;
	get?: (path: string) => unknown;
	override?: (path: string, value: unknown) => void;
}

interface RegistryHandle {
	get?: (scope: unknown) => unknown;
	override?: (scope: unknown, value: unknown) => void;
	clearOverride?: (scope: unknown) => void;
}

type RegistryLookup = (id: string) => RegistryHandle | undefined;

export type OverrideSupport = "settings" | "registry" | "unavailable";

export interface RoleSettingsPort {
	/** Which surface each override is applied through, verified by readback. */
	support: { roles: OverrideSupport; agentOverrides: OverrideSupport };
	effectiveRoles(): StringDict;
	effectiveAgentOverrides(): StringDict;
	/** Apply role selectors; true only when the host reads them back. */
	applyRoles(roles: StringDict): Promise<boolean>;
	applyAgentOverrides(overrides: StringDict): Promise<boolean>;
	/** Release this plugin's role overrides, restoring the configured values. */
	clearRoles(): Promise<boolean>;
	clearAgentOverrides(): Promise<boolean>;
}

const MODEL_ROLES_PATH = "modelRoles";
const AGENT_OVERRIDES_PATH = "task.agentModelOverrides";
const REGISTRY_MODULE = "@oh-my-pi/pi-coding-agent/config/registry";

function asStringDict(value: unknown): StringDict {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const out: StringDict = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (typeof entry === "string") out[key] = entry;
	}
	return out;
}

/** True when every written selector is the effective value afterwards. */
function readBackMatches(effective: StringDict, written: StringDict): boolean {
	for (const [key, value] of Object.entries(written)) {
		if (effective[key] !== value) return false;
	}
	return Object.keys(written).length > 0;
}

/** The host's settings instance, when the package exposes one. */
function settingsOf(pi: ExtensionAPI): SettingsLike | undefined {
	const candidate = (pi.pi as { settings?: unknown } | undefined)?.settings;
	if (!candidate || (typeof candidate !== "object" && typeof candidate !== "function")) return undefined;
	return candidate as SettingsLike;
}

/**
 * The typed registry, when this host ships it.
 *
 * Dynamic because a static import cannot work here: the subpath exists in the
 * running host (18.11.1 exports `@oh-my-pi/pi-coding-agent/config/registry`,
 * verified in its binary), but the peer dependency this package is built
 * against (18.2.0) has no such module, so the specifier is genuinely
 * runtime-selected. Same reason the transport builder is imported dynamically
 * in apply.ts.
 */
async function loadRegistry(): Promise<RegistryLookup | null> {
	try {
		const module = (await import(REGISTRY_MODULE)) as { lookup?: RegistryLookup };
		return typeof module.lookup === "function" ? module.lookup : null;
	} catch (err) {
		log.debug("typed settings registry unavailable:", (err as Error).message);
		return null;
	}
}

export function createRoleSettingsPort(pi: ExtensionAPI): RoleSettingsPort {
	const settings = settingsOf(pi);
	let registryPromise: Promise<RegistryLookup | null> | undefined;
	const registry = (): Promise<RegistryLookup | null> => (registryPromise ??= loadRegistry());

	// The exported settings object is a proxy that throws until the host
	// initializes it, so even probing a method has to be defensive: a host we
	// cannot drive reports "unavailable" instead of failing extension load.
	const supports = (method: keyof SettingsLike): boolean => {
		try {
			return typeof settings?.[method] === "function";
		} catch (err) {
			log.debug(`settings.${String(method)} unavailable:`, (err as Error).message);
			return false;
		}
	};

	const readRoles = (): StringDict => {
		if (!supports("getModelRoles")) return {};
		try {
			return asStringDict(settings!.getModelRoles!());
		} catch (err) {
			log.debug("failed to read model roles:", (err as Error).message);
			return {};
		}
	};

	/**
	 * Readback for verification. The registry handle reads the effective value
	 * on a host that no longer exposes Settings#getModelRoles, so it is tried
	 * first; the Settings getter covers hosts that only implement that.
	 */
	const readRolesVerified = async (): Promise<StringDict> => {
		const lookup = await registry();
		const handle = lookup?.(MODEL_ROLES_PATH);
		if (handle?.get) {
			try {
				const value = asStringDict(handle.get(settings));
				if (Object.keys(value).length > 0) return value;
			} catch (err) {
				log.debug("failed to read model roles from the registry:", (err as Error).message);
			}
		}
		return readRoles();
	};

	/** Agent overrides: prefer the registry handle's own readback. */
	const readAgentOverrides = async (): Promise<StringDict> => {
		const lookup = await registry();
		const handle = lookup?.(AGENT_OVERRIDES_PATH);
		if (handle?.get) {
			try {
				return asStringDict(handle.get(settings));
			} catch (err) {
				log.debug("failed to read task agent models from the registry:", (err as Error).message);
			}
		}
		if (supports("get")) {
			try {
				return asStringDict(settings!.get!(AGENT_OVERRIDES_PATH));
			} catch (err) {
				log.debug("failed to read agent model overrides:", (err as Error).message);
			}
		}
		return {};
	};

	const applyRoles = async (roles: StringDict): Promise<boolean> => {
		if (Object.keys(roles).length === 0) return true;
		if (supports("overrideModelRoles")) {
			try {
				settings!.overrideModelRoles!(roles);
				if (readBackMatches(await readRolesVerified(), roles)) {
					port.support.roles = "settings";
					return true;
				}
				log.warn("model roles were accepted but do not read back — trying the settings registry");
			} catch (err) {
				log.warn("failed to override model roles:", (err as Error).message);
			}
		}
		const lookup = await registry();
		const handle = lookup?.(MODEL_ROLES_PATH);
		if (handle?.override) {
			try {
				handle.override(settings, { ...(await readRolesVerified()), ...roles });
				if (readBackMatches(await readRolesVerified(), roles)) {
					port.support.roles = "registry";
					return true;
				}
				log.warn("model roles do not read back through the settings registry");
			} catch (err) {
				log.warn("failed to override model roles via the settings registry:", (err as Error).message);
			}
		}
		port.support.roles = "unavailable";
		return false;
	};

	const applyAgentOverrides = async (overrides: StringDict): Promise<boolean> => {
		if (Object.keys(overrides).length === 0) return true;
		const lookup = await registry();
		const handle = lookup?.(AGENT_OVERRIDES_PATH);
		if (handle?.override) {
			try {
				handle.override(settings, { ...(await readAgentOverrides()), ...overrides });
				if (readBackMatches(await readAgentOverrides(), overrides)) {
					port.support.agentOverrides = "registry";
					return true;
				}
				log.warn("task agent models do not read back through the settings registry");
			} catch (err) {
				log.warn("failed to override task agent models via the settings registry:", (err as Error).message);
			}
		}
		if (supports("override")) {
			try {
				settings!.override!(AGENT_OVERRIDES_PATH, {
					...(await readAgentOverrides()),
					...overrides,
				});
				if (readBackMatches(await readAgentOverrides(), overrides)) {
					port.support.agentOverrides = "settings";
					return true;
				}
				log.warn("task agent models were accepted but do not read back");
			} catch (err) {
				log.warn("failed to override task agent models:", (err as Error).message);
			}
		}
		port.support.agentOverrides = "unavailable";
		return false;
	};

	const clearOverrides = async (path: string): Promise<boolean> => {
		if (supports("clearOverride")) {
			try {
				settings!.clearOverride!(path);
				return true;
			} catch (err) {
				log.debug(`failed to clear ${path} override:`, (err as Error).message);
			}
		}
		const lookup = await registry();
		const handle = lookup?.(path);
		if (handle?.clearOverride) {
			try {
				handle.clearOverride(settings);
				return true;
			} catch (err) {
				log.debug(`failed to clear ${path} override via the registry:`, (err as Error).message);
			}
		}
		return false;
	};

	const port: RoleSettingsPort = {
		support: { roles: "unavailable", agentOverrides: "unavailable" },
		effectiveRoles: readRoles,
		effectiveAgentOverrides: () => {
			// Synchronous view for callers that must not await: only the string
			// path can be read synchronously, so an unreadable surface reports
			// "nothing configured" and applyRoleMapping will verify after writing.
			if (!supports("get")) return {};
			try {
				return asStringDict(settings!.get!(AGENT_OVERRIDES_PATH));
			} catch (err) {
				log.debug("failed to read agent model overrides:", (err as Error).message);
				return {};
			}
		},
		applyRoles,
		applyAgentOverrides,
		clearRoles: () => clearOverrides(MODEL_ROLES_PATH),
		clearAgentOverrides: () => clearOverrides(AGENT_OVERRIDES_PATH),
	};
	return port;
}
