```
██████╗ ██╗     ██████╗██╗     ██╗██████╗ ██████╗  ██████╗ ██╗  ██╗██╗   ██╗
██╔══██╗██║    ██╔════╝██║     ██║██╔══██╗██╔══██╗██╔═══██╗╚██╗██╔╝╚██╗ ██╔╝
██████╔╝██║    ██║     ██║     ██║██████╔╝██████╔╝██║   ██║ ╚███╔╝  ╚████╔╝
██╔═══╝ ██║    ██║     ██║     ██║██╔═══╝ ██╔══██╗██║   ██║ ██╔██╗   ╚██╔╝
██║     ██║    ╚██████╗███████╗██║██║     ██║  ██║╚██████╔╝██╔╝ ██╗   ██║
╚═╝     ╚═╝     ╚═════╝╚══════╝╚═╝╚═╝     ╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝   ╚═╝
```

# pi-cliproxyapi

[![npm](https://img.shields.io/npm/v/pi-cliproxyapi)](https://www.npmjs.com/package/pi-cliproxyapi)
[![GitHub](https://img.shields.io/github/license/abix5/pi-cliproxyapi)](https://github.com/abix5/pi-cliproxyapi)

Pi extension for corporate management of model providers via a single [CliProxyAPI](https://github.com/router-for-me/CLIProxyAPI) endpoint.

One `(endpoint, apiKey)` pair — every provider and model inherits it automatically.

![pi-cliproxyapi — the /cliproxy hub, Models tab](docs/pi-cliproxyapi-1.png)

## Features

- **Unified hub** — one `/cliproxy` overlay with **Models / Usage / Diagnostics** tabs (number hotkeys `1` `2` `3`) plus global actions: `r` refresh, `e` setup, `s` save
- **Built-in provider routing** — whitelist which Anthropic / OpenAI / etc. models are available through the proxy
- **Custom provider groups** — create named groups (e.g. `corp-glm`, `corp-gemini`) for proxy-only models with automatic metadata from [models.dev](https://models.dev)
- **Exclusive model pool** — a model assigned to one group automatically disappears from others, grouped by `owned_by` with type-to-filter (`/`)
- **Live save state** — the header shows `● unsaved` while you edit and `✓ settings saved` after `s`, no console noise
- **Per-account usage tab** — colored quota bars, toggle disabled accounts, verbose errors — no LLM call
- **Setup wizard** — `/cliproxy-setup` configures endpoint, API key, provider prefix, and usage key interactively

## Commands

Two commands; everything else lives inside the hub as tabs and actions.

| Command | Description |
| --- | --- |
| `/cliproxy` | Hub overlay — **Models** / **Usage** / **Diagnostics** tabs plus global actions |
| `/cliproxy-setup` | Configure endpoint, API key, provider prefix, usage key |

### The `/cliproxy` hub

Global keys: `[` / `]` or `1` `2` `3` switch tabs · `r` refresh discovery + reapply · `e` setup · `s` save · `q` / `Esc` close.

**Models tab** — three panels cycled with `Tab` / arrows:

- **left** — every provider (built-in + custom). `+ new custom group…` is the last row.
- **right top** — models assigned to the focused provider. `Enter` / `Space` removes one.
- **right bottom** — available pool, grouped by upstream `owned_by`. `Enter` / `Space` attaches. Press `/` to filter the pool by id/name. A `⚠` marks an API mismatch (attach still allowed).

Extra Models keys: `d` removes a custom group (with confirmation).

**Usage tab** — per-account quota bars; `d` shows disabled accounts, `v` shows verbose errors.

**Diagnostics tab** — connectivity, key resolution, and discovery shape.

## Screenshots

**Models — custom group, pool grouped by owner (`/` filters the pool)**

![Models tab: custom proxy group with grouped available pool](docs/pi-cliproxyapi-2.png)

**Usage — per-account quota windows**

![Usage tab: per-account quota bars with reset windows](docs/pi-cliproxyapi-3.png)

**Diagnostics — connectivity, keys, discovery shape**

![Diagnostics tab: endpoint, key resolution, discovery and conflicts](docs/pi-cliproxyapi-4.png)

## Prerequisites

You need a running [CliProxyAPI](https://github.com/router-for-me/CLIProxyAPI) instance — this is the corporate LLM proxy that aggregates multiple providers behind a single OpenAI-compatible endpoint.

For full functionality (Usage tab, enriched model metadata from [models.dev](https://models.dev)), also install the **[pi-bridge](https://github.com/abix5/pi-cliproxyapi-bridge)** plugin into that instance. See [Discovery](#discovery) below.

## Install

```bash
pi install npm:pi-cliproxyapi
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
        "/Users/your-user/.pi/agent/npm/node_modules/pi-cliproxyapi/index.ts"
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

`~/.pi/agent/pi-cliproxyapi/config.json` — created by `/cliproxy-setup`, editable by hand. If only the legacy `~/.config/pi-cliproxyapi/config.json` exists, an installed plugin moves it here once; a local checkout copies it and retains the legacy file.

```jsonc
{
  "proxy": {
    "endpoint": "https://proxy.example.com/v1",
    "apiKey": "!cat ~/.pi/agent/pi-cliproxyapi/key",
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

## Discovery

The extension reads the model catalogue and provider quota from the
**[pi-bridge](https://github.com/abix5/pi-cliproxyapi-bridge)** plugin running
inside CliProxyAPI, authenticating with the same `apiKey` it uses for model
calls. No second credential and no extra container are involved.

```
┌──────────────┐     ┌────────────────────────────────────────┐
│  Pi + plugin │────▶│  CliProxyAPI                           │
│              │     │  /v1/models, /v1/chat/...              │
│              │     │  /v0/resource/plugins/pi-bridge/…      │
│              │     │      well-known → model catalogue      │
│              │     │      usage      → per-account quota    │
└──────────────┘     └────────────────────────────────────────┘
```

Without the plugin the extension still works: it falls back to raw `/v1/models`
with local heuristics.

| | With pi-bridge | Without |
| --- | --- | --- |
| Model discovery | Enriched from [models.dev](https://models.dev) — real context windows, costs, reasoning flags | Defaults: `contextWindow=128k`, `maxTokens=16k`, `cost=0` |
| Usage tab | Per-account quota bars | Unavailable |
| Classification | Server-side | Local heuristics by `owned_by` |

See the plugin's README for installing it into CliProxyAPI.

## Setup

Run `/cliproxy-setup` in Pi and enter:

- **endpoint** — your public proxy URL ending with `/v1`
- **apiKey** — CliProxyAPI bearer key
- **providerPrefix** — short slug for custom provider names (e.g. `corp`)

## Migrating from the wellknown sidecar

Earlier versions read `/.well-known/pi` and `/api/usage` from a separate
`pi-cliproxyapi-wellknown` container, which needed its own `usageKey`. Version
0.4.0 reads both from the pi-bridge plugin instead.

1. Install pi-bridge into CliProxyAPI (see its README).
2. Update this extension to 0.4.0 or later.
3. Confirm the Usage tab still populates — it now says `source=plugin`.
4. Drop the sidecar's routes from your reverse proxy, then stop the container.
5. Remove `proxy.usageKey` from the config above; it is no longer read by the
   setup wizard and is only consulted as a fallback.

Steps 1–2 are safe in either order: until the plugin answers, the extension
keeps using the sidecar, and a version older than 0.4.0 keeps working against a
server that already runs the plugin.

## Layout

```
index.ts            ExtensionFactory entry point
src/
  config.ts         ~/.pi/agent/pi-cliproxyapi/config.json
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
