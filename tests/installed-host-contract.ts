import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The installed binary is never modified. Both launches use an isolated HOME,
// real host selection/streaming, a shared warm cache, and only a local endpoint.
const binary = process.env.OMP_FIXTURE_BINARY ?? join(homedir(), ".local/bin/omp");
const root = resolve(
	process.env.OMP_FIXTURE_PLUGIN_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), ".."),
);
const home = mkdtempSync(join(tmpdir(), "agp-installed-host-"));
const receipt = join(home, "receipt.json");
const latencyFile = join(home, "latency.jsonl");
// Relative imports are required for the host's extension-graph SDK rewriting.
const extension = join(mkdtempSync(join(root, ".installed-host-")), "fixture.ts");
const key = "local-fixture-not-a-real-credential";
const requests: Array<{
	path: string;
	model: string;
	authorization: string | null;
	apiKey: string | null;
	session: string | null;
	opencodeSession: string | null;
	trace: string | null;
}> = [];
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const payload = (await request.json()) as { model: string };
		requests.push({
			path: new URL(request.url).pathname,
			model: payload.model,
			authorization: request.headers.get("authorization"),
			apiKey: request.headers.get("x-api-key"),
			session: request.headers.get("x-session-id"),
			opencodeSession: request.headers.get("x-opencode-session"),
			trace: request.headers.get("x-agp-trace-id"),
		});
		if (payload.model.startsWith("opencode/") && !request.headers.get("x-opencode-session")) {
			return Response.json(
				{ error: { type: "MissingSessionID", message: "Missing conversation header" } },
				{ status: 400 },
			);
		}
		const encoder = new TextEncoder();
		const isResponses = payload.model.startsWith("codex/");
		const item = {
			id: "msg-fixture",
			type: "message",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: "ok", annotations: [] }],
		};
		const frames = isResponses
			? [
					{
						type: "response.created",
						response: {
							id: "resp-fixture",
							model: payload.model,
							status: "in_progress",
							output: [],
						},
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
							model: payload.model,
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
				]
			: [
					{
						id: "fixture",
						object: "chat.completion.chunk",
						choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }],
					},
					{
						id: "fixture",
						object: "chat.completion.chunk",
						choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
						usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
					},
				];
		let cancelled = false;
		return new Response(
			new ReadableStream({
				async start(controller) {
					for (const frame of frames) {
						await Bun.sleep(15);
						if (cancelled) return;
						controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
					}
					if (!cancelled) {
						if (!isResponses) controller.enqueue(encoder.encode("data: [DONE]\n\n"));
						controller.close();
					}
				},
				cancel() {
					cancelled = true;
				},
			}),
			{
				headers: {
					"Content-Type": "text/event-stream",
					"X-Request-ID": "installed-fixture-request",
				},
			},
		);
	},
});

try {
	mkdirSync(join(home, ".omp", "agent"), { recursive: true });
	writeFileSync(
		extension,
		`
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { streamSimple } from "@oh-my-pi/pi-ai";
import { applyAll } from ${JSON.stringify(relative(dirname(extension), join(root, "src/apply.ts")))};
export default async function(pi) {
  const cfg = { proxy: { endpoint: ${JSON.stringify(`http://127.0.0.1:${server.port}/v1`)}, apiKey: ${JSON.stringify(key)} }, builtinProviders: {}, customProviders: {}, registerAll: true, discoveryExcludes: [], overrides: {}, refreshIntervalMinutes: 0, usageCacheTtlMs: 15000 };
  const entries = [["deepseek", "deepseek-chat"], ["opencode", "deepseek-v4.1-flash"], ["codex", "gpt-6-astra"]].map(([provider, id]) => ({ id: provider + "/" + id, wireId: provider + "/" + id, selectorId: id, providerId: "fixture-" + provider, providerKind: provider, canonicalModel: id, name: "Fixture " + provider, api: provider === "codex" ? "openai-responses" : "openai-completions", suggestedProvider: provider, ownedBy: provider, metadataState: "catalog", priceState: "known", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 8192, cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 } }));
  const discovery = { source: "well-known", upstreamVersion: "fixture", builtinProviders: [], customPool: entries, serverDiscoveryExcludes: [], upstreamTotal: entries.length };
  await applyAll(pi, cfg, discovery);
  pi.on("session_start", async (_event, ctx) => {
    try {
      const sessionId = ctx.sessionManager.getSessionId();
      assert.ok(sessionId);
      await ctx.modelRegistry.refreshRuntimeProviders("online");
      for (const strategy of ["offline", "online"]) {
        await ctx.modelRegistry.refreshRuntimeProviders(strategy);
        for (const entry of entries) {
          const models = ctx.modelRegistry.getAll().filter(model => model.provider === entry.suggestedProvider);
          assert.deepEqual(models.map(model => model.id), [entry.selectorId], "built-in discovery must not reintroduce foreign routes");
          assert.ok(models.every(model => model.api === "agp:" + entry.suggestedProvider + ":" + entry.api));
        }
      }
      assert.equal(ctx.models.resolve("deepseek/opencode/deepseek-v4.1-flash"), undefined);
      const context = { messages: [{ role: "user", content: "local fixture", timestamp: 0 }] };
      const cases = [
        { selector: "deepseek/deepseek-chat" },
        { selector: "opencode/deepseek-v4.1-flash" },
        { selector: "opencode/deepseek-v4.1-flash" },
        { selector: "codex/gpt-6-astra" },
        { selector: "opencode/deepseek-v4.1-flash", modelHeaders: { "x-session-id": "model-session", "x-opencode-session": "model-conversation" } },
        { selector: "opencode/deepseek-v4.1-flash", modelHeaders: { "x-session-id": "model-session", "x-opencode-session": "model-conversation" }, headers: { "x-session-id": "caller-session", "x-opencode-session": "caller-conversation" } },
      ];
      for (const item of cases) {
        const selected = ctx.models.resolve(item.selector);
        assert.ok(selected);
        assert.equal(selected.api, "agp:" + selected.provider + ":" + (selected.provider === "codex" ? "openai-responses" : "openai-completions"));
        assert.equal(selected.baseUrl, cfg.proxy.endpoint);
        assert.equal(await pi.setModel(selected), true);
        const hostKey = await ctx.modelRegistry.getApiKey(selected);
        assert.notEqual(hostKey, cfg.proxy.apiKey, "provider-wide credentials must not contain the gateway key");
        const model = item.modelHeaders ? { ...selected, headers: item.modelHeaders } : selected;
        const result = await streamSimple(model, context, { apiKey: hostKey, sessionId, headers: item.headers, maxTokens: 16, maxInFlightRequests: { [selected.provider]: 1 }, signal: AbortSignal.timeout(10000) }).result();
        assert.equal(result.stopReason, "stop");
        assert.ok(result.content.some(part => part.type === "text" && part.text === "ok"));
      }
      writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ outcome: "stop", sessionId, selected: ctx.model.provider + "/" + ctx.model.id }));
      process.exit(0);
    } catch (error) {
      writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ failure: error instanceof Error ? error.name : "fixture failure", message: error instanceof Error ? error.message : "unknown" }));
      process.exit(1);
    }
  });
}
`,
	);
	const sessions: string[] = [];
	for (let run = 0; run < 2; run++) {
		rmSync(receipt, { force: true });
		const child = Bun.spawn(
			[
				binary,
				"--no-session",
				"--no-tools",
				"--no-skills",
				"--no-rules",
				"--extension",
				extension,
				"--model",
				"opencode/deepseek-v4.1-flash",
				"--print",
				"local fixture",
			],
			{
				cwd: home,
				env: {
					PATH: process.env.PATH ?? "/usr/bin:/bin",
					HOME: home,
					TMPDIR: tmpdir(),
					TERM: "dumb",
					PI_CODING_AGENT_DIR: join(home, ".omp", "agent"),
					PI_AI_GATEWAY_LATENCY: run === 0 ? "1" : "0",
					PI_AI_GATEWAY_LATENCY_FILE: latencyFile,
				},
				stdout: "ignore",
				stderr: "pipe",
			},
		);
		const stderr = new Response(child.stderr).arrayBuffer();
		const timer = setTimeout(() => child.kill(), 30_000);
		const status = await child.exited;
		clearTimeout(timer);
		await stderr;
		if (status !== 0 && existsSync(receipt)) console.error(readFileSync(receipt, "utf8"));
		assert.equal(status, 0, "installed OMP selection/transport fixture failed");
		const result = JSON.parse(readFileSync(receipt, "utf8"));
		assert.equal(result.outcome, "stop");
		assert.equal(result.selected, "opencode/deepseek-v4.1-flash");
		sessions.push(result.sessionId);
		const calls = requests.slice(run * 6);
		assert.equal(
			calls.length,
			6,
			"each guarded stream must dispatch exactly once at provider cap=1",
		);
		assert.deepEqual(
			calls.map((call) => call.model),
			[
				"deepseek/deepseek-chat",
				"opencode/deepseek-v4.1-flash",
				"opencode/deepseek-v4.1-flash",
				"codex/gpt-6-astra",
				"opencode/deepseek-v4.1-flash",
				"opencode/deepseek-v4.1-flash",
			],
		);
		for (const call of calls) {
			assert.equal(
				call.path,
				call.model.startsWith("codex/") ? "/v1/responses" : "/v1/chat/completions",
			);
			assert.equal(call.authorization, `Bearer ${key}`);
			assert.equal(call.apiKey, null);
			if (run === 0) assert.match(call.trace ?? "", /^[0-9a-f-]{36}$/);
			else assert.equal(call.trace, null);
		}
		for (const call of calls.slice(0, 4)) {
			assert.equal(call.session, result.sessionId);
			assert.equal(call.opencodeSession, result.sessionId);
		}
		assert.equal(calls[4]!.session, "model-session");
		assert.equal(calls[4]!.opencodeSession, "model-conversation");
		assert.equal(calls[5]!.session, "caller-session");
		assert.equal(calls[5]!.opencodeSession, "caller-conversation");
	}
	assert.notEqual(
		sessions[0],
		sessions[1],
		"different actual host conversations must not share routing identity",
	);
	const summaries = readFileSync(latencyFile, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.equal(summaries.length, 6);
	for (const summary of summaries) {
		assert.equal(summary.outcome, "done");
		assert.equal(summary.attempts[0].request_id, "installed-fixture-request");
		assert.equal(summary.output_tokens, 1);
		assert.ok(summary.decode_elapsed_ms < summary.total_ms);
		assert.doesNotMatch(
			JSON.stringify(summary),
			/local-fixture-not-a-real-credential|local fixture|Bearer|model-conversation|caller-conversation/,
		);
	}
	console.log(
		"installed host: canonical discovery after warm refresh; 12 guarded streams; real conversation identity and explicit-header precedence: ok",
	);
} finally {
	server.stop(true);
	rmSync(dirname(extension), { recursive: true, force: true });
	rmSync(home, { recursive: true, force: true });
}
