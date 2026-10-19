# AI Gateway

[![GitHub](https://img.shields.io/github/license/37bytes/pi-ai-gateway)](https://github.com/37bytes/pi-ai-gateway)

Pi extension for **AI Gateway Platform** model discovery, routing, and quota
visibility. Each named environment profile has its own AGP endpoint, ordinary
LLM key, model configuration and caches. A conversation stays on its selected
profile; another process can use a different environment simultaneously.

## Production and test profiles

The built-in profile names are `prod` and `test`. The first migration keeps the
existing endpoint in `prod`; changing `profiles.json.defaultProfile` changes
only the default for new conversations. A saved conversation retains its
environment, even when resumed from a differently configured process. An
unknown explicit profile fails closed instead of falling back to production.

Use one `omp`. A new conversation starts on the registry default (`test`), and
`/cliproxy-profile prod|test` switches the current session to another
environment by starting a new conversation; the previous one stays saved on its
own server. For scripts, headless runs and a second concurrent process, select
the process profile with `AGP_PROFILE=prod omp` (or `--agp-profile prod`). OMP's
own `--profile` flag is a different feature and is not the AGP server selector.

A resumed conversation keeps its persisted environment, even when the process
was launched with a different `AGP_PROFILE`. That is intentional: history never
moves silently. Resume may restore the model recorded by the session when it
still names an older AGP namespace that the selected environment serves.

Gateway providers keep the server's own plain names: `codex`, `opencode`,
`deepseek`, built-in names, and local groups. Their model IDs are unchanged, so
`codex/gpt-6-astra` is both the local selector and the exact server wire ID.
Direct providers keep their historical names (`cpa-codex`, `ds-local`) and are
not renamed, removed or used as automatic fallbacks by this extension.

One process serves one environment: a new conversation uses the registry default
(`test`) or `AGP_PROFILE`, and a resumed conversation uses the environment saved
in its own session file. Switching inside a session re-registers the same plain
provider names against the target environment, so the model menu never shows
both environments at once.

`/cliproxy-profile` reports the current environment and origin.
`/cliproxy-profile test` or `prod` asks to start a **new conversation** on that
environment; the previous conversation remains saved on its original server.
`--keep-history` deliberately moves the current conversation after confirmation.
A streaming turn must finish or be explicitly cancelled before a switch.
Unavailable target discovery/model authority refuses the transition rather
than silently sending the next turn to the previous server.

The footer shows one compact row: a green test/red production dot followed by
the selected provider's quota windows. The hub retains the environment and
origin. Configuration, discovery/usage cache files and cross-process locks are per profile;
asynchronous work is gated by the originating session and generation. Model
roles preserve their selected model, effort and service-tier settings while
resolving against the active profile's real catalogue. Missing models are not
invented. Older live child sessions keep their own environment when a parent
changes its conversation; finished sessions release their registrations.

`scripts/switch.sh dev|prod` still selects **plugin code source** (checkout or
package). It does not select an AGP server.

## Quota in the status line

The contour dot and quota windows share one footer status entry, without a
separate environment line, URL or redundant gauge. For example, a Codex account
with a weekly limit is shown as:

```text
● 🗓 ⣷ 81
```

The optional `durationSeconds` field is the authoritative window length. A
604800-second `primary` window is weekly; an 18000-second `secondary` window is
short/hourly and sorts first. Primary/secondary/rolling describe slots or reset
behavior, not durations. A reset deadline is not a window length either.
Explicit legacy labels such as `5h`, `7d`, `weekly` and `monthly` remain usable
only when no numeric duration was supplied. Invalid or unknown periods use
`•`, not a guessed hour/week. Windows sort by their actual duration; different
durations with the same slot name stay separate.

Windows are read live, not guessed. Anthropic caps some models against a slice
of the weekly pool — Fable may draw down half of it, and draws faster than other
models — so that per-model window is shown **alongside** the weekly figure
rather than folded into it. Switching models switches the window on display.
Other models' windows never drag down the general figure.

Green ≥ 70%, yellow 30–69%, red < 30%. The **Usage** tab retains reset and
capture times, freshness, and scope. The footer matches the discovered connector
UUID, not a provider-name guess, and displays only `provider_subscription`
windows. `key_entitlement` caps remain separate in Usage. Missing and stale
measurements say `unknown` or `stale`; they never become zero-percent quota.
The footer shows available provider capacity (the most headroom among eligible
accounts), not a promise about the affinity-selected account or a personal
entitlement. Different periods and model-specific windows are never summed.
Other server-defined windows retain their independent percentages. Their full
labels remain in Usage; the compact footer uses period symbols, never an
invented 5h or 7d label.
Native quota freshness is evaluated for the selected connector and model:
a stale observation for another provider/model does not hide fresh capacity.
Expired client-cache fallbacks and passed valid reset timestamps are marked
stale; invalid or missing reset timestamps are not guessed. Legacy quota without
explicit window states still honors the server's whole-document stale hint.
Selecting a different model re-reads the scoped cache immediately and, when that
window has aged past the shared 15 s TTL, refreshes it once, so a switch shows
the new model's real capacity instead of the previous cache's `stale` marker.
Repeated switches inside the same TTL window reuse the refreshed data and make no
further request; switching never becomes a fetch storm.

## How the numbers get here

AI Gateway Platform implements the current `pi-bridge` compatibility contract
natively. The same ordinary LLM key authenticates inference, model discovery,
and the key-scoped quota projection; no CPA plugin, management credential,
second key, or companion container is required.

```text
Pi + extension  ──▶  AI Gateway Platform
                       /v1/models, /v1/chat/…          model calls
                       /v0/resource/plugins/pi-bridge/
                           capabilities
                           well-known  → model catalogue
                           usage       → authorized quota windows
```

Without the compatibility surface the extension falls back to raw `/v1/models`
with local heuristics, and the quota display is absent.

| | With AGP compatibility façade | Fallback |
| --- | --- | --- |
| Quota in status line + Usage tab | Key-scoped persisted windows | Unavailable |
| Model discovery | Grant-filtered AGP catalogue | `/v1/models`, unknown metadata omitted |
| Classification | Server-declared | Local `owned_by` heuristics |

## Features

- **Live quota** — status-line windows for the model in use, per-account bars in the **Usage** tab, no LLM call
- **Unified hub** — one `/cliproxy` overlay with **Models / Usage / Diagnostics** tabs (number hotkeys `1` `2` `3`) plus global actions: `r` refresh, `e` setup, `s` save
- **Built-in provider routing** — whitelist which Anthropic / OpenAI / etc. models are available through the proxy
- **Custom provider groups** — use server connector namespaces and effective AGP model cards, with explicit manual overrides when needed
- **Exclusive model pool** — a model assigned to one group automatically disappears from others, grouped by `owned_by` with type-to-filter (`/`)
- **Live save state** — the header shows `● unsaved` while you edit and `✓ settings saved` after `s`, no console noise
- **Setup wizard** — `/cliproxy-setup` configures endpoint, API key, and provider prefix interactively

## Commands

Profile selection is separate from the model/usage hub.

| Command | Description |
| --- | --- |
| `/cliproxy` | Hub overlay — **Models** / **Usage** / **Diagnostics** tabs plus global actions |
| `/cliproxy-setup` | Configure endpoint, API key, provider prefix |
| `/cliproxy-profile [prod\|test] [--keep-history]` | Show or explicitly change this conversation's environment |

### The `/cliproxy` hub

Global keys: `[` / `]` or `1` `2` `3` switch tabs · `r` refresh discovery + reapply · `e` setup · `s` save · `q` / `Esc` close.

**Models tab** — three panels cycled with `Tab` / arrows:

- **left** — every provider (built-in + custom). `+ new custom group…` is the last row.
- **right top** — models assigned to the focused provider. `Enter` / `Space` removes one.
- **right bottom** — available pool, grouped by upstream `owned_by`. `Enter` / `Space` attaches. Press `/` to filter the pool by id/name. A `⚠` marks an API mismatch (attach still allowed).

Extra Models keys: `d` removes a custom group (with confirmation).

**Usage tab** — per-account quota bars; `d` shows disabled accounts, `v` shows verbose errors.

**Diagnostics tab** — connectivity, key resolution, and discovery shape.

## Prerequisites

You need an AI Gateway Platform endpoint with the OMP compatibility façade
enabled and an ordinary AGP LLM key authorized for the required models.

The session-profile lifecycle is verified against the actual compiled OMP
18.11.1 runtime. Public SDK/catalog dependencies remain pinned to 18.2.0; no
private host patch or invented capability marker is used. Bun 1.3.14 or newer
is required for development checks.
Gateway credentials remain private to the guarded final HTTP fetch; they are
never registered as provider-wide host API keys.

The extension uses OMP's supported `fetchDynamicModels` registration to own
its provider namespaces. Static registration alone does not
suppress built-in discovery on stock OMP. Keep the gateway's wire identity
separate from the local provider label; do not recreate nested selectors such
as `deepseek/opencode/...` through unrelated builtin providers.

For example, choose `opencode/deepseek-v4.1-flash`. The exact upstream
wire ID remains `opencode/deepseek-v4.1-flash`. Both `x-session-id` and
`x-opencode-session` derive from the actual conversation ID. Explicit request
headers take precedence over model headers, and explicit model headers take
precedence over that default.

## Install

```bash
pi install github:37bytes/pi-ai-gateway
```

Then run `/cliproxy-setup` to configure the AGP endpoint. The legacy command
name is intentionally retained so existing OMP workflows keep working.

OMP's plugin manager can install a pinned revision with
`omp plugin install github:37bytes/pi-ai-gateway#<commit>`. Configure both
profile files before selecting test, and switch its default only after the
test server passes a real inference check. Restart existing processes after
installing new plugin code; changing one conversation's profile is not a
global plugin-code reload.

If the host rejects a discovery (an entry the extension cannot route), the
cached copy is dropped and fetched again: a stale cache can no longer pin a
broken catalog across restarts.

### Child agents

OMP 18.x inherits extension resources automatically. The profile runtime binds
in-process children to their actual selected AGP model/environment and keeps
that binding stable. A child with an indeterminate origin fails closed; it is
not assigned the process's launch default. Headless processes use their own
profile's warm discovery cache without starting discovery/usage polling.

The following allowlist is only for other Pi installations using the separate
taskflow extension, not an OMP 18.x setting:

Taskflow starts children with an extension allowlist, so add this package's entrypoint
there as well; otherwise the child cannot register the proxy-backed model catalog.
For a normal npm installation:

```jsonc
{
  "taskflow": {
    "piChild": {
      "resourceProfile": "allowlist",
      "extensions": [
        "/Users/your-user/.pi/agent/npm/node_modules/pi-ai-gateway/index.ts"
      ]
    }
  }
}
```

Use a real **absolute** path: taskflow does not expand `~`, so replace
`/Users/your-user` with your home directory. Preserve any existing allowlisted
extensions (such as taskflow's path guard and MCP adapter). For a local checkout, use
its absolute `index.ts` path instead. A child in JSON/print mode uses the
profile-scoped discovery cache, with environment-binding hooks but no
interactive commands or timers. Warm each configured profile once before
starting cache-only children.

## Config

`~/.pi/agent/ai-gateway/profiles.json` contains `schemaVersion: 1`,
`defaultProfile`, and the profile descriptors. Each
`~/.pi/agent/ai-gateway/profiles/<id>/config.json` contains the configuration
below and is edited by `/cliproxy-setup` for that session's profile. The same
directory holds `discovery-cache.json`, `usage-cache.json`, `usage-cache.lock`
and the generated OMP role overlay. Owned directories are `0700`; configs and
caches are written atomically with `0600` permissions.

On upgrade, the old single `ai-gateway/config.json` and scope-matching caches
move once into `profiles/prod`; caches for another endpoint/key are not adopted.
Upstream `~/.pi/agent/pi-cliproxyapi/config.json` and the older
`~/.config/pi-cliproxyapi/config.json` remain migration inputs, never a second
active authority. Upgrade all plugin installations sharing this state together;
an old single-endpoint reader must not keep using the migrated layout.

```jsonc
{
  "proxy": {
    "endpoint": "https://proxy.example.com/v1",
    "apiKey": "!cat ~/.pi/agent/ai-gateway/key",
    "providerPrefix": "corp"
  },
  "registerAll": true, // optional — see below
  "builtinProviders": {
    "anthropic": { "enabled": true, "models": ["claude-opus-4-7"] },
    "openai": { "enabled": true, "models": ["gpt-5.2"] }
  },
  "customProviders": {
    "corp-glm": {
      "api": "openai-completions",
      "models": [{ "id": "glm-4.7", "name": "GLM 4.7" }]
    }
  }
}
```

Values support `!command` (shell exec), `$ENV_VAR`, or literal strings. The `/cliproxy-setup` wizard also accepts bare `~/path` values and saves them as `!cat` commands; when editing the file by hand, write the `!cat ~/path` form explicitly.

### `registerAll` — every model the gateway reports

Default `false` (explicit allowlists above decide what is registered). Set it
to `true` to register **every** provider and model the gateway serves on each
refresh:

- every built-in provider with its discovered models, and
- every connector-backed custom-pool group under its server namespace
  (`codex`, `opencode`, for example).
  Legacy display-only group names are slugified inside that environment.

New models appear without a config edit. Matching explicit model settings are
preserved, as are unrelated custom provider definitions. The Models tab remains
read-only in this mode. `providerPrefix` affects only legacy discovery; plain
server names are used. Role mapping is session-local; unrelated direct/local
roles are kept.

After a successful refresh, providers previously registered by this extension
but absent from the current catalog/configuration are unregistered in the same
session. A failed refresh keeps the last successful catalog; providers owned by
other extensions are not removed.

### Model identity and metadata

For server route `codex/gpt-6-astra`, the test profile registers provider
`codex` and local model ID `gpt-6-astra`. Chat
Completions, Responses, and Messages requests always carry the server's exact
`wireId`, even after an application payload hook. Session headers, cancellation,
and non-transport stream options are preserved. A missing `x-session-id` is
filled from the OMP session ID without replacing an explicit caller header.
Caller `fetch` overrides are deliberately not delegated: the final credential
boundary calls the process fetch only after validating the exact gateway URL.

Gateway streaming rejects stale or mismatched provider/API/base-URL model
objects before dispatch. On OMP, the final fetch is restricted to the exact
registered gateway endpoint and refuses redirects, including URL rewrites from
native provider environment settings. The registered provider-wide API key is
a nonsecret availability marker; the real AGP key is injected only at the guarded
final fetch. Native SDK preparation and host request-debug wrappers never receive
that key. Restart OMP after upgrading from a release that registered real keys,
so old in-memory provider/model snapshots cannot survive the cutover.

An explicit connector-group API configuration may select the transport family
when a generic relay advertises another one, for example
`"customProviders": { "codex": { "api": "openai-responses", "models": [] } }`
with `registerAll: true`. It changes only the protocol delegate, never the
server wire ID or credential target. Conflicting discovered families without
an explicit operator configuration remain an error.

Stock OMP can repopulate built-in provider names during native catalog refresh.
The marker prevents those paths receiving an AGP key, but it does not make
native catalog ownership authoritative. Do not interpret a same-named first-party
model as a gateway route: the gateway model must have its registered `agp:*` API
and exact gateway base URL.

Metadata precedence is `overrides[wireId]` > explicit configured model fields >
trusted server metadata > genuine local catalog metadata for legacy built-ins.
Gateway prices come only from the active AGP snapshot or explicit overrides,
not a bundled upstream tariff. Cost components are USD per million tokens;
missing components stay absent in discovery/configuration. `metadataState` is
`catalog`, `override`, or `unknown`; `priceState` is `known`, `partial`, or
`unknown`. The plugin labels incomplete model names with `context unknown`,
`output limit unknown`, `price unknown`, or `price partial` as applicable.
Stock OMP may still fill numeric runtime defaults in its own model cards; those
are not discovered gateway limits or confirmed free prices. Selecting a model in
the plugin picker does not freeze capacities/prices into manual overrides.

### Opt-in request latency diagnostics

Start a new OMP process with diagnostics explicitly enabled; this does not turn
on `PI_AI_GATEWAY_DEBUG` and does not record payloads:

```sh
PI_AI_GATEWAY_LATENCY=1 PI_AI_GATEWAY_LATENCY_FILE="$HOME/agp-latency.jsonl" omp
```

The optional file receives one JSON record per completed, failed, or cancelled
gateway stream (new files use mode `0600`; its parent directory must exist).
Without `PI_AI_GATEWAY_LATENCY_FILE`, summaries appear as `[ai-gateway] latency`
UI notifications, or on stderr in headless mode. Retrieve a file with
`cat "$HOME/agp-latency.jsonl"`; disable by restarting without the variables or
with `PI_AI_GATEWAY_LATENCY=0`. No replay, extra inference, or paid request is
performed by enabling diagnostics. File-write failures cannot fail inference.

Each stream generates a nonsecret UUID in `X-AGP-Trace-ID` at the final guarded
fetch. Correlate `trace_id` with gateway logs and each HTTP attempt's response
`X-Request-ID` (`request_id`); these are not session IDs or authorization IDs.
Only bounded timings, status codes, those identifiers, outcome, timestamp, and
host-reported output token count are recorded—never keys, prompts, output text,
raw SSE frames, URLs, arbitrary headers, or external error bodies.

- All `*_ms` stage timestamps are offsets from entry into this plugin's stream
  preparation. `plugin_prepare_ms` is plugin preparation only, not application
  queue time. `client_queue_ms: null` means the application queue is unobservable.
- `native_pre_dispatch_ms` includes native SDK preparation and any native wait
  after plugin preparation; it is **not** a queue-only measurement.
- Each `attempts` item has `dispatch_ms`, `headers_ms`, and `ttfb_ms` (dispatch to
  response headers), status and request ID. At most 16 attempts are retained;
  `attempt_count` includes any additional native retries.
- `first_sse_ms` observes the native SSE callback without reading its payload.
  `first_output_ms` is the first nonempty text, thinking, or tool-argument delta.
  Unobserved stages are `null`, never fabricated zeroes.
- `decode_elapsed_ms` is first output through completion, including local
  parsing/terminal usage latency; `total_ms` includes preparation and waiting.
  `output_tokens` is final host usage, not a count inferred from text. Neither
  `output_tokens / total_ms` nor this observed decode interval is advertised as
  provider generation TPS. Gateway guardrail totals likewise are not mask-only
  timings.

Discovery and usage caches are bound to endpoint, a SHA-256 identity of the
resolved credentials, and contract version. Raw credentials are not written to
cache envelopes. Pre-scope caches and caches from another endpoint/key are
ignored. Repopulate discovery interactively after upgrading or changing keys
before starting headless children.

## Setup

Run `/cliproxy-setup` in Pi and enter:

- **endpoint** — your public proxy URL ending with `/v1`
- **apiKey** — ordinary AI Gateway Platform LLM key
- **providerPrefix** — optional prefix for legacy custom groups; use empty for native AGP namespaces

## Migrating from the wellknown sidecar

Earlier versions read `/.well-known/pi` and `/api/usage` from a separate
sidecar, which needed its own `usageKey`. AI Gateway prefers the pi-bridge
plugin and its ordinary model API key, while retaining the upstream fallbacks.

1. Install pi-bridge into AI Gateway (see its README).
2. Install or update this extension.
3. Confirm the Usage tab still populates — it now says `source=plugin`.
4. Remove the sidecar's routes from your reverse proxy, then stop the container.
5. Remove `proxy.usageKey` from the config; it is only a fallback.

The order is safe: until pi-bridge answers, AI Gateway keeps using the legacy
sidecar, and `/v1/models` remains the discovery fallback.

## Layout

```
index.ts            ExtensionFactory entry point
src/
  profiles.ts       registry and private per-profile layout
  profile-context.ts  explicit/persisted profile resolution
  session-runtime.ts  binding, generations, provider ownership and switching
  session-model.ts  model alignment while preserving effort/service tiers
  role-map.ts       catalogue-validated per-profile role mapping
  config.ts         profiles/<id>/config.json
  commands.ts       hub, setup and profile selection
  apply.ts          pi.registerProvider calls
  fetch-models.ts   catalogue from pi-bridge, /v1/models fallback
  fetch-usage.ts    quota from pi-bridge, sidecar fallback, TTL cache
  compat.ts         baseUrl derivation, model classification
  conflicts.ts      read-only ~/.pi/{models,auth}.json scan
  ui-frame.ts       single source of truth for overlay frames
  ui-setup.ts       setup wizard
  ui-usage.ts       ANSI-coloured usage renderer
  ui-hub/           the /cliproxy hub overlay
    index.ts        public runHub entry
    hub.ts          tabs, status header, global actions
    types.ts        HubView contract
    shell.ts        tab bar, status header, scroll/slice helpers
    view-models.ts  three-panel picker (single pool ordering + filter)
    view-usage.ts   usage tab (lazy fetch + d/v toggles)
    view-diagnostics.ts  diagnostics tab
  ui-picker/        picker building blocks reused by the Models view
    types.ts        shared TS types
    catalog.ts      build a model lookup from discovery
    providers.ts    resolve the providers shown in the left panel
    mutate.ts       attach / detach / claim + pool grouping + display order
    render-text.ts  ANSI-aware pad / truncate
    rows.ts         per-row renderers for left / right panels
    prompt-confirm.ts    remove-group confirmation
    prompt-name.ts       new-group name prompt
  log.ts            tagged logger
```

## Release acceptance

Version `0.4.3-agp.11` adds session-bound server profiles. Publishing and
installation are separate operator steps; installations should pin the full
Git commit. `npm test` uses credential-free temporary homes and covers profile
migration, namespace/credential boundaries, cache isolation, async generations,
child origin, transactional switching and model metadata/transport contracts.
The actual OMP 18.11.1 lifecycle smoke additionally exercises concurrent
prod/test processes, a confirmed new-conversation switch, inactive-provider
cleanup, and resuming the original conversation on its original server.

Run `npm run check:installed-host` against the actual installed OMP binary.
This local-only fixture runs two real conversations against a warm cache,
refreshes online and offline, verifies canonical namespace ownership, and sends
12 streams using Chat Completions and Responses with provider concurrency 1.
It checks exact wire IDs, stable session headers within each conversation,
distinct IDs across conversations, explicit-header precedence, endpoint-bound
credentials, and sanitized latency records. No production credentials or paid
inference are used. Repeat against the installed package with
`OMP_FIXTURE_PLUGIN_ROOT=/absolute/path/to/installed/pi-ai-gateway`.

Quota refresh uses stock OMP's session/turn lifecycle. While idle, a lightweight
current-model check updates the footer from the scoped cache when selection
changes; expired cache data remains explicitly stale until refreshed.
