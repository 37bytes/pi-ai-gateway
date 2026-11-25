import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
	PREFERRED_CONTRACT,
	type UsageAccount,
	type UsageDocument,
	type UsageGroup,
} from "../src/fetch-usage.ts";
import { cacheScope } from "../src/cache-scope.ts";
import { profilePaths } from "../src/profiles.ts";
import { PROFILE_STATUS_KEY } from "../src/session-runtime.ts";
import { FOOTER_STATUS_KEY, clearFooter, reportFooter } from "../src/status-footer.ts";
import { renderQuotaSegment } from "../src/status-quota.ts";
import { renderUsage } from "../src/ui-usage.ts";

const home = process.env.PI_GATEWAY_TEST_HOME!;
assert.ok(home && process.env.HOME === home, "Run through scripts/run-isolated.ts");
const originalHome = process.env.HOME;
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
const originalArgv = [...process.argv];
const initialTime = Date.UTC(2026, 8, 15, 12);
let now = initialTime;
process.env.HOME = home;
Date.now = () => now;
process.argv.splice(2);
const providerId = "11111111-1111-4111-8111-111111111111";
const otherProviderId = "22222222-2222-4222-8222-222222222222";
const modelId = "gpt-6-astra";
const wireId = `codex/${modelId}`;
const theme = {
	fg(_color: "success" | "warning" | "error" | "dim", text: string) {
		return text;
	},
};
const binding = { providerId, providerKind: "codex", modelIds: [wireId, modelId] };
const freshWindow: UsageGroup = {
	id: "seven-day",
	label: "7d",
	scope: "provider_subscription",
	state: "supported",
	remainingFraction: 0.37,
	resetTime: new Date(initialTime + 3_600_000).toISOString(),
	capturedAt: new Date(initialTime).toISOString(),
};
const freshAccount: UsageAccount = {
	provider: "codex",
	providerId,
	scope: "provider_subscription",
	account: "opaque-a",
	authIndex: "opaque-a",
	label: "Subscription",
	status: "active",
	disabled: false,
	unavailable: false,
	success: 0,
	failed: 0,
	lastRequestAt: null,
	supported: true,
	groups: [freshWindow],
};
const staleOtherProvider: UsageAccount = {
	...freshAccount,
	providerId: otherProviderId,
	account: "opaque-b",
	status: "stale",
	unavailable: true,
	groups: [{ ...freshWindow, state: "stale", remainingFraction: null }],
};
/** Second connector used to observe a real model switch. */
const switchProviderId = "33333333-3333-4333-8333-333333333333";
const switchModelId = "deepseek-chat";
const switchAccount: UsageAccount = {
	...freshAccount,
	provider: "deepseek",
	providerId: switchProviderId,
	account: "opaque-c",
	authIndex: "opaque-c",
	groups: [{ ...freshWindow, remainingFraction: 0.61 }],
};
function delay(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}
const usage: UsageDocument = {
	schemaVersion: 1,
	generatedAt: new Date(initialTime).toISOString(),
	unsupportedProviders: [],
	cache: { updatedAt: new Date(initialTime).toISOString(), stale: true, ttlMs: 120_000 },
	accounts: [freshAccount, staleOtherProvider, switchAccount],
};
const cfg = {
	proxy: { endpoint: "https://freshness.test/v1", apiKey: "fixture-key-a", providerPrefix: "" },
	registerAll: true,
	builtinProviders: {},
	customProviders: {},
	overrides: {},
	discoveryExcludes: [],
	refreshIntervalMinutes: 0,
	usageCacheTtlMs: 15_000,
};
const discovery = {
	schemaVersion: 1,
	builtinProviders: {},
	customModelPool: [
		{
			id: wireId,
			wireId,
			selectorId: modelId,
			canonicalModel: modelId,
			providerId,
			providerKind: "codex",
			suggestedProviderName: "codex",
			api: "openai-responses",
			name: "GPT-6 Astra",
			metadataState: "catalog",
			priceState: "known",
			reasoning: true,
			input: ["text"],
			contextWindow: 1_050_000,
			maxTokens: 128_000,
			cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
		},
		{
			id: `deepseek/${switchModelId}`,
			wireId: `deepseek/${switchModelId}`,
			selectorId: switchModelId,
			canonicalModel: switchModelId,
			providerId: switchProviderId,
			providerKind: "deepseek",
			suggestedProviderName: "deepseek",
			api: "openai-completions",
			name: "DeepSeek Chat",
			metadataState: "catalog",
			priceState: "known",
			reasoning: false,
			input: ["text"],
			contextWindow: 128_000,
			maxTokens: 8_192,
			cost: { input: 1, output: 2 },
		},
	],
};

try {
	assert.match(
		renderQuotaSegment(usage, binding, theme, modelId)!,
		/\ud83d\uddd3 .* 37/,
		"other connector staleness is not selected transport staleness",
	);
	const orderedGroups: UsageGroup[] = [
		{ ...freshWindow, id: "opencode.monthly", label: "monthly", remainingFraction: 0.5 },
		{ ...freshWindow, id: "opencode.weekly", label: "weekly", remainingFraction: 0.6 },
		{ ...freshWindow, id: "opencode.rolling", label: "rolling", remainingFraction: 0.7 },
	];
	const ordered = renderQuotaSegment(
		{ ...usage, accounts: [{ ...freshAccount, groups: orderedGroups }] },
		binding,
		theme,
		modelId,
	)!;
	assert.ok(
		ordered.indexOf("\ud83d\uddd3") < ordered.indexOf("\ud83d\udcc5") &&
			ordered.indexOf("\ud83d\udcc5") < ordered.indexOf("\u2022"),
		`quota windows must render weekly, monthly, then unknown periods regardless of server order: ${ordered}`,
	);
	assert.match(ordered, /\ud83d\uddd3.*60.*\ud83d\udcc5.*50.*\u2022.*70/);
	assert.doesNotMatch(
		ordered,
		/\u23f1/,
		"rolling describes reset behavior, not an hourly duration",
	);

	// Actual durations decide the period, even when they oppose the historical
	// primary/secondary order or contradict the server's name.
	const durationGroups: UsageGroup[] = [
		{ ...freshWindow, id: "primary", label: "primary", durationSeconds: 604_800, remainingFraction: 0.42 },
		{ ...freshWindow, id: "secondary", label: "secondary", durationSeconds: 18_000, remainingFraction: 0.83 },
	];
	const durationOrdered = renderQuotaSegment(
		{ ...usage, accounts: [{ ...freshAccount, groups: durationGroups }] },
		binding,
		theme,
		modelId,
	)!;
	assert.ok(
		durationOrdered.indexOf("\u23f1") < durationOrdered.indexOf("\ud83d\uddd3"),
		`a 18000s secondary window sorts before a 604800s primary window: ${durationOrdered}`,
	);
	assert.match(durationOrdered, /\u23f1.*83.*\ud83d\uddd3.*42/);
	assert.doesNotMatch(durationOrdered, /\u2022/, "known durations must not fall back to unknown");

	// A name that says 5h cannot override a reported 7-day duration.
	assert.match(
		renderQuotaSegment(
			{
				...usage,
				accounts: [
					{
						...freshAccount,
						groups: [{ ...freshWindow, id: "5h", label: "5h", durationSeconds: 604_800, remainingFraction: 0.42 }],
					},
				],
			},
			binding,
			theme,
			modelId,
		)!,
		/\ud83d\uddd3.*42/,
		"numeric duration wins over a conflicting legacy name",
	);

	// The same id at two real durations is two windows, not one merged period.
	const sameIdDifferentDurations = renderQuotaSegment(
		{
			...usage,
			accounts: [
				{
					...freshAccount,
					groups: [{ ...freshWindow, id: "primary", label: "primary", durationSeconds: 604_800, remainingFraction: 0.4 }],
				},
				{
					...freshAccount,
					account: "opaque-d",
					authIndex: "opaque-d",
					groups: [{ ...freshWindow, id: "primary", label: "primary", durationSeconds: 18_000, remainingFraction: 0.9 }],
				},
			],
		},
		binding,
		theme,
		modelId,
	)!;
	assert.match(sameIdDifferentDurations, /\u23f1.*90.*\ud83d\uddd3.*40/);

	// Without a duration, primary/secondary/rolling carry no period evidence and
	// use the neutral symbol instead of being guessed as hourly.
	const neutral = renderQuotaSegment(
		{
			...usage,
			accounts: [
				{
					...freshAccount,
					groups: [
						{ ...freshWindow, id: "primary", label: "primary", remainingFraction: 0.4 },
						{ ...freshWindow, id: "secondary", label: "secondary", remainingFraction: 0.6 },
						{ ...freshWindow, id: "rolling", label: "rolling", remainingFraction: 0.8 },
					],
				},
			],
		},
		binding,
		theme,
		modelId,
	)!;
	assert.doesNotMatch(neutral, /\u23f1/, "position/reset names are never inferred as hourly");
	assert.match(neutral, /\u2022.*40/);
	assert.match(neutral, /\u2022.*60/);
	assert.match(neutral, /\u2022.*80/);
	const invalidDuration = renderQuotaSegment(
		{
			...usage,
			accounts: [
				{
					...freshAccount,
					groups: [{ ...freshWindow, id: "7d", label: "7d", durationSeconds: 0, remainingFraction: 0.4 }],
				},
			],
		},
		binding,
		theme,
		modelId,
	)!;
	assert.match(
		invalidDuration,
		/\u2022.*40/,
		"a supplied invalid duration stays neutral even beside a weekly label",
	);
	assert.doesNotMatch(invalidDuration, /\ud83d\uddd3/, "an invalid duration cannot fall back to a legacy name");

	// Numeric durations sort globally ascending; explicit legacy names use
	// their equivalent duration, and windows with no evidence stay last.
	const ascendingDurations = renderQuotaSegment(
		{
			...usage,
			accounts: [
				{
					...freshAccount,
					groups: [
						{ ...freshWindow, id: "month", label: "month", durationSeconds: 2_592_000, remainingFraction: 0.3 },
						{ ...freshWindow, id: "day", label: "day", durationSeconds: 86_400, remainingFraction: 0.4 },
						{ ...freshWindow, id: "hour", label: "hour", durationSeconds: 18_000, remainingFraction: 0.5 },
						{ ...freshWindow, id: "legacy-week", label: "weekly", remainingFraction: 0.6 },
						{ ...freshWindow, id: "rolling", label: "rolling", remainingFraction: 0.7 },
					],
				},
			],
		},
		binding,
		theme,
		modelId,
	)!;
	assert.match(
		ascendingDurations,
		/\u23f1.*50.*\u2022.*40.*\ud83d\uddd3.*60.*\ud83d\udcc5.*30.*\u2022.*70/,
		"hour 18000s, day 86400s, legacy weekly, month 2592000s, then unknown",
	);

	// Icons are exact: only 604800s is weekly; calendar months are 28–31 days.
	// Near-week and 27/32-day windows stay neutral and still sort by duration.
	const durationPrecision = renderQuotaSegment(
		{
			...usage,
			accounts: [
				{
					...freshAccount,
					groups: [
						{ ...freshWindow, id: "d32", label: "32d", durationSeconds: 32 * 86_400, remainingFraction: 0.9 },
						{ ...freshWindow, id: "d31", label: "31d", durationSeconds: 31 * 86_400, remainingFraction: 0.8 },
						{ ...freshWindow, id: "d30", label: "30d", durationSeconds: 30 * 86_400, remainingFraction: 0.7 },
						{ ...freshWindow, id: "d29", label: "29d", durationSeconds: 29 * 86_400, remainingFraction: 0.6 },
						{ ...freshWindow, id: "d28", label: "28d", durationSeconds: 28 * 86_400, remainingFraction: 0.5 },
						{ ...freshWindow, id: "d27", label: "27d", durationSeconds: 27 * 86_400, remainingFraction: 0.4 },
						{ ...freshWindow, id: "d8", label: "8d", durationSeconds: 8 * 86_400, remainingFraction: 0.3 },
						{ ...freshWindow, id: "d7", label: "7d", durationSeconds: 7 * 86_400, remainingFraction: 0.2 },
						{ ...freshWindow, id: "d6", label: "6d", durationSeconds: 6 * 86_400, remainingFraction: 0.1 },
					],
				},
			],
		},
		binding,
		theme,
		modelId,
	)!;
	assert.match(
		durationPrecision,
		/\u2022.*10.*\ud83d\uddd3.*20.*\u2022.*30.*\u2022.*40.*\ud83d\udcc5.*50.*\ud83d\udcc5.*60.*\ud83d\udcc5.*70.*\ud83d\udcc5.*80.*\u2022.*90/,
		"6d neutral, exact 7d weekly, 8d/27d neutral, 28–31d monthly, 32d neutral",
	);

	// The stopwatch stays for short/subday windows only.
	assert.match(
		renderQuotaSegment(
			{
				...usage,
				accounts: [
					{
						...freshAccount,
						groups: [
							{ ...freshWindow, id: "h6", label: "6h", durationSeconds: 6 * 3_600, remainingFraction: 0.6 },
							{ ...freshWindow, id: "h7", label: "7h", durationSeconds: 7 * 3_600, remainingFraction: 0.7 },
						],
					},
				],
			},
			binding,
			theme,
			modelId,
		)!,
		/\u23f1.*60.*\u2022.*70/,
		"6h is short; 7h is neutral",
	);

	// A model-scoped cap stays its own window and follows the account-wide one
	// when both describe the same real duration.
	const scopedSameDuration = renderQuotaSegment(
		{
			...usage,
			accounts: [
				{
					...freshAccount,
					groups: [
						{ ...freshWindow, id: "primary", label: "primary", durationSeconds: 18_000, remainingFraction: 0.5 },
						{
							...freshWindow,
							id: "five-hour-astra",
							label: "5h Astra",
							model: modelId,
							durationSeconds: 18_000,
							remainingFraction: 0.2,
						},
					],
				},
			],
		},
		binding,
		theme,
		modelId,
	)!;
	assert.match(scopedSameDuration, /\u23f1.*50.*\u23f1.*20/, "model-scoped windows remain separate");
	// One writer owns the row: binding again on the same profile keeps a valid
	// quota, while a switch starts without the old profile's numbers.
	const footerWrites: Array<[string, string | undefined]> = [];
	const footerColors: string[] = [];
	const footerTheme = {
		fg(color: "success" | "warning" | "error" | "dim", text: string) {
			footerColors.push(color);
			return text;
		},
	};
	const footerCtx = {
		hasUI: true,
		ui: {
			theme: footerTheme,
			setStatus(key: string, value: string | undefined) {
				footerWrites.push([key, value]);
			},
		},
	};
	reportFooter(footerCtx, { id: "test", sessionKey: "footer-session" }, "\u23f1 x 50");
	reportFooter(footerCtx, { id: "test", sessionKey: "footer-session" });
	assert.deepEqual(footerColors, ["success", "success"], "test keeps its green contour dot");
	assert.equal(
		footerWrites.at(-1)?.[1],
		"\u25cf \u23f1 x 50",
		"re-binding the same profile must not erase its quota",
	);
	reportFooter(footerCtx, { id: "prod", sessionKey: "footer-session" });
	assert.equal(footerColors.at(-2), "error", "prod keeps its red contour dot");
	assert.equal(
		footerWrites.at(-1)?.[1],
		"\u25cf quota unknown",
		"a profile switch may not retain the previous profile's quota",
	);
	assert.doesNotMatch(footerWrites.at(-1)?.[1]!, /prod|test|https?:/i);
	assert.ok(footerWrites.every(([key]) => key === FOOTER_STATUS_KEY));
	clearFooter("footer-session");

	const staleOtherModel: UsageGroup = {
		...freshWindow,
		id: "seven-day-other",
		label: "7d Other",
		model: "other-model",
		state: "stale",
		remainingFraction: null,
	};
	const mixed = {
		...usage,
		accounts: [{ ...freshAccount, status: "partial", groups: [freshWindow, staleOtherModel] }],
	};
	assert.match(renderQuotaSegment(mixed, binding, theme, modelId)!, /\ud83d\uddd3 .* 37/);
	assert.doesNotMatch(renderQuotaSegment(mixed, binding, theme, modelId)!, /Other|stale/);
	assert.equal(
		renderQuotaSegment(
			{ ...usage, accounts: [{ ...freshAccount, status: "stale", groups: [staleOtherModel] }] },
			binding,
			theme,
			modelId,
		),
		"quota unknown",
		"an unrelated model's stale window is not a selected stale window",
	);
	assert.equal(
		renderQuotaSegment(usage, binding, theme, modelId, { localStale: true }),
		"quota stale",
	);

	const legacy: UsageAccount = {
		...freshAccount,
		providerId: undefined,
		groups: [{ ...freshWindow, state: undefined }],
	};
	assert.equal(
		renderQuotaSegment({ ...usage, accounts: [legacy] }, { providerKind: "codex" }, theme, modelId),
		"quota stale",
	);
	assert.equal(
		renderQuotaSegment(
			{ ...usage, accounts: [{ ...freshAccount, groups: [{ ...freshWindow, state: undefined }] }] },
			binding,
			theme,
			modelId,
		),
		"quota stale",
		"native unclassified windows must retain the global conservative hint",
	);
	const currentDocument = { ...usage, cache: { ...usage.cache!, stale: false } };
	assert.equal(
		renderQuotaSegment(
			{
				...currentDocument,
				accounts: [
					{ ...freshAccount, groups: [{ ...freshWindow, resetTime: new Date(now).toISOString() }] },
				],
			},
			binding,
			theme,
			modelId,
		),
		"quota stale",
		"reset expiry is inclusive",
	);
	assert.match(
		renderQuotaSegment(
			{
				...currentDocument,
				accounts: [{ ...freshAccount, groups: [{ ...freshWindow, resetTime: "not-a-timestamp" }] }],
			},
			binding,
			theme,
			modelId,
		)!,
		/\ud83d\uddd3 .* 37/,
		"invalid reset timestamps are not invented expiry dates",
	);
	const expiredDetail = renderUsage({
		...currentDocument,
		accounts: [
			{ ...freshAccount, groups: [{ ...freshWindow, resetTime: new Date(now).toISOString() }] },
		],
	}).join("\n");
	assert.match(expiredDetail, /stale/);
	assert.doesNotMatch(
		expiredDetail,
		/37%/,
		"detail view must not show old allowance past reset either",
	);

	let usageReads = 0;
	let failUsage = false;
	let usageGate: Promise<void> | null = null;
	const authorities: string[] = [];
	const json = (body: unknown, status = 200) =>
		new Response(JSON.stringify(body), {
			status,
			headers: { "Content-Type": "application/json", "X-Pi-Contract": "2" },
		});
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const request = input instanceof Request ? input : new Request(input, init);
		const path = new URL(request.url).pathname;
		if (path === "/v0/resource/plugins/pi-bridge/well-known") return json(discovery);
		if (path === "/v0/resource/plugins/pi-bridge/capabilities")
			return json({
				schemaVersion: 1,
				plugin: "pi-bridge",
				contract: 2,
				latestContract: 2,
				endpoints: { usage: "/usage" },
			});
		if (path === "/v0/resource/plugins/pi-bridge/usage") {
			usageReads++;
			authorities.push(request.headers.get("authorization") ?? "");
			if (usageGate) {
				const gate = usageGate;
				usageGate = null;
				await gate;
			}
			return failUsage ? json({}, 503) : json(usage);
		}
		throw new Error(`Unexpected fixture path: ${path}`);
	}) as typeof fetch;
	// These imports intentionally exercise the plugin after HOME/clock isolation:
	// their module-load cache paths must never bind to the real user directory.
	const { default: aiGateway } = await import("../index.ts");
	const { USAGE_CACHE_TTL_MS, writeUsageCache } = await import("../src/usage-shared-cache.ts");
	// Every piece of state is addressed by profile now, and only `prod` migrates
	// the pre-profile single-endpoint layout — which this isolated HOME never had.
	const prodPaths = profilePaths("prod");
	mkdirSync(prodPaths.dir, { recursive: true });
	const configPath = prodPaths.configPath;
	writeFileSync(configPath, JSON.stringify(cfg));
	type FixtureContext = {
		hasUI: boolean;
		model: { provider: string; id: string };
		ui: {
			theme: typeof theme;
			notify(): void;
			setStatus(key: string, value: string | undefined): void;
		};
	};
	type Handler = (event: unknown, ctx: FixtureContext) => unknown;
	const handlers = new Map<string, Handler[]>();
	await aiGateway({
		registerProvider() {},
		unregisterProvider() {},
		registerCommand() {},
		on(name: string, handler: Handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
	} as unknown as ExtensionAPI);
	let status: string | undefined;
	const statusByKey: Record<string, string | undefined> = {};
	const ctx: FixtureContext = {
		hasUI: true,
		model: { provider: "codex", id: modelId },
		ui: {
			theme,
			notify() {},
			setStatus(key, value) {
				statusByKey[key] = value;
				status = value;
			},
		},
	};
	const emit = async (name: string) => {
		status = undefined;
		const selected = handlers.get(name);
		assert.ok(selected?.length);
		for (const handler of selected) await handler({ type: name }, ctx);
		return status;
	};

	assert.match((await emit("before_agent_start"))!, /\ud83d\uddd3 .* 37/);
	assert.equal(usageReads, 1);
	now += USAGE_CACHE_TTL_MS; // Exact TTL boundary, not a wall-clock sleep.
	failUsage = true;
	assert.equal(
		await emit("before_agent_start"),
		"\u25cf quota stale",
		"failed refresh carries local staleness",
	);
	assert.equal(usageReads, 2);

	writeFileSync(prodPaths.usageLockPath, "other-fixture-process");
	utimesSync(prodPaths.usageLockPath, now / 1000, now / 1000);
	const beforeLock = usageReads;
	assert.equal(
		await emit("before_agent_start"),
		"\u25cf quota stale",
		"lock contention carries local staleness",
	);
	assert.equal(usageReads, beforeLock);
	rmSync(prodPaths.usageLockPath);

	assert.equal(await emit("turn_end"), "\u25cf quota stale");
	const beforeReadOnly = usageReads;
	assert.equal(
		await emit("turn_end"),
		"\u25cf quota stale",
		"debounced read-only fallback carries local staleness",
	);
	assert.equal(usageReads, beforeReadOnly);

	failUsage = false;
	assert.match(
		(await emit("before_agent_start"))!,
		/\ud83d\uddd3 .* 37/,
		"successful refresh clears local staleness despite aggregate stale hint",
	);
	const freshReads = usageReads;
	assert.match((await emit("before_agent_start"))!, /\ud83d\uddd3 .* 37/);
	assert.equal(usageReads, freshReads, "same authority may reuse a fresh shared cache");

	// A real model switch must refresh an aged window instead of leaving the
	// footer on the previous cache, and must reuse a window refreshed moments ago.
	const switchReads = usageReads;
	assert.match((await emit("session_start"))!, /\u25cf .*\ud83d\uddd3 .* 37/);
	assert.match(
		statusByKey[PROFILE_STATUS_KEY]!,
		/^\u25cf .*\ud83d\uddd3 .* 37$/,
		"the contour dot and quota share one compact row",
	);
	assert.deepEqual(
		Object.entries(statusByKey)
			.filter(([, value]) => value !== undefined)
			.map(([key]) => key),
		[PROFILE_STATUS_KEY],
		"only one status key may own the footer",
	);
	now += USAGE_CACHE_TTL_MS;
	ctx.model = { provider: "deepseek", id: switchModelId };
	await delay(900);
	assert.equal(usageReads, switchReads + 1, "a model switch refreshes an aged shared cache once");
	assert.match(status!, /\ud83d\uddd3 .* 61/, "the switched model shows its own connector window");
	assert.doesNotMatch(status!, /stale/);
	ctx.model = { provider: "codex", id: modelId };
	await delay(900);
	assert.equal(
		usageReads,
		switchReads + 1,
		"a switch inside the refreshed window must not refetch",
	);
	assert.match(status!, /\ud83d\uddd3 .* 37/);

	// A refresh that started for the previous model must not overwrite the
	// footer after a switch. The newer request owns the row; the late result is
	// dropped even though it eventually refreshes the shared cache.
	now += USAGE_CACHE_TTL_MS;
	ctx.model = { provider: "codex", id: modelId };
	const gate = Promise.withResolvers<void>();
	usageGate = gate.promise;
	const staleRefresh = emit("before_agent_start");
	await delay(10);
	ctx.model = { provider: "deepseek", id: switchModelId };
	assert.equal(
		await emit("before_agent_start"),
		"\u25cf quota stale",
		"the current model owns the footer while its data is still stale",
	);
	gate.resolve();
	await staleRefresh;
	assert.equal(
		status,
		"\u25cf quota stale",
		"a late old-model refresh must not replace the current footer",
	);
	ctx.model = { provider: "codex", id: modelId };
	assert.match((await emit("before_agent_start"))!, /\ud83d\uddd3 .* 37/);
	await emit("session_shutdown");

	failUsage = true;
	writeFileSync(
		configPath,
		JSON.stringify({ ...cfg, proxy: { ...cfg.proxy, apiKey: "fixture-key-b" } }),
	);
	assert.equal(
		(await import("../src/config.ts")).loadConfig().proxy.apiKey,
		"fixture-key-b",
		"fixture configuration must reload",
	);
	assert.equal(
		await emit("before_agent_start"),
		"\u25cf quota unknown",
		"another key must not inherit even a fresh old document",
	);
	assert.equal(authorities.at(-1), "Bearer fixture-key-b");
	writeFileSync(
		configPath,
		JSON.stringify({
			...cfg,
			proxy: { ...cfg.proxy, endpoint: "https://other-freshness.test/v1" },
		}),
	);
	assert.equal(
		await emit("before_agent_start"),
		"\u25cf quota unknown",
		"same key at a different endpoint must not inherit old quota",
	);
	writeFileSync(configPath, JSON.stringify(cfg));
	const beforeRestoredAuthority = usageReads;
	assert.match((await emit("before_agent_start"))!, /\ud83d\uddd3 .* 37/);
	assert.equal(usageReads, beforeRestoredAuthority);

	// The fixture config carries no usageKey, so the plugin's resolved usage key
	// is "" — the scope still has to be the plugin's own profile-scoped shape.
	const scope = cacheScope(cfg.proxy.endpoint, cfg.proxy.apiKey, PREFERRED_CONTRACT, "");
	writeUsageCache(
		prodPaths,
		{
			...currentDocument,
			accounts: [
				{ ...freshAccount, groups: [{ ...freshWindow, resetTime: new Date(now).toISOString() }] },
			],
		},
		scope,
	);
	assert.equal(
		await emit("before_agent_start"),
		"\u25cf quota stale",
		"even a fresh client cache cannot resurrect an expired reset",
	);
	const stored = JSON.parse(readFileSync(prodPaths.usageCachePath, "utf8"));
	assert.equal(stored.doc.cache.stale, false, "local freshness must not rewrite server provenance");
	assert.equal(
		stored.doc.accounts[0].groups[0].state,
		"supported",
		"local freshness must not mutate captured observations",
	);
	console.log("quota freshness check: ok");
} finally {
	globalThis.fetch = originalFetch;
	Date.now = originalNow;
	process.argv.splice(0, process.argv.length, ...originalArgv);
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	rmSync(home, { recursive: true, force: true });
}
