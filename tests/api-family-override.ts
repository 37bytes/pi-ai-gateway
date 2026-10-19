// Regression: a generic OpenAI-compatible relay advertises the connector family
// as `openai-completions`, but Codex models must be served over the Responses
// protocol. An operator may pin that family explicitly in `customProviders`;
// without such an explicit pin the discovered family stays authoritative.
//
// Covers three things end to end:
//   1. an explicit per-provider override is honoured when applying discovery;
//   2. two DISCOVERED families for one namespace are still refused, and an
//      operator family only relaxes the check when the operator configured it;
//   3. the wire request keeps the exact route and credentials (`/responses`,
//      `Bearer <relay key>`, no api-key headers) and the identity guard holds.

import assert from "node:assert/strict";
import type { ExtensionAPI, ProviderConfig } from "@oh-my-pi/pi-coding-agent";
import type { ProxyConfig } from "../src/config.ts";
import type { Discovery, DiscoveryCustomEntry } from "../src/fetch-models.ts";

const home = process.env.PI_GATEWAY_TEST_HOME!;
assert.ok(home && process.env.HOME === home, "Run through scripts/run-isolated.ts");
const originalHome = process.env.HOME;
const originalFetch = globalThis.fetch;
process.env.HOME = home;
// A static import cannot work here: src/apply.ts computes its config/cache
// paths when the module evaluates, so HOME must be isolated first. The dynamic
// import deliberately exercises that startup boundary.
const { applyAll, registrationConfig } = await import("../src/apply.ts");

const cfg: ProxyConfig = {
	proxy: { endpoint: "https://relay.test/v1", apiKey: "relay-key" },
	builtinProviders: {},
	customProviders: { codex: { api: "openai-responses", models: [] } },
	registerAll: true,
	discoveryExcludes: [],
	overrides: {},
	refreshIntervalMinutes: 0,
	usageCacheTtlMs: 15_000,
};

/** What a generic openai-compatible relay reports for a Codex connector model. */
function entry(overrides: Partial<DiscoveryCustomEntry> = {}): DiscoveryCustomEntry {
	return {
		id: "codex/gpt-6-astra",
		wireId: "codex/gpt-6-astra",
		selectorId: "gpt-6-astra",
		canonicalModel: "codex/gpt-6-astra",
		providerId: "11111111-2222-3333-4444-555555555555",
		providerKind: "openai_compatible",
		suggestedProvider: "codex",
		ownedBy: "codex",
		name: "codex · gpt-6-astra",
		api: "openai-completions",
		metadataState: "catalog",
		// This suite pins the explicit protocol override, the wire id and the
		// credential, so the fixture states a known price and explicit limits —
		// the shape a real gateway reports. Unknown-price behaviour is covered by
		// model-contract, not here.
		priceState: "known",
		cost: { input: 2.5, output: 10, cacheRead: 0.25, cacheWrite: 2.5 },
		contextWindow: 200_000,
		maxTokens: 32_000,
		input: ["text"],
		reasoning: false,
		...overrides,
	};
}

function discovery(customPool: DiscoveryCustomEntry[]): Discovery {
	return {
		source: "well-known",
		upstreamVersion: "fixture",
		builtinProviders: [],
		customPool,
		serverDiscoveryExcludes: [],
		upstreamTotal: customPool.length,
	};
}

const applyOptions = {
	profile: "test",
	profileIds: ["prod", "test"] as const,
};

/** Minimal OpenAI Responses SSE stream that the native transport accepts. */
function responsesSse(wireId: string): Response {
	const item = {
		id: "msg-fixture",
		type: "message",
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text: "ok", annotations: [] }],
	};
	const events: Record<string, unknown>[] = [
		{
			type: "response.created",
			response: { id: "resp-fixture", model: wireId, status: "in_progress", output: [] },
		},
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { ...item, status: "in_progress", content: [] },
		},
		{
			type: "response.content_part.added",
			item_id: item.id,
			output_index: 0,
			content_index: 0,
			part: { type: "output_text", text: "", annotations: [] },
		},
		{
			type: "response.output_text.delta",
			item_id: item.id,
			output_index: 0,
			content_index: 0,
			delta: "ok",
		},
		{ type: "response.output_item.done", output_index: 0, item },
		{
			type: "response.completed",
			response: {
				id: "resp-fixture",
				model: wireId,
				status: "completed",
				output: [item],
				usage: {
					input_tokens: 2,
					output_tokens: 1,
					total_tokens: 3,
					input_tokens_details: { cached_tokens: 0 },
					output_tokens_details: { reasoning_tokens: 0 },
				},
			},
		},
	];
	const frames = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const frame of frames) controller.enqueue(encoder.encode(frame));
			controller.close();
		},
	});
	return new Response(body, {
		headers: { "Content-Type": "text/event-stream", "X-Request-ID": "fixture-request-id" },
	});
}

try {
	// 1. The explicit override is applied: the operator's `openai-responses`
	// group survives discovery advertising `openai-completions`.
	const registrations = new Map<string, ProviderConfig>();
	const pi = {
		registerProvider(name: string, config: ProviderConfig) {
			registrations.set(name, config);
		},
		unregisterProvider(name: string) {
			registrations.delete(name);
		},
	} as ExtensionAPI;
	const report = await applyAll(pi, cfg, discovery([entry()]), applyOptions);
	assert.deepEqual(
		report.registered.map((r) => r.provider),
		["codex"],
	);
	assert.equal(registrations.size, 1);
	const registered = registrations.get("codex")!;
	assert.ok(registered, "the override group must register under its namespaced name");
	assert.equal(
		registered.api,
		"agp:codex:openai-responses",
		"the operator's explicit Responses family must win over the discovered one",
	);
	assert.ok(
		registered.models?.some((model) => model.id === "gpt-6-astra"),
		"the local selector id must still be exposed",
	);

	// 2a. Two DISCOVERED families for one namespace are refused when the
	// operator did not configure the group.
	const conflicting = discovery([
		entry(),
		entry({
			id: "codex/gpt-6-astra-alt",
			wireId: "codex/gpt-6-astra-alt",
			selectorId: "gpt-6-astra-alt",
			canonicalModel: "codex/gpt-6-astra-alt",
			api: "anthropic-messages",
		}),
	]);
	assert.throws(
		() => registrationConfig({ ...cfg, customProviders: {} }, conflicting, "test"),
		/Conflicting API families/,
	);

	// 2b. An explicit group only relaxes the family check for the exact family
	// the operator configured. A second explicit group colliding onto the same
	// namespaced namespace under another family makes the operator lookup
	// resolve to a different family, so the strict check still throws — the
	// override is never inferred.
	const collidingCfg: ProxyConfig = {
		...cfg,
		customProviders: {
			codex: { api: "openai-completions", models: [{ id: "codex/gpt-6-astra" }] },
			CODEX: { api: "anthropic-messages", models: [{ id: "codex/gpt-6-astra" }] },
		},
	};
	const collidingPi = {
		registerProvider() {},
		unregisterProvider() {},
	} as unknown as ExtensionAPI;
	await assert.rejects(
		applyAll(collidingPi, collidingCfg, discovery([entry()]), applyOptions),
		/requires openai-completions, not anthropic-messages/,
	);

	// 3. The wire request keeps the exact route and credentials.
	const selected = {
		...registered.models!.find((model) => model.id === "gpt-6-astra")!,
		provider: "codex",
		api: registered.api!,
		baseUrl: registered.baseUrl!,
		compat: undefined,
	};
	const context = {
		messages: [{ role: "user" as const, content: "fixture request", timestamp: 0 }],
	};
	assert.throws(
		() =>
			registered.streamSimple!({ ...selected, provider: "deepseek" }, context, {
				apiKey: "relay-key",
			}),
		/transport identity/,
	);

	let recorded: { url: string; headers: Headers; body: Record<string, unknown> } | undefined;
	let requests = 0;
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		requests++;
		const request = new Request(input, init);
		recorded = {
			url: request.url,
			headers: request.headers,
			body: (await request.json()) as Record<string, unknown>,
		};
		return responsesSse("codex/gpt-6-astra");
	}) as typeof fetch;
	const result = await registered
		.streamSimple!(selected, context, {
			apiKey: "relay-key",
			sessionId: "session-fixture",
			headers: {
				Authorization: "Bearer wrong-provider-key",
				"x-api-key": "wrong-provider-key",
				"api-key": "wrong-provider-key",
			},
		})
		.result();
	assert.equal(result.stopReason, "stop", result.errorMessage);
	assert.ok(recorded, "the registered transport must dispatch exactly one request");
	assert.equal(requests, 1);
	assert.equal(new URL(recorded!.url).pathname, "/v1/responses");
	assert.equal(recorded!.headers.get("authorization"), "Bearer relay-key");
	assert.equal(recorded!.headers.get("x-api-key"), null);
	assert.equal(recorded!.headers.get("api-key"), null);
	assert.equal(
		recorded!.body.model,
		"codex/gpt-6-astra",
		"the wire id must be the exact gateway route, not a selector",
	);

	console.log("ok api-family-override: explicit override, conflict refusal, wire+auth target");
} finally {
	globalThis.fetch = originalFetch;
	process.env.HOME = originalHome;
}
