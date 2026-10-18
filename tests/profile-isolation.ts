// Per-profile isolation: prod and test are separate environments, not two
// views of the same state. Every assertion below fails if any artifact — the
// config file, the discovery cache, the usage cache, the usage lock or the
// invalidation path — is shared between the two profiles.
//
// Runs against a temp HOME through scripts/run-isolated.ts, so the profiles
// created here never touch the real ~/.pi/agent/ai-gateway layout.

import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { ProxyConfig } from "../src/config.ts";
import type { Discovery } from "../src/fetch-models.ts";
import type { UsageDocument } from "../src/fetch-usage.ts";

const home = process.env.PI_GATEWAY_TEST_HOME!;
assert.ok(home && process.env.HOME === home, "Run through scripts/run-isolated.ts");
const originalHome = process.env.HOME;
const originalProfileEnv = process.env.AGP_PROFILE;

process.env.HOME = home;

/** A complete config so saveConfig/loadConfig exercise the real schema. */
function configFor(endpoint: string, apiKey: string): ProxyConfig {
	return {
		proxy: { endpoint, apiKey },
		builtinProviders: {},
		customProviders: {},
		registerAll: true,
		discoveryExcludes: [],
		overrides: {},
		refreshIntervalMinutes: 0,
		usageCacheTtlMs: 15_000,
	};
}

function discoveryFor(upstreamVersion: string): Discovery {
	return {
		source: "well-known",
		upstreamVersion,
		builtinProviders: [],
		customPool: [],
		serverDiscoveryExcludes: [],
		upstreamTotal: 0,
	};
}

try {
	// Dynamic import after HOME isolation: profiles.ts/config.ts bind their
	// paths at module evaluation, exactly like the real extension does.
	const { loadConfig, saveConfig } = await import("../src/config.ts");
	const { ensureProfileLayout } = await import("../src/profiles-migration.ts");
	const { profilePaths, readRegistry, writeRegistry } = await import("../src/profiles.ts");
	const { readDiscoveryCache, writeDiscoveryCache, invalidateDiscoveryCache } = await import(
		"../src/cache.ts"
	);
	const { cacheScope } = await import("../src/cache-scope.ts");
	const {
		readUsageCache,
		writeUsageCache,
		tryAcquireUsageLock,
		releaseUsageLock,
	} = await import("../src/usage-shared-cache.ts");
	const { buildSnapshot } = await import("../src/profile-context.ts");
	const { PREFERRED_CONTRACT } = await import("../src/fetch-usage.ts");

	ensureProfileLayout();

	const prodPaths = profilePaths("prod");
	const testPaths = profilePaths("test");

	// 1. Each environment owns its config file, private and distinct.
	saveConfig("prod", configFor("https://prod.test/v1", "prod-key"), prodPaths);
	saveConfig("test", configFor("https://test.test/v1", "test-key"), testPaths);

	assert.ok(existsSync(prodPaths.configPath), "prod config must exist");
	assert.ok(existsSync(testPaths.configPath), "test config must exist");
	assert.equal(statSync(prodPaths.configPath).mode & 0o777, 0o600);
	assert.equal(statSync(testPaths.configPath).mode & 0o777, 0o600);
	assert.notEqual(prodPaths.dir, testPaths.dir, "profiles must not share a directory");
	assert.notEqual(prodPaths.configPath, testPaths.configPath);
	assert.equal(loadConfig("prod", prodPaths).proxy.endpoint, "https://prod.test/v1");
	assert.equal(loadConfig("test", testPaths).proxy.endpoint, "https://test.test/v1");

	// 2. The cache scopes are derived from each profile's own config, never
	// from another environment's selection.
	const prod = buildSnapshot({ id: "prod", source: "launch-env" }, "iso", 1);
	const test = buildSnapshot({ id: "test", source: "launch-env" }, "iso", 1);
	assert.equal(prod.discoveryScope, cacheScope("https://prod.test/v1", "prod-key", PREFERRED_CONTRACT));
	assert.equal(test.discoveryScope, cacheScope("https://test.test/v1", "test-key", PREFERRED_CONTRACT));
	assert.equal(
		prod.usageScope,
		cacheScope("https://prod.test/v1", "prod-key", PREFERRED_CONTRACT, ""),
	);
	assert.equal(
		test.usageScope,
		cacheScope("https://test.test/v1", "test-key", PREFERRED_CONTRACT, ""),
	);
	assert.notEqual(prod.discoveryScope, test.discoveryScope);
	assert.notEqual(prod.usageScope, test.usageScope);

	// 3. Interleaved discovery writes: a scope from the other environment is
	// never served, and each profile reads its own cache back unchanged.
	const prodDiscovery = discoveryFor("prod-fixture");
	const testDiscovery = discoveryFor("test-fixture");
	writeDiscoveryCache(prodPaths, prodDiscovery, prod.discoveryScope);
	writeDiscoveryCache(testPaths, testDiscovery, test.discoveryScope);
	assert.notEqual(prodPaths.discoveryCachePath, testPaths.discoveryCachePath);
	assert.equal(readDiscoveryCache(prodPaths, test.discoveryScope), null);
	assert.equal(readDiscoveryCache(testPaths, prod.discoveryScope), null);
	assert.deepEqual(readDiscoveryCache(prodPaths, prod.discoveryScope)?.discovery, prodDiscovery);
	assert.deepEqual(readDiscoveryCache(testPaths, test.discoveryScope)?.discovery, testDiscovery);

	// 4. Usage cache and lock are per profile: a prod fetch cannot feed test,
	// and a prod lock cannot hold a test instance behind it.
	const usage: UsageDocument = {
		schemaVersion: 1,
		generatedAt: "2026-10-19T00:00:00Z",
		accounts: [],
		unsupportedProviders: [],
	};
	writeUsageCache(prodPaths, usage, prod.usageScope);
	assert.equal(readUsageCache(testPaths, test.usageScope), null);
	assert.deepEqual(readUsageCache(prodPaths, prod.usageScope)?.doc, usage);

	const prodLock = tryAcquireUsageLock(prodPaths);
	assert.ok(prodLock, "prod must acquire its own usage lock");
	assert.ok(existsSync(prodPaths.usageLockPath));
	assert.equal(dirname(prodPaths.usageLockPath), prodPaths.dir);
	assert.notEqual(prodPaths.usageLockPath, testPaths.usageLockPath);
	assert.equal(existsSync(testPaths.usageLockPath), false, "prod lock must stay in prod's directory");

	const testLock = tryAcquireUsageLock(testPaths);
	assert.ok(testLock, "a test lock must not be blocked by the prod lock");
	assert.ok(existsSync(testPaths.usageLockPath));
	assert.equal(dirname(testPaths.usageLockPath), testPaths.dir);
	assert.ok(existsSync(prodPaths.usageLockPath), "the prod lock must still be its own");

	assert.equal(releaseUsageLock(prodPaths, `${prodLock}-not-ours`), false);
	assert.equal(releaseUsageLock(prodPaths, prodLock), true);
	assert.equal(releaseUsageLock(testPaths, testLock), true);
	assert.equal(existsSync(prodPaths.usageLockPath), false);
	assert.equal(existsSync(testPaths.usageLockPath), false);

	// 5. Invalidating one environment's discovery cannot touch the other's file.
	const testCacheBefore = readFileSync(testPaths.discoveryCachePath, "utf8");
	assert.ok(existsSync(prodPaths.discoveryCachePath));
	invalidateDiscoveryCache(prodPaths);
	assert.equal(existsSync(prodPaths.discoveryCachePath), false);
	assert.ok(existsSync(testPaths.discoveryCachePath));
	assert.equal(readFileSync(testPaths.discoveryCachePath, "utf8"), testCacheBefore);
	assert.equal(readDiscoveryCache(testPaths, test.discoveryScope)?.discovery.upstreamVersion, "test-fixture");

	// 6. The registry's default profile is persisted and readable back, and the
	// original registry survives once the test stops overriding it.
	const initialRegistry = readRegistry();
	assert.equal(initialRegistry.defaultProfile, "prod");
	try {
		writeRegistry({ ...initialRegistry, defaultProfile: "test" });
		assert.equal(readRegistry().defaultProfile, "test");
	} finally {
		writeRegistry(initialRegistry);
	}
	assert.equal(readRegistry().defaultProfile, initialRegistry.defaultProfile);

	console.log("ok profile-isolation: scopes, caches, lock, invalidation");
} finally {
	if (originalProfileEnv === undefined) delete process.env.AGP_PROFILE;
	else process.env.AGP_PROFILE = originalProfileEnv;
	process.env.HOME = originalHome;
}
