import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { handleBbUsage } from "../src/bb-usage.ts";
import { AGP_DIR, profilePaths } from "../src/profiles.ts";
assert.ok(process.env.PI_GATEWAY_TEST_HOME && process.env.HOME === process.env.PI_GATEWAY_TEST_HOME);
mkdirSync(join(AGP_DIR, "profiles", "prod"), { recursive: true });
mkdirSync(join(AGP_DIR, "profiles", "test"), { recursive: true });
const registry = JSON.stringify({ schemaVersion: 1, defaultProfile: "test", profiles: { prod: { label: "PROD" }, test: { label: "TEST" } } });
writeFileSync(join(AGP_DIR, "profiles.json"), registry);
assert.deepEqual(await handleBbUsage({ operation: "inventory" }), { defaultProfile: "test", profiles: [{ id: "prod", label: "PROD" }, { id: "test", label: "TEST" }] });
const config = JSON.stringify({ proxy: { endpoint: "https://fixture.invalid/v1", apiKey: "synthetic-not-a-secret" } });
writeFileSync(profilePaths("test").configPath, config);
let calls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { calls++; throw new Error("network must not be used"); };
try {
  await assert.rejects(handleBbUsage({ operation: "reset", profileId: "test", revision: "stale", resourceId: "codex/account", reason: "fixture" }), /source changed/);
  assert.equal(calls, 0);
  await assert.rejects(handleBbUsage({ operation: "usage", profileId: "prod", force: true }), /profile operation failed/);
  assert.equal(existsSync(profilePaths("prod").configPath), false);
  assert.equal(readFileSync(join(AGP_DIR, "profiles.json"), "utf8"), registry);
  assert.equal(readFileSync(profilePaths("test").configPath, "utf8"), config);
} finally { globalThis.fetch = originalFetch; }
console.log("BB bridge: machine defaults, strict missing config and stale reset guard: passed");
