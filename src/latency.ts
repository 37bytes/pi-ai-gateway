import { randomUUID } from "node:crypto";
import { createAssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import type { AssistantMessage, AssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import { log } from "./log.ts";

interface Attempt {
	dispatch_ms: number;
	headers_ms: number | null;
	ttfb_ms: number | null;
	status: number | null;
	request_id: string | null;
}

/** No request bodies, response bodies, model/session identifiers, or error strings. */
export function createLatencyDiagnostics() {
	if (process.env.PI_AI_GATEWAY_LATENCY !== "1") return undefined;
	const start = performance.now();
	const startedAt = new Date().toISOString();
	const traceId = randomUUID();
	const elapsed = () => Math.round((performance.now() - start) * 1000) / 1000;
	let prepare: number | null = null;
	let firstSse: number | null = null;
	let firstOutput: number | null = null;
	let finished = false;
	let attemptCount = 0;
	const attempts: Attempt[] = [];
	const finish = (outcome: "done" | "aborted" | "error", message?: AssistantMessage) => {
		if (finished) return;
		finished = true;
		const done = elapsed();
		const output = message?.usage?.output;
		log.latency({
			schema_version: 1,
			trace_id: traceId,
			started_at: startedAt,
			outcome,
			client_queue_ms: null,
			plugin_prepare_ms: prepare,
			native_pre_dispatch_ms:
				prepare !== null && attempts[0] ? Math.max(0, attempts[0].dispatch_ms - prepare) : null,
			attempt_count: attemptCount,
			attempts,
			first_sse_ms: firstSse,
			first_output_ms: firstOutput,
			done_ms: done,
			total_ms: done,
			decode_elapsed_ms: firstOutput === null ? null : Math.max(0, done - firstOutput),
			output_tokens:
				typeof output === "number" &&
				Number.isFinite(output) &&
				output >= 0 &&
				(outcome === "done" || output > 0)
					? output
					: null,
		});
	};
	return {
		traceId,
		prepared() {
			prepare = elapsed();
		},
		dispatch(): Attempt {
			attemptCount++;
			const attempt: Attempt = {
				dispatch_ms: elapsed(),
				headers_ms: null,
				ttfb_ms: null,
				status: null,
				request_id: null,
			};
			// Bound storage even if a host retry policy is unexpectedly large.
			if (attempts.length < 16) attempts.push(attempt);
			return attempt;
		},
		headers(response: Response, attempt: Attempt) {
			attempt.headers_ms = elapsed();
			attempt.ttfb_ms = Math.max(0, attempt.headers_ms - attempt.dispatch_ms);
			attempt.status = response.status;
			const requestId = response.headers.get("x-request-id");
			attempt.request_id =
				requestId && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(requestId) ? requestId : null;
		},
		firstSse() {
			firstSse ??= elapsed();
		},
		failed() {
			finish("error");
		},
		observe(source: AssistantMessageEventStream): AssistantMessageEventStream {
			const observed = createAssistantMessageEventStream();
			observed.forwardLocalWorkFrom(source);
			void (async () => {
				try {
					for await (const event of source) {
						if (
							(event.type === "text_delta" ||
								event.type === "thinking_delta" ||
								event.type === "toolcall_delta") &&
							event.delta.length
						) {
							firstOutput ??= elapsed();
						}
						if (event.type === "done") finish("done", event.message);
						else if (event.type === "error")
							finish(event.reason === "aborted" ? "aborted" : "error", event.error);
						observed.push(event);
					}
					// A malformed stream ending without a terminal value must retain
					// the native rejected result, not turn into a successful response.
					const result = await source.result();
					finish(
						result.stopReason === "aborted"
							? "aborted"
							: result.stopReason === "error"
								? "error"
								: "done",
						result,
					);
					observed.end(result);
				} catch (error) {
					finish("error");
					observed.fail(error);
				} finally {
					observed.forwardLocalWorkFrom(undefined);
				}
			})();
			return observed;
		},
	};
}
