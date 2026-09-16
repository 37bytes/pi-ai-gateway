// Extension logging.
//
// pi has no log sink for extensions: console.* writes straight to the terminal,
// so anything printed during a session lands on top of the live TUI and
// corrupts it. Messages the user needs to see go through ctx.ui.notify, which
// pi renders as a proper [Warning]/[Error] line; the rest are dropped unless
// debugging is explicitly enabled.

import { appendFileSync } from "node:fs";

const TAG = "[ai-gateway]";

type Level = "info" | "warning" | "error";

interface NotifySink {
	notify(message: string, type?: Level): void;
}

let quiet = false;
let sink: NotifySink | null = null;

/** Mute/unmute output (used around interactive overlays). */
export function setLogQuiet(v: boolean): void {
	quiet = v;
}

/**
 * Route user-facing messages through pi's notification channel.
 *
 * Called once a UI context exists. Without a sink — print mode, JSON mode, or
 * before the first event — printing is safe because there is no TUI to damage.
 */
export function setLogSink(next: NotifySink | null): void {
	sink = next;
}

/** Explicit opt-in for verbose terminal output when diagnosing a live session. */
function verbose(): boolean {
	return !!process.env.PI_AI_GATEWAY_DEBUG;
}

function format(args: unknown[]): string {
	return args
		.map((a) => {
			if (typeof a === "string") return a;
			if (a instanceof Error) return a.message;
			try {
				return JSON.stringify(a);
			} catch {
				return String(a);
			}
		})
		.join(" ");
}

function emit(level: Level, args: unknown[]): void {
	if (quiet) return;
	const message = format(args);

	if (sink) {
		sink.notify(`${TAG} ${message}`, level);
		return;
	}
	// No UI attached: safe to write to the terminal.
	(level === "info" ? console.log : console.error)(TAG, message);
}

export const log = {
	/** Independent opt-in; never enables payload/debug logging. */
	latency(summary: Record<string, unknown>): void {
		if (process.env.PI_AI_GATEWAY_LATENCY !== "1") return;
		try {
			const file = process.env.PI_AI_GATEWAY_LATENCY_FILE;
			if (file) appendFileSync(file, `${JSON.stringify(summary)}\n`, { mode: 0o600 });
			else if (sink) sink.notify(`${TAG} latency ${JSON.stringify(summary)}`, "info");
			else console.error(TAG, "latency", JSON.stringify(summary));
		} catch {
			// Diagnostics must never alter or fail an inference stream. Do not
			// include filesystem errors: they can expose paths or environment data.
		}
	},
	/**
	 * Routine progress. These are the lines that used to litter the TUI, so
	 * they are only shown when explicitly debugging.
	 */
	info(...args: unknown[]): void {
		if (!verbose()) return;
		emit("info", args);
	},
	warn(...args: unknown[]): void {
		emit("warning", args);
	},
	error(...args: unknown[]): void {
		emit("error", args);
	},
	debug(...args: unknown[]): void {
		if (!verbose()) return;
		emit("info", args);
	},
};
