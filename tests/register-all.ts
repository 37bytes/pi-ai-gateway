// Headless test for registerAll mode: with cfg.registerAll=true, every
// discovery builtin provider AND every custom-pool group is registered, no
// manual allowlist needed. Runs against a temp HOME with a seeded
// discovery-cache so no network fetch happens.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "pi-ai-gateway-all-"));
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
			registerAll: true,
		}),
	);
	writeFileSync(
		join(configDir, "discovery-cache.json"),
		JSON.stringify({
			savedAt: Date.now(),
			discovery: {
				source: "well-known",
				upstreamVersion: "agp",
				builtinProviders: [
					{
						name: "openai",
						api: "openai-responses",
						models: [
							{
								id: "codex/gpt-5.6-terra",
								name: "GPT-5.6 Terra",
								reasoning: true,
								contextWindow: 128_000,
								maxTokens: 16_000,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							},
							{
								id: "codex/gpt-5.4",
								name: "GPT-5.4",
								reasoning: true,
								contextWindow: 128_000,
								maxTokens: 16_000,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							},
						],
					},
				],
				customPool: [
					{
						id: "opencode/glm-5.2",
						name: "GLM 5.2",
						reasoning: true,
						contextWindow: 1_000_000,
						maxTokens: 131_072,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						api: "openai-completions",
						suggestedProvider: "opencode",
						ownedBy: "opencode",
					},
					{
						id: "chatgpt-web/instant",
						name: "ChatGPT Instant",
						reasoning: false,
						contextWindow: 128_000,
						maxTokens: 16_000,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						api: "openai-completions",
						suggestedProvider: "ChatGPT Web",
						ownedBy: "ChatGPT Web",
					},
					{
						id: "chatgpt-web/high",
						name: "ChatGPT High",
						reasoning: false,
						contextWindow: 128_000,
						maxTokens: 16_000,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						api: "openai-completions",
						suggestedProvider: "ChatGPT Web",
						ownedBy: "ChatGPT Web",
					},
				],
				serverDiscoveryExcludes: [],
				upstreamTotal: 5,
			},
		}),
	);

	let fetches = 0;
	globalThis.fetch = (async () => {
		fetches++;
		throw new Error("headless child must not fetch");
	}) as typeof fetch;

	// Dynamic import is required: config paths are computed at module
	// evaluation, so HOME must be isolated before index.ts (and its imports)
	// load — same pattern as headless-child.ts.
	const { default: aiGateway } = await import("../index.ts");

	const registered: Array<{ name: string; modelCount: number }> = [];
	await aiGateway({
		registerProvider(name: string, config: { models?: unknown[] }) {
			registered.push({ name, modelCount: config.models?.length ?? 0 });
		},
		registerCommand() {},
		on() {},
	} as unknown as Parameters<typeof aiGateway>[0]);

	const byName = Object.fromEntries(registered.map((r) => [r.name, r]));
	assert.deepEqual(Object.keys(byName).sort(), [
		"chatgpt-web",
		"openai",
		"opencode",
	]);
	assert.equal(byName.openai?.modelCount, 2);
	assert.equal(byName.opencode?.modelCount, 1);
	assert.equal(byName["chatgpt-web"]?.modelCount, 2);
	assert.equal(fetches, 0);
} finally {
	globalThis.fetch = originalFetch;
	process.argv.splice(0, process.argv.length, ...originalArgv);
	process.env.HOME = originalHome;
	rmSync(home, { recursive: true, force: true });
}
