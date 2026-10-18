// ~/.pi/agent/ai-gateway/profiles/<id>/config.json — migrate, load, validate, persist.
//
// One ProxyConfig per environment profile. The pre-profile single config
// (~/.pi/agent/ai-gateway/config.json) is migrated into the `prod` profile by
// profiles-migration, so `loadConfig("prod")` keeps seeing exactly the endpoint
// and credentials the single-endpoint plugin used.
//
// Schema:
//
//   {
//     "proxy": {
//       "endpoint": "https://your-proxy.example.com/v1",
//       "apiKey":   "!cat ~/.pi/agent/ai-gateway/key",
//       "providerPrefix": "myproxy",
//       "usageKey": "!cat ~/.pi/agent/ai-gateway/usage-key"
//     },
//     "builtinProviders": {
//       "openai":    { "enabled": true,  "apiOverride": null, "models": ["gpt-5.2"] },
//       "anthropic": { "enabled": true,                       "models": ["claude-opus-4-7"] }
//     },
//     "customProviders": {
//       "myproxy-glm": {
//         "api": "openai-completions",
//         "models": [{ "id": "glm-4.7", "name": "GLM 4.7", "contextWindow": 128000, "maxTokens": 16000, "reasoning": true }]
//       }
//     },
//     "registerAll": true,   // optional: register EVERY provider/model the gateway reports
//                            // with explicit matching model settings preserved
//     "discoveryExcludes": ["*:*"],
//     "overrides": {},
//     "refreshIntervalMinutes": 0,
//     "usageCacheTtlMs": 15000
//   }

import { execSync } from "node:child_process";
import { constants, copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import type { Api } from "@oh-my-pi/pi-ai";

import { log } from "./log.ts";
import {
	AGP_DIR,
	DEFAULT_PROFILE,
	LEGACY_CONFIG_PATH as LEGACY_AGP_CONFIG_PATH,
	type ProfilePaths,
	profilePaths,
	writePrivateFileAtomic,
} from "./profiles.ts";

/** Root of every profile-independent plugin asset (e.g. a shared key file). */
export const CONFIG_DIR = AGP_DIR;
/** The pre-profile config location; only migration input now. */
export const CONFIG_PATH = LEGACY_AGP_CONFIG_PATH;
const UPSTREAM_CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-cliproxyapi", "config.json");
/** The oldest single-endpoint config location (pre-v0.4.0). */
const LEGACY_CLIPROXY_CONFIG_PATH = join(homedir(), ".config", "pi-cliproxyapi", "config.json");

export function isLocalCheckout(): boolean {
	return existsSync(join(dirname(fileURLToPath(import.meta.url)), "..", ".git"));
}

function migrateConfig(
	sourcePath: string,
	configPath: string,
	localCheckout: boolean,
	sourceName: string,
): void {
	if (existsSync(configPath) || !existsSync(sourcePath)) return;
	let temporaryPath: string | undefined;
	try {
		mkdirSync(dirname(configPath), { recursive: true });
		temporaryPath = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
		copyFileSync(sourcePath, temporaryPath, constants.COPYFILE_EXCL);
		linkSync(temporaryPath, configPath);
		rmSync(temporaryPath);
		temporaryPath = undefined;
		if (!localCheckout) rmSync(sourcePath);
		log.info(
			localCheckout ? `${sourceName} config copied to` : `${sourceName} config moved to`,
			configPath,
		);
	} catch (err) {
		if (temporaryPath) {
			try {
				rmSync(temporaryPath, { force: true });
			} catch (cleanupErr) {
				log.warn("failed to clean temporary config:", cleanupErr);
			}
		}
		log.warn(`failed to migrate ${sourceName} config:`, err);
	}
}

/** Migrate the v0.4.3 upstream config into the legacy profile's namespace. */
export function migrateUpstreamConfig(
	sourcePath = UPSTREAM_CONFIG_PATH,
	configPath = profilePaths(DEFAULT_PROFILE).configPath,
	localCheckout = isLocalCheckout(),
): void {
	migrateConfig(sourcePath, configPath, localCheckout, "upstream");
}

/** Migrate the pre-v0.4.0 config location, preserving upstream behavior. */
export function migrateLegacyConfig(
	legacyPath = LEGACY_CLIPROXY_CONFIG_PATH,
	configPath = profilePaths(DEFAULT_PROFILE).configPath,
	localCheckout = isLocalCheckout(),
): void {
	migrateConfig(legacyPath, configPath, localCheckout, "legacy");
}

export interface BuiltinProviderConfig {
	enabled: boolean;
	apiOverride?: Api | null;
	models: string[];
}

export interface CustomProviderModelConfig {
	id: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	input?: ("text" | "image")[];
	cost?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
	};
}

export interface CustomProviderConfig {
	api: Api;
	models: CustomProviderModelConfig[];
}

export interface ProxyConfig {
	proxy: {
		endpoint: string;
		apiKey: string;
		usageKey?: string;
		/** Prefix used for default custom-provider slugs, e.g. `myproxy` -> `myproxy-glm`. */
		providerPrefix?: string;
	};
	builtinProviders: Record<string, BuiltinProviderConfig>;
	customProviders: Record<string, CustomProviderConfig>;
	/**
	 * Register mode. When true, every provider and model the gateway reports in
	 * discovery is registered with OMP: each builtin provider (openai, anthropic,
	 * …) with ALL of its models, and every custom-pool group as its own provider.
	 * Explicit settings for matching models are preserved. Unrelated custom
	 * providers remain explicit; connector-backed groups use the server namespace.
	 */
	registerAll: boolean;
	discoveryExcludes: string[];
	overrides: Record<string, Partial<CustomProviderModelConfig>>;
	refreshIntervalMinutes: number;
	usageCacheTtlMs: number;
}

const DEFAULT_CONFIG: ProxyConfig = {
	proxy: {
		endpoint: "",
		apiKey: "",
	},
	builtinProviders: {},
	customProviders: {},
	registerAll: false,
	discoveryExcludes: ["*:*"],
	overrides: {},
	refreshIntervalMinutes: 0,
	usageCacheTtlMs: 15_000,
};

/**
 * Load one profile's config. Only the legacy profile also consults the
 * pre-profile single-endpoint sources: an upstream or legacy config describes
 * THE single endpoint this machine used before profiles existed, so it can only
 * belong to `prod`.
 */
export function loadConfig(
	profileId: string = DEFAULT_PROFILE,
	paths: ProfilePaths = profilePaths(profileId),
): ProxyConfig {
	if (profileId === DEFAULT_PROFILE) {
		migrateUpstreamConfig(UPSTREAM_CONFIG_PATH, paths.configPath);
		migrateLegacyConfig(LEGACY_CLIPROXY_CONFIG_PATH, paths.configPath);
	}
	if (!existsSync(paths.configPath)) {
		log.info(`config not found for profile ${profileId}, using defaults at`, paths.configPath);
		return structuredClone(DEFAULT_CONFIG);
	}
	try {
		const raw = JSON.parse(readFileSync(paths.configPath, "utf8"));
		return normalizeConfig(raw);
	} catch (err) {
		log.error(`failed to read config for profile ${profileId}:`, err, "— using defaults");
		return structuredClone(DEFAULT_CONFIG);
	}
}

/** Persist one profile's config, 0600 and atomically. */
export function saveConfig(
	profileId: string,
	cfg: ProxyConfig,
	paths: ProfilePaths = profilePaths(profileId),
): void {
	writePrivateFileAtomic(paths.configPath, `${JSON.stringify(cfg, null, 2)}\n`);
	log.info(`config saved for profile ${profileId} to`, paths.configPath);
}

function normalizeConfig(raw: unknown): ProxyConfig {
	if (!raw || typeof raw !== "object") return structuredClone(DEFAULT_CONFIG);
	const r = raw as Record<string, unknown>;
	const merged = structuredClone(DEFAULT_CONFIG);
	const proxyBlock = (r.proxy as Record<string, unknown> | undefined) ?? {};
	merged.proxy.endpoint =
		typeof proxyBlock.endpoint === "string" ? proxyBlock.endpoint : merged.proxy.endpoint;
	merged.proxy.apiKey = typeof proxyBlock.apiKey === "string" ? proxyBlock.apiKey : "";
	if (typeof proxyBlock.usageKey === "string") merged.proxy.usageKey = proxyBlock.usageKey;
	if (typeof proxyBlock.providerPrefix === "string" && proxyBlock.providerPrefix.trim()) {
		merged.proxy.providerPrefix = proxyBlock.providerPrefix.trim();
	}

	if (r.builtinProviders && typeof r.builtinProviders === "object") {
		merged.builtinProviders = r.builtinProviders as Record<string, BuiltinProviderConfig>;
	}
	if (r.customProviders && typeof r.customProviders === "object") {
		merged.customProviders = r.customProviders as Record<string, CustomProviderConfig>;
	}
	if (typeof r.registerAll === "boolean") merged.registerAll = r.registerAll;
	if (Array.isArray(r.discoveryExcludes)) {
		merged.discoveryExcludes = r.discoveryExcludes.filter(
			(x): x is string => typeof x === "string",
		);
	}
	if (r.overrides && typeof r.overrides === "object") {
		merged.overrides = r.overrides as Record<string, Partial<CustomProviderModelConfig>>;
	}
	if (typeof r.refreshIntervalMinutes === "number")
		merged.refreshIntervalMinutes = r.refreshIntervalMinutes;
	if (typeof r.usageCacheTtlMs === "number") merged.usageCacheTtlMs = r.usageCacheTtlMs;
	return merged;
}

/**
 * resolveConfigValue — same semantics Pi uses for apiKey:
 *   "!cmd ..."     → run command, take stdout, trim
 *   "$ENV_VAR"     → read process.env[ENV_VAR]
 *   any other str  → return as-is
 * Empty / undefined → "".
 *
 * We re-implement it locally rather than reach into pi internals; resolution
 * happens once at apply time so the resolved key can be passed to
 * pi.registerProvider verbatim.
 */
export function resolveConfigValue(raw: string | undefined | null): string {
	if (!raw) return "";
	const v = raw.trim();
	if (v.startsWith("!")) {
		try {
			return execSync(v.slice(1), {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			}).trim();
		} catch (err) {
			// Don't dump stack traces for the common "file not found" case — just say what didn't resolve.
			log.warn('failed to resolve "!" config value');
			return "";
		}
	}
	if (v.startsWith("$")) {
		return process.env[v.slice(1)] ?? "";
	}
	return v;
}
