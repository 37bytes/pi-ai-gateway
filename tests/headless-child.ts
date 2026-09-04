import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "pi-ai-gateway-child-"));
const originalHome = process.env.HOME;
const originalArgv = [...process.argv];
const originalFetch = globalThis.fetch;

try {
	process.env.HOME = home;
	process.argv.splice(
		2,
		process.argv.length - 2,
		"--mode",
		"json",
		"-p",
		"--no-session",
	);

	const configDir = join(home, ".pi", "agent", "ai-gateway");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(
		join(configDir, "config.json"),
		JSON.stringify({
			proxy: { endpoint: "https://proxy.test/v1", apiKey: "test-key" },
			builtinProviders: {
				openai: { enabled: true, models: ["gpt-test"] },
			},
		}),
	);
	writeFileSync(
		join(configDir, "discovery-cache.json"),
		JSON.stringify({
			savedAt: Date.now(),
			discovery: {
				source: "well-known",
				upstreamVersion: null,
				builtinProviders: [
					{
						name: "openai",
						api: "openai-responses",
						models: [
							{
								id: "gpt-test",
								name: "GPT test",
								reasoning: false,
								contextWindow: 128_000,
								maxTokens: 16_000,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							},
						],
					},
				],
				customPool: [],
				serverDiscoveryExcludes: [],
				upstreamTotal: 1,
			},
		}),
	);

	let fetches = 0;
	globalThis.fetch = (async () => {
		fetches++;
		throw new Error("headless child must not fetch");
	}) as typeof fetch;

	const { default: aiGateway, isHeadlessRun } = await import("../index.ts");
	assert.equal(isHeadlessRun(), true);
	assert.equal(isHeadlessRun(["pi"]), false);

	const providers: string[] = [];
	const commands: string[] = [];
	const events: string[] = [];
	await aiGateway({
		registerProvider(name: string) {
			providers.push(name);
		},
		registerCommand(name: string) {
			commands.push(name);
		},
		on(name: string) {
			events.push(name);
		},
	} as unknown as Parameters<typeof aiGateway>[0]);

	assert.deepEqual(providers, ["openai"]);
	assert.deepEqual(commands, []);
	assert.deepEqual(events, []);
	assert.equal(fetches, 0);
} finally {
	globalThis.fetch = originalFetch;
	process.argv.splice(0, process.argv.length, ...originalArgv);
	process.env.HOME = originalHome;
	rmSync(home, { recursive: true, force: true });
}
