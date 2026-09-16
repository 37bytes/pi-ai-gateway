import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Api } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ProviderConfig } from "@oh-my-pi/pi-coding-agent";
import { createAssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import { createLatencyDiagnostics } from "../src/latency.ts";
import type { ProxyConfig } from "../src/config.ts";
import type { Discovery, DiscoveryCustomEntry } from "../src/fetch-models.ts";
import type { UsageAccount, UsageDocument } from "../src/fetch-usage.ts";
import { cacheScope } from "../src/cache-scope.ts";
import { renderQuotaSegment } from "../src/status-quota.ts";
import { renderUsage } from "../src/ui-usage.ts";

const home = process.env.PI_GATEWAY_TEST_HOME!;
assert.ok(home && process.env.HOME === home, "Run through scripts/run-isolated.ts");
const originalHome = process.env.HOME;
const originalFetch = globalThis.fetch;
const originalLatency = process.env.PI_AI_GATEWAY_LATENCY;
const originalLatencyFile = process.env.PI_AI_GATEWAY_LATENCY_FILE;
const latencyFile = join(home, "latency.jsonl");
process.env.HOME = home;
// These imports intentionally exercise startup after HOME isolation; a static
// import would bind the real user's config/cache paths before the fixture runs.
const { applyAll, mergeModelMetadata, registrationConfig } = await import("../src/apply.ts");
const { fetchDiscovery } = await import("../src/fetch-models.ts");
const { fetchUsage, clearUsageCache } = await import("../src/fetch-usage.ts");
const { DISCOVERY_CACHE_PATH, readDiscoveryCache, writeDiscoveryCache } = await import(
	"../src/cache.ts"
);
const { USAGE_CACHE_PATH, readUsageCache, writeUsageCache } = await import(
	"../src/usage-shared-cache.ts"
);

const cfg: ProxyConfig = {
	proxy: { endpoint: "https://gateway.test/v1", apiKey: "fixture-key", providerPrefix: "cpa" },
	builtinProviders: {},
	customProviders: {},
	registerAll: true,
	discoveryExcludes: [],
	overrides: {},
	refreshIntervalMinutes: 0,
	usageCacheTtlMs: 15_000,
};
const model: DiscoveryCustomEntry = {
	id: "codex/gpt-6-astra",
	wireId: "codex/gpt-6-astra",
	selectorId: "gpt-6-astra",
	providerId: "connector-a",
	providerKind: "codex",
	canonicalModel: "openai/gpt-6-astra",
	name: "GPT-6 Astra",
	api: "openai-responses",
	suggestedProvider: "codex",
	ownedBy: "codex",
	metadataState: "catalog",
	priceState: "known",
	reasoning: true,
	input: ["text", "image"],
	contextWindow: 1_050_000,
	maxTokens: 128_000,
	cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
};
const discovery: Discovery = {
	source: "well-known",
	upstreamVersion: "fixture",
	builtinProviders: [],
	customPool: [model],
	serverDiscoveryExcludes: [],
	upstreamTotal: 1,
};
const usage: UsageDocument = {
	schemaVersion: 1,
	generatedAt: "2026-09-15T12:00:00Z",
	accounts: [],
	unsupportedProviders: [],
};
const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", "X-Pi-Contract": "2" },
	});

function sse(api: Api): Response {
	let events: Record<string, unknown>[];
	if (api === "openai-completions") {
		const base = {
			id: "chat-fixture",
			object: "chat.completion.chunk",
			created: 0,
			model: model.id,
		};
		events = [
			{ ...base, choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] },
			{
				...base,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
			},
		];
	} else if (api === "openai-responses") {
		const item = {
			id: "msg-fixture",
			type: "message",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: "ok", annotations: [] }],
		};
		events = [
			{
				type: "response.created",
				response: { id: "resp-fixture", model: model.id, status: "in_progress", output: [] },
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
					model: model.id,
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
	} else {
		events = [
			{
				type: "message_start",
				message: {
					id: "msg-fixture",
					type: "message",
					role: "assistant",
					model: model.id,
					content: [],
					stop_reason: null,
					usage: {
						input_tokens: 2,
						output_tokens: 0,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				},
			},
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
			{ type: "content_block_stop", index: 0 },
			{
				type: "message_delta",
				delta: { stop_reason: "end_turn", stop_sequence: null },
				usage: { output_tokens: 1 },
			},
			{ type: "message_stop" },
		];
	}
	const frames = events.map(
		(event) => `${event.type ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`,
	);
	if (api === "openai-completions") frames.push("data: [DONE]\n\n");
	const encoder = new TextEncoder();
	let cancelled = false;
	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			for (const frame of frames) {
				await delay(5);
				if (cancelled) return;
				controller.enqueue(encoder.encode(frame));
			}
			if (!cancelled) controller.close();
		},
		cancel() {
			cancelled = true;
		},
	});
	return new Response(body, {
		headers: { "Content-Type": "text/event-stream", "X-Request-ID": "fixture-request-id" },
	});
}

function account(providerId: string, remainingFraction: number): UsageAccount {
	return {
		provider: "codex",
		providerId,
		scope: "provider_subscription",
		account: `opaque-${providerId}`,
		authIndex: `opaque-${providerId}`,
		label: "Subscription",
		status: "active",
		disabled: false,
		unavailable: false,
		success: 0,
		failed: 0,
		lastRequestAt: null,
		supported: true,
		groups: [
			{
				id: "five-hour",
				label: "5h",
				state: "supported",
				remainingFraction,
				resetTime: new Date(Date.now() + 3_600_000).toISOString(),
				capturedAt: new Date().toISOString(),
			},
		],
	};
}

try {
	globalThis.fetch = (async () =>
		json({
			schemaVersion: 1,
			builtinProviders: {},
			customModelPool: [{ ...model, suggestedProviderName: "codex" }],
		})) as typeof fetch;
	const discovered = await fetchDiscovery(cfg, "fixture-key");
	assert.equal(
		discovered.customPool[0]?.suggestedProvider,
		"codex",
		"legacy prefix must not rename a connector namespace",
	);
	assert.deepEqual(discovered.customPool[0]?.cost, model.cost);
	assert.equal(discovered.customPool[0]?.contextWindow, 1_050_000);

	const unknownRaw = {
		...model,
		metadataState: "unknown",
		priceState: "unknown",
		contextWindow: 128_000,
		maxTokens: 16_000,
		cost: { input: 0, output: 0 },
	};
	globalThis.fetch = (async () =>
		json({
			schemaVersion: 1,
			customModelPool: [{ ...unknownRaw, suggestedProviderName: "codex" }],
		})) as typeof fetch;
	const unknown = (await fetchDiscovery(cfg, "fixture-key")).customPool[0]!;
	for (const key of ["contextWindow", "maxTokens", "reasoning", "input", "cost"])
		assert.equal(Object.hasOwn(unknown, key), false, key);
	const overridden = mergeModelMetadata(
		model,
		{ id: model.id, contextWindow: 900_000, cost: { input: 11 } },
		{ contextWindow: 1_100_000, cost: { input: 12, output: 0 } },
		model.api,
	);
	assert.equal(overridden.contextWindow, 1_100_000);
	assert.equal(overridden.maxTokens, 128_000);
	assert.equal(overridden.metadataState, "override");
	assert.deepEqual(overridden.cost, { input: 12, output: 0, cacheRead: 1, cacheWrite: 12.5 });
	const partial = mergeModelMetadata(
		{ ...unknown, cost: { input: 3 }, priceState: "partial" },
		{ id: model.id },
		{},
		model.api,
	);
	assert.deepEqual(partial.cost, { input: 3 });
	assert.equal(partial.priceState, "partial");
	assert.equal(partial.contextWindow, undefined);

	const explicit: ProxyConfig = {
		...cfg,
		customProviders: {
			codex: {
				api: model.api,
				models: [{ id: model.id, name: "Operator Astra", maxTokens: 64_000 }],
			},
			"local-private": {
				api: "openai-completions",
				models: [{ id: "legacy-only", contextWindow: 32_000 }],
			},
			"retained-custom": {
				api: model.api,
				models: [
					{
						id: model.id,
						name: "Retained operator model",
						contextWindow: 512_000,
						cost: { input: 17 },
					},
				],
			},
		},
	};
	const effective = registrationConfig(explicit, discovery);
	assert.deepEqual(
		effective.customProviders["local-private"],
		explicit.customProviders["local-private"],
	);
	assert.equal(effective.customProviders.codex?.models[0]?.name, "Operator Astra");
	assert.equal(explicit.customProviders.codex?.models[0]?.maxTokens, 64_000);
	const retainedRegistrations = new Map<string, ProviderConfig>();
	await applyAll(
		{
			registerProvider(name: string, config: ProviderConfig) {
				retainedRegistrations.set(name, config);
			},
		} as ExtensionAPI,
		explicit,
		discovery,
	);
	assert.equal(
		retainedRegistrations.get("retained-custom")?.models?.[0]?.name,
		"Retained operator model",
	);
	assert.equal(retainedRegistrations.get("retained-custom")?.models?.[0]?.contextWindow, 512_000);
	assert.equal(retainedRegistrations.get("retained-custom")?.models?.[0]?.cost.input, 17);
	assert.equal(retainedRegistrations.get("codex")?.models?.[0]?.maxTokens, 64_000);
	assert.equal(retainedRegistrations.get("codex")?.models?.[0]?.cost.input, 10);

	const liveRegistry = new Map<string, ProviderConfig>([["another-extension", {}]]);
	const liveAPI = {
		registerProvider(name: string, config: ProviderConfig) {
			liveRegistry.set(name, config);
		},
		unregisterProvider(name: string) {
			liveRegistry.delete(name);
		},
	} as ExtensionAPI;
	const legacyAlias = {
		...model,
		id: "cx/gpt-6-astra",
		wireId: "cx/gpt-6-astra",
		suggestedProvider: "cx",
	};
	await applyAll(liveAPI, explicit, { ...discovery, customPool: [model, legacyAlias] });
	assert.ok(liveRegistry.has("cx"), "fixture must start with an announced legacy namespace");
	await assert.rejects(
		applyAll(liveAPI, explicit, {
			...discovery,
			customPool: [{ ...model, api: "anthropic-messages" }],
		}),
	);
	assert.ok(liveRegistry.has("cx"), "failed refresh must not retire the last successful catalog");
	await applyAll(liveAPI, explicit, discovery);
	assert.equal(
		liveRegistry.has("cx"),
		false,
		"retired namespace must disappear without restarting OMP",
	);
	assert.ok(liveRegistry.has("codex"));
	assert.ok(liveRegistry.has("retained-custom"), "explicit current custom group must remain");
	assert.ok(liveRegistry.has("another-extension"), "another extension's providers must remain");

	process.env.PI_AI_GATEWAY_LATENCY = "1";
	process.env.PI_AI_GATEWAY_LATENCY_FILE = latencyFile;
	const failedSource = createAssistantMessageEventStream();
	const observedFailure = createLatencyDiagnostics()!.observe(failedSource);
	const streamFailure = new Error("fixture producer failure");
	failedSource.fail(streamFailure);
	await assert.rejects(observedFailure.result(), (error) => error === streamFailure);
	for (const api of ["openai-completions", "openai-responses", "anthropic-messages"] as const) {
		const registrations: Array<{ name: string; config: ProviderConfig }> = [];
		await applyAll(
			{
				registerProvider(name: string, config: ProviderConfig) {
					registrations.push({ name, config });
				},
			} as ExtensionAPI,
			cfg,
			{ ...discovery, customPool: [{ ...model, api }] },
		);
		assert.equal(registrations.length, 1);
		assert.equal(registrations[0]!.name, "codex");
		const registered = registrations[0]!.config;
		assert.notEqual(
			registered.apiKey,
			"fixture-key",
			"host-wide registration must never contain the gateway key",
		);
		assert.equal(registered.authHeader, false);
		assert.equal(registered.models![0]!.id, "gpt-6-astra");
		assert.equal(registered.models![0]!.contextWindow, 1_050_000);
		assert.deepEqual(registered.models![0]!.cost, model.cost);
		let requests = 0;
		let fixtureFailure: unknown;
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			try {
				requests++;
				const request = new Request(input, init);
				const payload = (await request.json()) as Record<string, unknown>;
				assert.equal(
					new URL(request.url).pathname,
					api === "openai-completions"
						? "/v1/chat/completions"
						: api === "openai-responses"
							? "/v1/responses"
							: "/v1/messages",
				);
				assert.equal(payload.model, "codex/gpt-6-astra");
				assert.equal(payload.fixture_marker, "preserved");
				assert.equal(request.headers.get("x-session-id"), "session-fixture");
				assert.equal(
					request.headers.get("x-opencode-session"),
					"session-fixture",
					"OpenCode Go routing needs its own conversation header",
				);
				assert.equal(request.headers.get("x-fixture"), "kept");
				assert.equal(request.headers.get("authorization"), "Bearer fixture-key");
				assert.match(
					request.headers.get("x-agp-trace-id") ?? "",
					/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
				);
				assert.equal(request.headers.get("x-api-key"), null);
				assert.equal(init?.redirect, "error");
				return sse(api);
			} catch (error) {
				fixtureFailure = error;
				throw error;
			}
		}) as typeof fetch;
		// Stock OMP's registered agp:* model has no native compatibility record.
		const selected = {
			...registered.models![0]!,
			provider: "codex",
			api: registered.api!,
			baseUrl: registered.baseUrl!,
			compat: undefined,
		};
		const context = {
			messages: [{ role: "user" as const, content: "fixture request", timestamp: 0 }],
		};
		for (const mismatch of [
			{ ...selected, baseUrl: "https://api.deepseek.com/v1" },
			{ ...selected, provider: "deepseek" },
			{ ...selected, api },
		]) {
			assert.throws(
				() => registered.streamSimple!(mismatch, context, { apiKey: "fixture-key" }),
				/transport identity/,
			);
		}
		assert.equal(
			requests,
			0,
			"a stale same-selector object must never dispatch the gateway credential",
		);
		let unsafeFetchCalls = 0;
		const result = await registered.streamSimple!(selected, context, {
			apiKey: "wrong-provider-key",
			sessionId: "session-fixture",
			headers: {
				"x-fixture": "kept",
				Authorization: "Bearer wrong-provider-key",
				"x-api-key": "wrong-provider-key",
			},
			maxTokens: 256,
			...{
				fetch: async () => {
					unsafeFetchCalls++;
					throw new Error("caller fetch must not receive gateway credentials");
				},
			},
			onPayload: async (payload) => ({
				...(payload as object),
				model: "unsafe-bare-model",
				fixture_marker: "preserved",
			}),
		}).result();
		if (fixtureFailure !== undefined) throw fixtureFailure;
		assert.equal(result.stopReason, "stop", result.errorMessage);
		assert.equal(result.model, "gpt-6-astra");
		assert.ok(result.content.some((part) => part.type === "text" && part.text === "ok"));
		assert.equal(requests, 1);
		assert.equal(unsafeFetchCalls, 0);
		const summary = JSON.parse(readFileSync(latencyFile, "utf8").trim().split("\n").at(-1)!);
		assert.equal(summary.outcome, "done");
		assert.equal(summary.client_queue_ms, null);
		assert.equal(summary.output_tokens, 1);
		assert.equal(summary.attempts[0].request_id, "fixture-request-id");
		assert.ok(summary.attempts[0].headers_ms >= summary.attempts[0].dispatch_ms);
		assert.ok(summary.first_sse_ms >= summary.attempts[0].headers_ms);
		assert.ok(summary.first_output_ms >= summary.first_sse_ms);
		assert.ok(
			summary.decode_elapsed_ms < summary.total_ms,
			"waiting/preparation must not be counted as decode time",
		);
		assert.doesNotMatch(
			JSON.stringify(summary),
			/fixture-key|wrong-provider-key|fixture request|session-fixture|Bearer|fixture_marker|\"ok\"/,
		);
		const abort = new AbortController();
		abort.abort();
		const cancelled = await registered.streamSimple!(selected, context, {
			apiKey: "fixture-key",
			signal: abort.signal,
		}).result();
		assert.equal(cancelled.stopReason, "aborted");
		assert.equal(requests, 1, "cancelled requests must not reach HTTP");
		const abortedSummary = JSON.parse(readFileSync(latencyFile, "utf8").trim().split("\n").at(-1)!);
		assert.equal(abortedSummary.outcome, "aborted");
		assert.equal(abortedSummary.first_output_ms, null);
		assert.equal(abortedSummary.decode_elapsed_ms, null);
		assert.deepEqual(abortedSummary.attempts, []);
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					error: {
						message: "private-upstream-error-body fixture-key",
						type: "authentication_error",
					},
				}),
				{
					status: 401,
					headers: { "Content-Type": "application/json", "X-Request-ID": "fixture-error-id" },
				},
			)) as typeof fetch;
		const denied = await registered.streamSimple!(selected, context, {
			apiKey: "wrong-provider-key",
		}).result();
		assert.equal(denied.stopReason, "error");
		const deniedSummary = JSON.parse(readFileSync(latencyFile, "utf8").trim().split("\n").at(-1)!);
		assert.equal(deniedSummary.outcome, "error");
		assert.equal(deniedSummary.attempts[0].status, 401);
		assert.equal(deniedSummary.attempts[0].request_id, "fixture-error-id");
		assert.equal(deniedSummary.output_tokens, null);
		assert.equal(deniedSummary.decode_elapsed_ms, null);
		assert.doesNotMatch(
			JSON.stringify(deniedSummary),
			/private-upstream-error-body|fixture-key|wrong-provider-key/,
		);
	}

	const theme = {
		fg(_color: "success" | "warning" | "error" | "dim", text: string) {
			return text;
		},
	};
	const allowed = account("connector-a", 0.37);
	const unrelated = account("connector-b", 0.99);
	const keyEntitlement = { ...account("connector-a", 1), scope: "key_entitlement" as const };
	const document = { ...usage, accounts: [allowed, unrelated, keyEntitlement] };
	const binding = {
		providerId: "connector-a",
		providerKind: "codex",
		modelIds: [model.id, model.canonicalModel!],
	};
	assert.match(renderQuotaSegment(document, binding, theme, model.selectorId)!, /5h .* 37/);
	assert.equal(
		renderQuotaSegment(document, { providerId: "different", providerKind: "codex" }, theme),
		null,
	);
	assert.equal(
		renderQuotaSegment(document, { providerKind: "codex" }, theme),
		null,
		"a kind fallback cannot absorb UUID accounts",
	);
	allowed.groups!.push(
		{ id: "seven-day", label: "7d", remainingFraction: 0.8, state: "supported" },
		{
			id: "seven-day-other",
			label: "7d Other",
			model: "other/model",
			remainingFraction: 0.01,
			state: "supported",
		},
		{
			id: "seven-day-astra",
			label: "7d Astra",
			model: model.id,
			remainingFraction: 0.5,
			state: "supported",
		},
	);
	const scoped = renderQuotaSegment(document, binding, theme, model.selectorId)!;
	assert.match(scoped, /7d .* 80/);
	assert.match(scoped, /Astra .* 50/);
	assert.doesNotMatch(scoped, /Other/);
	allowed.groups = [{ ...allowed.groups![0]!, state: "stale", remainingFraction: 0.37 }];
	assert.equal(renderQuotaSegment(document, binding, theme), "quota stale");
	allowed.groups = [{ id: "five-hour", label: "5h", state: "unknown", remainingFraction: null }];
	assert.equal(renderQuotaSegment(document, binding, theme), "quota unknown");
	assert.doesNotMatch(renderUsage({ ...usage, accounts: [allowed] }).join("\n"), /NaN|0%/);
	allowed.groups = [
		{
			id: "subscription",
			label: "Subscription",
			state: "supported",
			remainingFraction: 0.46,
			model: model.id,
		},
		{
			id: "subscription",
			label: "Subscription",
			state: "supported",
			remainingFraction: 0.31,
			model: model.canonicalModel,
		},
		{
			id: "subscription",
			label: "Other subscription",
			state: "supported",
			remainingFraction: 0.01,
			model: "other/model",
		},
		{ id: "monthly", label: "Monthly", state: "supported", remainingFraction: 0.72 },
	];
	const genericQuota = renderQuotaSegment(document, binding, theme, model.selectorId)!;
	assert.match(genericQuota, /Subscription .* 31/);
	assert.match(genericQuota, /Monthly .* 72/);
	assert.doesNotMatch(genericQuota, /5h|7d|unknown|Other|99|100/);

	const scope = cacheScope(cfg.proxy.endpoint, "fixture-key", 2);
	writeDiscoveryCache(discovery, scope);
	assert.equal(readDiscoveryCache(scope)?.discovery.customPool[0]?.id, model.id);
	assert.equal(readDiscoveryCache(cacheScope("https://other.test/v1", "fixture-key", 2)), null);
	assert.equal(readDiscoveryCache(cacheScope(cfg.proxy.endpoint, "different-key", 2)), null);
	assert.equal(readDiscoveryCache(cacheScope(cfg.proxy.endpoint, "fixture-key", 3)), null);
	assert.doesNotMatch(readFileSync(DISCOVERY_CACHE_PATH, "utf8"), /fixture-key/);
	writeFileSync(DISCOVERY_CACHE_PATH, JSON.stringify({ savedAt: Date.now(), discovery }));
	assert.equal(readDiscoveryCache(scope), null, "pre-scope caches must be invalidated");
	writeUsageCache(usage, scope);
	assert.deepEqual(readUsageCache(scope)?.doc, usage);
	assert.equal(readUsageCache(cacheScope(cfg.proxy.endpoint, "different-key", 2)), null);
	assert.doesNotMatch(readFileSync(USAGE_CACHE_PATH, "utf8"), /fixture-key/);

	clearUsageCache();
	const authorized: string[] = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const request = input instanceof Request ? input : new Request(input, init);
		if (new URL(request.url).pathname.endsWith("capabilities")) return json({}, 404);
		authorized.push(request.headers.get("authorization")!);
		return json(usage);
	}) as typeof fetch;
	await fetchUsage(cfg, "");
	await fetchUsage(cfg, "");
	await fetchUsage({ ...cfg, proxy: { ...cfg.proxy, apiKey: "rotated-key" } }, "");
	await fetchUsage({ ...cfg, proxy: { ...cfg.proxy, endpoint: "https://other.test/v1" } }, "");
	assert.deepEqual(authorized, ["Bearer fixture-key", "Bearer rotated-key", "Bearer fixture-key"]);
	console.log("model contract check: ok");
} finally {
	globalThis.fetch = originalFetch;
	if (originalLatency === undefined) delete process.env.PI_AI_GATEWAY_LATENCY;
	else process.env.PI_AI_GATEWAY_LATENCY = originalLatency;
	if (originalLatencyFile === undefined) delete process.env.PI_AI_GATEWAY_LATENCY_FILE;
	else process.env.PI_AI_GATEWAY_LATENCY_FILE = originalLatencyFile;
	process.env.HOME = originalHome;
	rmSync(home, { recursive: true, force: true });
}
