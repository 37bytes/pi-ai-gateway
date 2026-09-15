# AI Gateway

[![GitHub](https://img.shields.io/github/license/37bytes/pi-ai-gateway)](https://github.com/37bytes/pi-ai-gateway)

Pi extension for **AI Gateway Platform** model discovery, routing, and quota
visibility. One AGP endpoint and one ordinary LLM key configure every provider
and model exposed to the caller.

## Quota in the status line

The footer shows how much of each provider window is left for the model you are
currently using, so a limit is visible before it bites rather than after:

```text
claude-sonnet-5   󰘧 5h ⣶ 69 7d ⣷ 81
claude-fable-5    󰘧 5h ⣶ 69 7d ⣷ 81 Fable ⣾ 91
```

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
Monthly, subscription, and other server-defined windows retain their actual
labels and independent percentages; they are not relabeled as 5h or 7d.

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

Two commands; everything else lives inside the hub as tabs and actions.

| Command | Description |
| --- | --- |
| `/cliproxy` | Hub overlay — **Models** / **Usage** / **Diagnostics** tabs plus global actions |
| `/cliproxy-setup` | Configure endpoint, API key, provider prefix |

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

OMP must support explicit `metadataState` / `priceState`, optional model
capacities and partial prices, and the `buildModel` / `toModelSpec` runtime
exports. Older OMP hosts fabricate 128K/zero defaults and cannot honestly show
unknown prices. Update the host together with this extension; the plugin does
not hide unknown models or use NaN/zero substitutes.

## Install

```bash
pi install github:37bytes/pi-ai-gateway
```

Then run `/cliproxy-setup` to configure the AGP endpoint. The legacy command
name is intentionally retained so existing OMP workflows keep working.

### Taskflow child agents

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
its absolute `index.ts` path instead. A child running in JSON/print mode reads the
discovery cache and registers providers without discovery, usage, command, status, or
timer work. Start Pi once interactively after configuring the proxy to populate that
cache.

## Config

`~/.pi/agent/ai-gateway/config.json` — created by `/cliproxy-setup`, editable
by hand. On first run, AI Gateway imports
`~/.pi/agent/pi-cliproxyapi/config.json` from the upstream v0.4.3 package. An
installed package moves that source config; a local checkout copies it. If the
upstream config does not exist, the older
`~/.config/pi-cliproxyapi/config.json` location is migrated with the same
copy-versus-move behavior.

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
- every connector-backed custom-pool group under the exact configured server
  namespace (`codex`, for example). Legacy display-only group names are
  slugified (`ChatGPT Web` → `chatgpt-web`).

New models appear without a config edit. Matching explicit model settings are
preserved, as are unrelated custom provider definitions. The Models tab remains
read-only in this mode. `providerPrefix` applies only to legacy discovery; it
does not turn a server namespace `codex` into `cpa-codex`. Changing this option
does not rewrite existing OMP roles or unrelated custom providers.

After a successful refresh, providers previously registered by this extension
but absent from the current catalog/configuration are unregistered in the same
session. A failed refresh keeps the last successful catalog; providers owned by
other extensions are not removed.

### Model identity and metadata

For server route `codex/gpt-6-astra`, OMP registers provider `codex` and local
model ID `gpt-6-astra`, so the selector is displayed exactly once. Chat
Completions, Responses, and Messages requests always carry the server's exact
`wireId`, even after an application payload hook. Session headers, cancellation,
and other stream options are preserved. A missing `x-session-id` is filled from
the OMP session ID without replacing an explicit caller header.

Metadata precedence is `overrides[wireId]` > explicit configured model fields >
trusted server metadata > genuine local catalog metadata for legacy built-ins.
Gateway prices come only from the active AGP snapshot or explicit overrides,
not a bundled upstream tariff. Cost components are USD per million tokens;
missing components stay absent. `metadataState` is `catalog`, `override`, or
`unknown`; `priceState` is `known`, `partial`, or `unknown`. Selecting a model in
the picker does not freeze discovered capacity/prices into manual overrides.

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
  config.ts         ~/.pi/agent/ai-gateway/config.json
  commands.ts       2 slash commands (hub + setup)
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

The source candidate is `0.4.3-agp.5`; publishing and installation are separate
operator steps. `npm test` includes isolated HTTP/SSE model routing, metadata
precedence, quota identity, cache authority, and headless cache checks.

Before publishing, also exercise the **actual OMP extension loader**, not only
the upstream Pi test peer: use an isolated HOME/config and a local fixture
server with no production credentials. Load this checkout's `index.ts` through
OMP's extension loader; apply its pending providers to a real ModelRegistry.
Assert `codex/gpt-6-astra` resolves once, context 1,050,000 / output 128,000 and
cost 10/50/1/12.5 are retained, and unknown/partial model cards stay explicit.
Stream the registry model through each underlying API into the fixture server;
assert exact `codex/gpt-6-astra` payload, preserved session/custom headers and
SSE result, and cancellation without a request. Include `maxInFlightRequests: { codex: 1 }`
to catch nested custom/built-in dispatch acquiring the same provider permit
twice. Exercise footer selection with
two same-kind connector UUIDs plus a key-entitlement record; only the selected
subscription must contribute. Repeat with the packaged candidate via the
installed-package loader path. No paid inference is needed for this smoke.
Keep one session open with a warm `cx` namespace, remove it from the fixture
catalog, and trigger real refresh. Verify the `cx` models disappear without a
session restart while current explicit groups and another provider remain.
