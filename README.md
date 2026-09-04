# AI Gateway

[![GitHub](https://img.shields.io/github/license/37bytes/pi-ai-gateway)](https://github.com/37bytes/pi-ai-gateway)

Pi extension for **AI Gateway** model discovery, routing, and quota visibility.
AI Gateway fronts a [CliProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
deployment with one endpoint and one API key; every provider and model inherits
that connection automatically.

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

Green ≥ 70%, yellow 30–69%, red < 30%. The **Usage** tab breaks the same data
down per account, with reset times.

## How the numbers get here

Quota and the model catalogue come from the
**[pi-bridge](https://github.com/abix5/pi-cliproxyapi-bridge)** plugin running
inside AI Gateway, authenticated with the same `apiKey` used for model calls
— no second credential, no extra container:

```text
Pi + extension  ──▶  AI Gateway
                       /v1/models, /v1/chat/…          model calls
                       /v0/resource/plugins/pi-bridge/
                           well-known  →  model catalogue
                           usage       →  per-account quota
```

The plugin caches quota server-side, so every Pi instance shares one upstream
poll and provider rate limits stay comfortable. It also knows where each
provider keeps its numbers — a description that lives in configuration, so a
provider reshuffling its API is answered by an edit rather than a release.

Without the plugin the extension still works: it falls back to raw `/v1/models`
with local heuristics, and the quota display is simply absent.

| | With pi-bridge | Without |
| --- | --- | --- |
| Quota in status line + Usage tab | Live per-account windows | Unavailable |
| Model discovery | Enriched from [models.dev](https://models.dev) — real context windows, costs, reasoning flags | Defaults: `contextWindow=128k`, `maxTokens=16k`, `cost=0` |
| Classification | Server-side | Local heuristics by `owned_by` |

See the [pi-bridge README](https://github.com/abix5/pi-cliproxyapi-bridge)
for installing it into AI Gateway.

## Features

- **Live quota** — status-line windows for the model in use, per-account bars in the **Usage** tab, no LLM call
- **Unified hub** — one `/cliproxy` overlay with **Models / Usage / Diagnostics** tabs (number hotkeys `1` `2` `3`) plus global actions: `r` refresh, `e` setup, `s` save
- **Built-in provider routing** — whitelist which Anthropic / OpenAI / etc. models are available through the proxy
- **Custom provider groups** — create named groups (e.g. `corp-glm`, `corp-gemini`) for proxy-only models with automatic metadata from [models.dev](https://models.dev)
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

You need a running **AI Gateway** backed by
[CliProxyAPI](https://github.com/router-for-me/CLIProxyAPI) — the corporate
LLM proxy that aggregates multiple providers behind a single OpenAI-compatible
endpoint. For quota windows and enriched model metadata, also install
**[pi-bridge](https://github.com/abix5/pi-cliproxyapi-bridge)** into it.

## Install

```bash
pi install npm:pi-ai-gateway
```

Then run `/cliproxy-setup` to configure your proxy endpoint.

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

## Setup

Run `/cliproxy-setup` in Pi and enter:

- **endpoint** — your public proxy URL ending with `/v1`
- **apiKey** — CliProxyAPI bearer key
- **providerPrefix** — short slug for custom provider names (e.g. `corp`)

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
