// Regression test for the AGP environment-profile layout.
//
// One plugin installation now hosts two environments (AGP prod and AGP test),
// each with its own config, discovery cache, usage cache and lock under
// ~/.pi/agent/ai-gateway/profiles/<id>/. The single pre-profile config and only
// the scope-matching legacy caches migrate once into `prod`; a legacy cache
// recorded for another endpoint/key is deliberately left where it is (never
// deleted) and the whole pass is idempotent once the marker exists.
//
// Runs under scripts/run-isolated.ts, so HOME already points at a fresh temp
// dir. Everything below is addressed through the production constants/helpers.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const home = process.env.PI_GATEWAY_TEST_HOME!;
assert.ok(home && process.env.HOME === home, "Run through scripts/run-isolated.ts");
const originalHome = process.env.HOME;
process.env.HOME = home;

const ENDPOINT = "https://legacy.test/v1";
const API_KEY = "literal-fake-key";
const USAGE_KEY = "literal-fake-usage";

// HOME is isolated before the runtime starts, but the production modules read
// homedir() at evaluation time, so they are imported only now.
const { cacheScope } = await import("../src/cache-scope.ts");
const {
	AGP_DIR,
	LEGACY_CONFIG_PATH: CONFIG_PATH,
	DEFAULT_REGISTRY,
	DIR_MODE,
	FILE_MODE,
	LEGACY_DISCOVERY_CACHE_PATH,
	LEGACY_USAGE_CACHE_PATH,
	LEGACY_USAGE_LOCK_PATH,
	REGISTRY_PATH,
	isValidProfileId,
	listProfileIds,
	profilePaths,
	readRegistry,
} = await import("../src/profiles.ts");
const { ALIAS_GROUP_EXCLUDES, ensureProfileLayout } = await import(
	"../src/profiles-migration.ts"
);
const { PREFERRED_CONTRACT } = await import("../src/fetch-usage.ts");

const modeOf = (path: string) => statSync(path).mode & 0o777;
const migrationMarkerPath = `${AGP_DIR}/.profile-migration.json`;

try {
	assert.equal(homedir(), home, "homedir() must resolve inside the isolated HOME");

	// --- 1. Registry bootstrap -------------------------------------------------
	// Reading the registry with no file present creates the built-in layout.
	const registry = readRegistry();
	assert.ok(existsSync(REGISTRY_PATH), "readRegistry() must create profiles.json");
	assert.equal(modeOf(REGISTRY_PATH), FILE_MODE, "profiles.json must be 0600");
	assert.deepEqual(
		JSON.parse(readFileSync(REGISTRY_PATH, "utf8")),
		{ schemaVersion: 1, defaultProfile: "prod", profiles: { prod: { label: "PROD" }, test: { label: "TEST" } } },
		"registry bootstrap must contain exactly the prod/test descriptors",
	);
	assert.deepEqual(readRegistry(), DEFAULT_REGISTRY);
	assert.deepEqual(listProfileIds(registry), ["prod", "test"]);

	// Laying out the profile tree creates the prod directory at 0700.
	ensureProfileLayout();
	assert.equal(modeOf(AGP_DIR), DIR_MODE, "AGP_DIR must be 0700");
	assert.equal(modeOf(profilePaths("prod").dir), DIR_MODE, "profiles/prod must be 0700");

	// --- 2. One-time migration, single pass ------------------------------------
	// The layout pass above may already have written the marker; the migration
	// behaviour under test requires the pass to run with legacy state present.
	if (existsSync(migrationMarkerPath)) rmSync(migrationMarkerPath, { force: true });

	const legacyConfig = {
		proxy: { endpoint: ENDPOINT, apiKey: API_KEY, usageKey: USAGE_KEY },
		builtinProviders: {},
		customProviders: {},
		registerAll: true,
		discoveryExcludes: ["*:*"],
		overrides: {},
		refreshIntervalMinutes: 0,
		usageCacheTtlMs: 15_000,
	};
	const legacyConfigText = `${JSON.stringify(legacyConfig, null, 2)}\n`;
	mkdirSync(AGP_DIR, { recursive: true });
	writeFileSync(CONFIG_PATH, legacyConfigText, { mode: 0o644 });

	const fixtureDiscovery = {
		source: "well-known" as const,
		upstreamVersion: null,
		builtinProviders: [],
		customPool: [],
		serverDiscoveryExcludes: [],
		upstreamTotal: 0,
	};
	// A legacy discovery cache recorded for a DIFFERENT endpoint can never be
	// prod's, so it must be left exactly where it is.
	const wrongDiscoveryScope = cacheScope("https://other.test/v1", API_KEY, PREFERRED_CONTRACT);
	const legacyDiscoveryText = JSON.stringify({
		savedAt: Date.now(),
		scope: wrongDiscoveryScope,
		discovery: fixtureDiscovery,
	});
	writeFileSync(LEGACY_DISCOVERY_CACHE_PATH, legacyDiscoveryText);

	// A legacy usage cache carrying prod's own scope must migrate.
	const matchingUsageScope = cacheScope(ENDPOINT, API_KEY, PREFERRED_CONTRACT, USAGE_KEY);
	const legacyUsageText = JSON.stringify({
		fetchedAt: Date.now(),
		scope: matchingUsageScope,
		doc: { schemaVersion: 1, accounts: [], unsupportedProviders: [] },
	});
	writeFileSync(LEGACY_USAGE_CACHE_PATH, legacyUsageText);
	writeFileSync(LEGACY_USAGE_LOCK_PATH, "");

	ensureProfileLayout();

	const prod = profilePaths("prod");
	assert.equal(existsSync(CONFIG_PATH), false, "the pre-profile config must be moved, not kept");
	assert.ok(existsSync(prod.configPath), "the config must migrate into prod");
	assert.equal(modeOf(prod.configPath), FILE_MODE, "the migrated config must be 0600");

	const migrated = JSON.parse(readFileSync(prod.configPath, "utf8")) as typeof legacyConfig;
	assert.equal(migrated.proxy.endpoint, ENDPOINT, "endpoint must survive migration verbatim");
	assert.equal(migrated.proxy.apiKey, API_KEY, "apiKey must survive migration verbatim");
	assert.equal(migrated.proxy.usageKey, USAGE_KEY, "usageKey must survive migration verbatim");
	assert.equal(migrated.registerAll, true, "registerAll must survive migration verbatim");
	assert.deepEqual(
		migrated.discoveryExcludes,
		["*:*", ...ALIAS_GROUP_EXCLUDES],
		"the alias pattern is appended after the existing excludes",
	);
	assert.deepEqual(ALIAS_GROUP_EXCLUDES, ["ds/*"]);

	assert.equal(existsSync(LEGACY_USAGE_CACHE_PATH), false, "the matching usage cache must move");
	assert.ok(existsSync(prod.usageCachePath), "the prod usage cache must exist after the move");
	assert.equal(modeOf(prod.usageCachePath), FILE_MODE, "the moved usage cache must be 0600");
	assert.equal(
		readFileSync(prod.usageCachePath, "utf8"),
		legacyUsageText,
		"a moved cache keeps its bytes",
	);
	assert.equal(existsSync(LEGACY_USAGE_LOCK_PATH), false, "the leftover lock must be removed");

	assert.ok(
		existsSync(LEGACY_DISCOVERY_CACHE_PATH),
		"a wrong-scope legacy discovery cache must be left in place",
	);
	assert.equal(
		readFileSync(LEGACY_DISCOVERY_CACHE_PATH, "utf8"),
		legacyDiscoveryText,
		"a wrong-scope legacy cache must be untouched",
	);
	assert.equal(
		existsSync(prod.discoveryCachePath),
		false,
		"a wrong-scope legacy cache must not be claimed by prod",
	);

	assert.ok(existsSync(migrationMarkerPath), "the migration marker must record the pass");

	// --- 3. Idempotence --------------------------------------------------------
	const configBytesAfterFirstPass = readFileSync(prod.configPath);
	ensureProfileLayout();
	assert.ok(
		readFileSync(prod.configPath).equals(configBytesAfterFirstPass),
		"a second EnsureProfileLayout() must not rewrite the migrated config",
	);
	assert.ok(
		existsSync(LEGACY_DISCOVERY_CACHE_PATH),
		"a second pass must not disturb the wrong-scope legacy cache",
	);

	// --- 4. Path isolation -----------------------------------------------------
	const prodPaths = profilePaths("prod");
	const testPaths = profilePaths("test");
	for (const field of ["dir", "configPath", "discoveryCachePath", "usageCachePath", "usageLockPath", "overlayPath"] as const) {
		assert.notEqual(testPaths[field], prodPaths[field], `${field} must not be shared across profiles`);
	}
	assert.equal(testPaths.id, "test");
	assert.equal(testPaths.dir, join(AGP_DIR, "profiles", "test"));

	for (const bad of ["..", ".", "Prod", "", "agp prod", "-prod"]) {
		assert.equal(isValidProfileId(bad), false, `isValidProfileId(${JSON.stringify(bad)}) must reject`);
	}
	for (const good of ["prod", "test", "team-a", "a.b_c"]) {
		assert.equal(isValidProfileId(good), true, `isValidProfileId(${JSON.stringify(good)}) must accept`);
	}

	console.log("ok profile-layout: registry, migration, isolation");
} finally {
	process.env.HOME = originalHome;
}
