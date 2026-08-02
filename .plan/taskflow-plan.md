# Approval plan: dev-only unified Pi usage authorization

## Goal and acceptance contract

- [ ] Add an opt-in Pi plugin mode (`proxy.devMode: true`) that keeps inference on `https://lproxy.prodentcrm.ru/v1`, discovers only `GET /.well-known/pi/dev`, and calls only `GET /api/usage/dev` with `Authorization: Bearer <resolved proxy.apiKey>`.
- [ ] Keep the default/legacy mode byte-for-byte compatible at the HTTP boundary: `GET /.well-known/pi`, `/v1/models` fallback, and `GET /api/usage` with `X-Plugin-Key: <resolved proxy.usageKey>`.
- [ ] Add dev sidecar routes with this exact contract:
  - `GET /.well-known/pi/dev` — same schema-v1 model document as production plus `contractVariant: "dev"`; retain the existing Pi User-Agent gate.
  - `GET /api/usage/dev` — accept only a Bearer token whose SHA-256 fingerprint is in the explicit dev allow-list; return the existing usage schema plus `keyIdentity: { alias, fingerprint }`, where `fingerprint` is only `sha256:<first 12 hex chars>`.
- [ ] Use the normal CliProxyAPI key with safe alias `abix` for the proof. Derive its full SHA-256 on the host from the top-level `api-keys` entry in `/root/projects/llm-proxy/CLIProxyAPI/data/config.yaml`; never copy or print the raw key. The currently observed safe prefix is `sha256:56cef19284f7`.
- [ ] Add two Cloudflare public-hostname path routes on remotely managed tunnel `ac8c4ffd-3f1f-4098-897d-a3f527bbd48b` for `lproxy.prodentcrm.ru`, both targeting `http://localhost:3458`:
  - `/.well-known/pi/dev`
  - `/api/usage/dev`
- [ ] Verify discovery, model registration/listing, allowed and denied usage, cache isolation/TTL, secret hygiene, and unchanged production behavior.
- [ ] Commit source changes in each source repository with the exact message `feat(usage): validate unified key on dev endpoint` (Git cannot make one commit span both repositories).

## Evidence and current state

- Plugin repository: `/Users/dmitriynenashev/Projects/pi-lproxy`, clean branch `feat/dev-unified-usage-key`, currently at `origin/main` (`b0ce771`).
- Sidecar repository: `/Users/dmitriynenashev/Projects/pi-cliproxyapi-wellknown`, clean `main` at `origin/main` (`76eb253`); implementation must start on a new `feat/dev-unified-usage-key` branch from a freshly fetched default branch.
- Remote deployment root: `/root/projects/llm-proxy`; active compose file is `/root/projects/llm-proxy/docker-compose.yml`; the active sidecar checkout is `/root/projects/llm-proxy/pi-cliproxyapi-wellknown`; runtime secrets/config are in `/root/projects/llm-proxy/.env` and `/root/projects/llm-proxy/CLIProxyAPI/data/config.yaml`.
- The tunnel is token-driven by `/etc/systemd/system/cloudflared.service` and `/etc/cloudflared/cloudflared.env`; ingress is remotely managed, so there is no local Cloudflare ingress YAML to edit.
- Current public behavior: `/.well-known/pi` returns 200 with the Pi User-Agent, `/api/usage` returns 401 without its legacy key, and both proposed `/dev` paths return 404.
- The active sidecar container is `pi-cliproxyapi-wellknown` on `127.0.0.1:3458`; CliProxyAPI remains separately bound on `127.0.0.1:3456`.
- Cloudflare blocks generic Python/curl signatures with Error 1010; every public validation request must send the plugin User-Agent (`pi-cliproxyapi/0.3.5` or the version updated by implementation).

## Preflight and stop-before-edit checks

- [ ] Fetch both repositories and confirm no dirty files, divergent branches, stashes, or unexpected commits. Stop rather than stash, reset, rebase, overwrite, or resolve conflicts automatically.
- [ ] Confirm the sidecar branch is newly created from current `origin/main`; confirm the plugin branch remains based on current `origin/main` and has not already been merged.
- [ ] Consult current TypeScript/Node fetch behavior, Python `hashlib`/`hmac.compare_digest`, and current Cloudflare Tunnel public-hostname path-routing documentation before implementation; add no dependency because installed/runtime standard libraries cover the change.
- [ ] Capture sanitized pre-change production snapshots: status, schemaVersion, model IDs/counts, response headers, and usage account count. Do not persist response credentials or raw authorization headers.
- [ ] On the remote host, back up `/root/projects/llm-proxy/docker-compose.yml` and `/root/projects/llm-proxy/.env` with timestamped mode-preserving copies; record the current sidecar commit and current Cloudflare route order for rollback.
- [ ] Confirm the top-level CliProxyAPI key comment/alias `abix` still hashes to the expected safe prefix and succeeds against `/v1/models` with the Pi User-Agent. Stop if the alias is missing, duplicated, or no longer valid.

## Plugin repository changes

Repository: `/Users/dmitriynenashev/Projects/pi-lproxy`

### Exact files and minimal changes

- [ ] `src/config.ts`
  - Add optional `proxy.devMode?: boolean`; normalize only an actual boolean and default to `false`/absent so every existing config remains legacy.
  - Add one small shared resolver for the usage credential source: dev mode resolves `proxy.apiKey`; legacy mode resolves `proxy.usageKey`. Do not add a second dev key or a general routing framework.
- [ ] `src/fetch-models.ts`
  - Select `/.well-known/pi/dev` only when `devMode` is true; otherwise retain `/.well-known/pi` exactly.
  - Require `contractVariant === "dev"` for the dev route so a Cloudflare misroute or stale production document cannot count as successful dev discovery.
  - In dev mode, fail the dev proof if the dev well-known route is unavailable or malformed instead of silently treating `/v1/models` fallback as successful dev discovery. Keep the existing production fallback unchanged.
  - Include the selected route/variant in non-secret diagnostics; never include API keys or Authorization values.
  - Write discovery to the mode-specific cache described below.
- [ ] `src/fetch-usage.ts`
  - Dev mode: call `/api/usage/dev`, require the resolved normal API key, and send `Authorization: Bearer ...`; do not send `X-Plugin-Key`.
  - Legacy mode: retain `/api/usage`, the existing missing-`usageKey` error, and `X-Plugin-Key`; do not send Authorization.
  - Extend `UsageDocument` with optional safe `keyIdentity` metadata without requiring it on production responses.
  - Key the in-memory TTL cache by origin + route/mode, never by the raw credential, so dev and legacy responses cannot be reused across modes.
  - Keep all errors generic (`<path> returned <status>`); do not echo response headers, request headers, or credentials.
- [ ] `src/cache.ts`
  - Preserve the existing production file `discovery-cache.json`.
  - Use `discovery-cache-dev.json` only for dev mode, with defaulted function parameters or equivalent minimal API changes so legacy callers/behavior remain intact.
- [ ] `src/usage-shared-cache.ts`
  - Preserve production `usage-cache.json` and `usage-cache.lock`.
  - Use `usage-cache-dev.json` and `usage-cache-dev.lock` for dev mode; keep the same TTL, stale-lock recovery, and token ownership rules.
- [ ] `index.ts`
  - Resolve the usage credential through the shared config helper so `devMode: true` registers quota event handlers even when `usageKey` is absent.
  - Pass the mode to discovery and shared usage-cache calls.
  - Leave provider registration/inference authorization on `proxy.apiKey` unchanged.
  - Change only the disabled-segment diagnostic text so it accurately distinguishes missing dev `apiKey` from missing legacy `usageKey`.
- [ ] `src/ui-hub/view-usage.ts`
  - Use the shared usage credential resolver; no additional UI state or duplicate dev client.
- [ ] `src/ui-hub/view-diagnostics.ts`
  - Show `contract mode: dev` and `usage auth: proxy.apiKey (Bearer)` in dev mode; retain the existing `usageKey` resolution display in legacy mode.
  - Show only resolution state, never any key value or fingerprint derived client-side.
- [ ] `tests/dev-unified-usage.ts` (new)
  - Use `node:assert/strict`, a temporary HOME/config directory, and mocked `globalThis.fetch`; add no test framework.
  - Assert exact dev/prod discovery URLs, required dev marker, production fallback preservation, exact auth header exclusivity, missing-key errors, allowed/denied status propagation, in-memory cache hits/force bypass, and dev/prod cache isolation.
  - Exercise the extension factory with `devMode: true`, no `usageKey`, and assert quota event handlers are registered.
  - Assert no raw test key appears in thrown errors or captured logs.
- [ ] `package.json`
  - Add one deterministic `check:dev` script using Node's built-in TypeScript stripping to run `tests/dev-unified-usage.ts`; add no dependency and do not alter existing scripts.
- [ ] `README.md`
  - Document the manual dev-only flag, exact dev routes/auth scheme, cache filenames, safe sidecar allow-list format, and a clear warning that production remains the default and still needs `usageKey`.
  - Do not present dev mode as a production migration or deprecate `usageKey`.

### Explicitly unchanged plugin files

- [ ] Do not change `src/ui-setup.ts`: the proof is enabled manually and does not need a permanent wizard step.
- [ ] Do not change `src/apply.ts`, `src/compat.ts`, `src/status-quota.ts`, or model/provider behavior.
- [ ] Do not add a generic endpoint abstraction, auth-provider interface, dependency, or migration that rewrites existing configs.

## Sidecar repository changes

Repository: `/Users/dmitriynenashev/Projects/pi-cliproxyapi-wellknown`

### Exact files and minimal changes

- [ ] `src/server.py`
  - Add exact constants `/.well-known/pi/dev` and `/api/usage/dev`; keep current route constants and handlers operational.
  - Add a settings field sourced from `PI_DEV_USAGE_ALLOWED_KEYS`, encoded as a JSON object of `{ "safe-alias": "sha256:<64 lowercase hex>" }`. Empty/unset means no dev key is authorized.
  - Parse the allow-list at startup with strict alias, fingerprint, duplicate, and shape validation. Store fingerprints/aliases only; never store a raw normal CliProxyAPI key in config.
  - Parse only a single Bearer credential for the dev usage route, hash it with SHA-256, and match the configured full digest with `hmac.compare_digest`.
  - Return the same generic 401 body for missing, malformed, unknown, and non-allow-listed credentials. Do not disclose whether a fingerprint exists.
  - Reuse the existing management usage-building path after authorization; keep `/api/usage`'s `X-Plugin-Key` check and response behavior unchanged.
  - Add `contractVariant: "dev"` only to the dev discovery document.
  - Add `keyIdentity` only to successful dev usage responses, with the configured safe alias and a 12-hex fingerprint prefix; never return the token or full key.
  - Keep request logging to method/path/status/client address only; never log Authorization, X-Plugin-Key, raw token, full allow-list, or settings representations containing secrets.
- [ ] `tests/test_server.py`
  - Extend settings fixtures for the new allow-list.
  - Add tests for dev discovery routing/marker and unchanged production discovery.
  - Add dev usage tests for allowed Bearer, missing/malformed/unknown Bearer, rejection of `X-Plugin-Key` on the dev route, safe identity metadata, and absence of the raw key from body/errors/logs.
  - Retain and explicitly rerun legacy `/api/usage` tests to prove `X-Plugin-Key` behavior is unchanged.
  - Add strict allow-list parser tests: empty fail-closed, invalid JSON, invalid alias, invalid/full-length fingerprint, and duplicate fingerprint.
- [ ] `.env.example`
  - Document `PI_DEV_USAGE_ALLOWED_KEYS` with fake fingerprints only; state that aliases are safe labels and values are full SHA-256 fingerprints of selected top-level CliProxyAPI keys.
- [ ] `compose.yaml`
  - Pass through `PI_DEV_USAGE_ALLOWED_KEYS`; no new port or second container.
- [ ] `README.md`
  - Document both dev routes, Bearer semantics, exact allow-list format, fingerprint generation without printing raw keys, safe response metadata, Cloudflare ordering, and rollback.
  - Keep all production route/auth documentation intact.

### Explicitly unchanged sidecar files

- [ ] Do not modify `src/builders.py`, quota fetchers, model catalog behavior, Docker base image, ports, or management credentials.
- [ ] Do not query or log CliProxyAPI's raw `/v0/management/api-keys` response at request time; authorization is the explicit deployed fingerprint allow-list.

## Source validation before deployment

- [ ] Plugin: `npm run typecheck`.
- [ ] Plugin: `npm run check:migration`.
- [ ] Plugin: `npm run check:dev`.
- [ ] Plugin: run the existing smoke command `node --experimental-strip-types --no-warnings tests/smoke.ts` and confirm no regression/crash.
- [ ] Sidecar: `python3 -m unittest discover -s tests -v`.
- [ ] Sidecar: `docker build -t pi-cliproxyapi-wellknown:dev-unified-usage .` so Dockerfile's test stage also passes.
- [ ] Review both diffs for raw keys, Authorization values, usage keys, management keys, full environment dumps, or accidental secret fixtures. Use synthetic test values only.
- [ ] Run the required reviewer gate with goal, exact changed files, and concise solution summary; fix and repeat until clean before any remote deployment.

## Commit and publish

- [ ] Commit the sidecar branch with exactly `feat(usage): validate unified key on dev endpoint`; push the new branch and verify it is up to date with origin.
- [ ] Commit the plugin branch with exactly `feat(usage): validate unified key on dev endpoint`; push and verify it is up to date with origin.
- [ ] Do not commit `.plan/taskflow-plan.md`, runtime `.env` changes, local Pi config, cache files, backups, or fingerprints generated for deployment.

## Remote deployment

### Runtime files/configuration

- [ ] `/root/projects/llm-proxy/pi-cliproxyapi-wellknown`
  - Fetch the approved sidecar commit/branch without resetting or overwriting unexpected work; stop if the checkout is dirty or cannot fast-forward cleanly.
- [ ] `/root/projects/llm-proxy/.env`
  - Add/update `PI_DEV_USAGE_ALLOWED_KEYS` as compact JSON containing only the `abix` alias and full SHA-256 fingerprint derived in-memory from the matching commented top-level key in `/root/projects/llm-proxy/CLIProxyAPI/data/config.yaml`.
  - Preserve mode/ownership and never print the raw source key or environment file contents.
- [ ] `/root/projects/llm-proxy/docker-compose.yml`
  - Add only `PI_DEV_USAGE_ALLOWED_KEYS: ${PI_DEV_USAGE_ALLOWED_KEYS}` to the existing `pi-cliproxyapi-wellknown.environment` block; do not alter CliProxyAPI, production usage key, ports, networks, or other services.
- [ ] Cloudflare remotely managed tunnel `ac8c4ffd-3f1f-4098-897d-a3f527bbd48b`
  - Clone the two existing sidecar public-hostname rules, append `/dev` to their paths, and keep them before the catch-all `lproxy.prodentcrm.ru` route to `127.0.0.1:3456`.
  - Route both new paths to `http://localhost:3458`; do not widen them to `/dev/*`, `/.well-known/*`, `/api/*`, or `/v1/*`.
  - Validate/save the remotely managed configuration before restarting/recreating anything.
- [ ] Rebuild/recreate only the sidecar: `docker compose up -d --build --no-deps pi-cliproxyapi-wellknown` from `/root/projects/llm-proxy`.
- [ ] Confirm container health, local `127.0.0.1:3458` dev-route behavior, and then public Cloudflare behavior before touching the Pi runtime.

### Dev plugin deployment on the Pi workstation

- [ ] Back up `~/.pi/agent/pi-cliproxyapi/config.json` without displaying it.
- [ ] Run `/Users/dmitriynenashev/Projects/pi-lproxy/scripts/switch.sh dev` and confirm the local checkout is the active Pi package.
- [ ] In `~/.pi/agent/pi-cliproxyapi/config.json`, set `proxy.devMode` to `true`, retain endpoint/apiKey/providerPrefix, and remove `proxy.usageKey` for the proof so a successful usage request cannot be attributed to the legacy credential.
- [ ] Remove only dev cache artifacts (`discovery-cache-dev.json`, `usage-cache-dev.json`, `usage-cache-dev.lock`) before the first proof run; do not delete production cache files.
- [ ] Start a new Pi session and confirm diagnostics report dev contract mode and Bearer usage auth without exposing key material.

## End-to-end validation

- [ ] **Dev discovery:** with the Pi User-Agent, `https://lproxy.prodentcrm.ru/.well-known/pi/dev` returns 200, schemaVersion 1, `contractVariant: "dev"`, expected model counts/IDs, and the expected private cache header; generic/non-Pi User-Agent remains hidden as production is today.
- [ ] **Models:** the dev plugin reports discovery source `well-known`, registers the expected built-in/custom providers, and the same `proxy.apiKey` succeeds against `/v1/models`; no `/dev/v1` inference route is introduced.
- [ ] **Allowed usage:** `https://lproxy.prodentcrm.ru/api/usage/dev` with `Authorization: Bearer <normal abix key>` returns 200, valid usage accounts, alias `abix`, safe fingerprint prefix `sha256:56cef19284f7`, and no raw/full key in the body.
- [ ] **Denied usage:** missing Authorization, malformed scheme, random Bearer, a valid but non-allow-listed normal CliProxyAPI key, and `X-Plugin-Key` against the dev route all return the same generic 401 without identity metadata.
- [ ] **Legacy auth separation:** `/api/usage` still accepts the existing `X-Plugin-Key`, rejects the normal Bearer-only request, and returns the same schema/account behavior as the pre-change snapshot.
- [ ] **Cache behavior:**
  - first dev plugin load performs one dev discovery/usage network fetch and creates only `*-dev` cache files;
  - repeated usage within in-memory/shared TTL does not create extra `/api/usage/dev` access-log entries;
  - explicit hub refresh/force bypass performs exactly one additional request;
  - production cache files remain unchanged and switching `devMode` off cannot read dev cache content.
- [ ] **No secret logging:** scan sidecar/container logs and plugin logs using an in-memory/raw-key comparison script that outputs only match counts; require zero matches for the normal API key, legacy usage key, management key, and Authorization header value.
- [ ] **No production regression:** compare post-change `/.well-known/pi`, `/api/usage`, `/v1/models`, model IDs/counts, status codes, auth requirements, health, and cache headers against the sanitized pre-change snapshot.
- [ ] **Runtime health:** `docker compose ps` shows CliProxyAPI and the sidecar healthy; no unrelated container was recreated; Cloudflare paths route only to their intended local ports.
- [ ] Run the final reviewer gate against the deployed result/evidence. Do not declare completion until review is clean and all real checks above pass.

## Rollback

- [ ] Remove the two dev Cloudflare path rules first so no new requests reach a rollback-in-progress sidecar.
- [ ] Restore the prior sidecar commit and the timestamped `/root/projects/llm-proxy/docker-compose.yml` and `/root/projects/llm-proxy/.env`; recreate only `pi-cliproxyapi-wellknown`.
- [ ] Restore the workstation Pi config backup and run `scripts/switch.sh prod` if the local dev plugin must be withdrawn.
- [ ] Re-run the production snapshot checks after rollback; retain only sanitized failure evidence.

## Risks and mitigations

- [ ] **Route shadowing:** a broad or misordered Cloudflare rule could intercept `/v1/*` or production sidecar routes. Mitigation: two exact path entries only, placed beside existing sidecar rules before catch-all, with pre/post route probes.
- [ ] **Cache cross-contamination:** existing global cache filenames can hide which contract answered. Mitigation: dedicated dev discovery/usage cache and lock files plus route-keyed in-memory cache.
- [ ] **Stale allow-list after key rotation:** fingerprint authorization does not automatically follow CliProxyAPI key rotation. Mitigation: dev-only scope, explicit alias-to-fingerprint configuration, documented regeneration/rollback, and fail-closed empty allow-list.
- [ ] **Fingerprint disclosure:** a full SHA-256 is acceptable for matching but unnecessary in responses. Mitigation: full digest stays only in protected runtime env; responses/logs expose at most alias + 12-hex prefix.
- [ ] **Secret leakage through diagnostics or shell history:** Authorization values can leak through verbose commands. Mitigation: read secrets from files/stdin inside scripts, never command arguments; print status/counts/fingerprints only; grep logs without echoing the search value.
- [ ] **Production semantic drift during shared-handler refactor:** reuse of the usage builder could accidentally alter legacy order/errors. Mitigation: legacy tests and pre/post live snapshots are mandatory; no builder/quota changes.
- [ ] **Cloudflare Error 1010 false negatives:** generic test clients are blocked before origin. Mitigation: all public probes use the exact Pi User-Agent and separately identify Cloudflare-vs-origin responses.

## Stop conditions

- [ ] Stop immediately if either repository or remote checkout is dirty/divergent, a pull is not fast-forward, or any conflict appears.
- [ ] Stop before deployment if source tests, reviewer gate, Docker build, or secret scan fails.
- [ ] Stop if `abix` cannot be unambiguously derived from a current top-level CliProxyAPI key or if its `/v1/models` check fails with the Pi User-Agent.
- [ ] Stop if the Cloudflare change cannot be expressed as two exact path rules, cannot be validated, or changes the catch-all/production route order.
- [ ] Stop and roll back if any production status, auth requirement, model set, usage schema, health state, or cache behavior differs from the pre-change snapshot.
- [ ] Stop, remove exposure, and rotate the affected credential if any raw API key, usage key, management key, or Bearer value appears in git, response metadata, logs, terminal output, or test fixtures.
- [ ] Stop if denied dev requests reveal alias/fingerprint existence or return different bodies based on which authorization check failed.

## Blocking questions for approval

- [ ] Confirm that the exact route convention is suffix-based (`/.well-known/pi/dev` and `/api/usage/dev`), not prefix-based (`/dev/...`). This plan uses the suffix convention already identified in discovery.
- [ ] Confirm that only alias `abix` is initially allow-listed. Adding any other normal CliProxyAPI key is out of scope unless explicitly approved with its safe alias.
- [ ] Confirm that the workstation should remain on the local dev plugin with `devMode: true` and no `usageKey` after successful proof; otherwise the rollback section will restore the prior production package/config immediately after evidence is captured.
