# ISSUE: taskflow child agents have zero usable models (pi-cliproxyapi not loaded in `piChild`)

- **Status:** open (workaround applied at user-settings level; proper fix needed in this package)
- **Package:** `pi-cliproxyapi` (this repo, v0.3.5)
- **Interacts with:** `pi-taskflow` (`taskflow.piChild` spawn config), `@earendil-works/pi-coding-agent` runtime
- **Severity:** high — blocks ALL taskflow subagents/subflows from running on any model
- **Found:** 2026-07 while trying to run `designer` / `architect` subagents on `openai/gpt-5.6-sol`

## Symptom

Every `taskflow action=run` (single agent or flow) fails immediately. The parent
session works fine; only the spawned child process is broken. Representative output:

```
Taskflow 'task' failed (0/1 done, 1 failed).
Warning: No models match pattern "anthropic/claude-opus-4-8"
Warning: No models match pattern "proxy/glm-5.2"
Warning: No models match pattern "openai/gpt-5.6-sol"
... (every entry of settings.enabledModels)
No API key found for openai. Use /login to log into a provider via OAuth or API key.
```

i.e. in the child, **no model pattern resolves at all**, and the fallback to a
direct provider (`openai`) fails because there is no API key (`~/.pi/agent/auth.json`
is empty — auth is normally provided by this proxy extension, not by stored keys).

## Root cause

The parent pi session gets its whole model catalog + auth from **this extension**
(`pi-cliproxyapi`): it registers the proxied model list and routes calls through the
local CLIProxyAPI. `settings.packages` loads it for the parent.

But `pi-taskflow` spawns children with an **allowlisted** extension set:

```jsonc
// settings.json
"taskflow": {
  "piChild": {
    "resourceProfile": "allowlist",
    "extensions": [
      ".../taskflow-extensions/child-path-guard.ts",
      ".../node_modules/pi-mcp-adapter/index.ts"
    ]
  }
}
```

`pi-cliproxyapi` is **absent** from `piChild.extensions`, so the child never
registers the proxied model catalog and starts with an empty model registry →
every configured model (proxy/* and openai/*) is "not found", and the direct-provider
fallback has no key. Net effect: subagents cannot run on any model.

## Workaround (applied at user settings level, reversible)

Prepend this extension to the taskflow child allowlist so the child also loads the
proxy and registers models. The child reads `settings.json` fresh on spawn, so no
parent restart is needed.

```jsonc
"taskflow": {
  "piChild": {
    "extensions": [
      ".../node_modules/pi-cliproxyapi/index.ts",   // <-- added (first, so models
      ".../taskflow-extensions/child-path-guard.ts", //     register before agents resolve)
      ".../node_modules/pi-mcp-adapter/index.ts"
    ]
  }
}
```

After this, child agents resolve e.g. `openai/gpt-5.6-sol` and run. Backup kept at
`~/.pi/agent/settings.json.bak-notif`.

### Secondary note (expected, not this bug)

`child-path-guard.ts` restricts child **writes** to the working directory. Run
taskflow with `cwd` set to the repo root and use **relative** output paths; absolute
paths like `/tmp/...` are rejected ("Taskflow запрещает дочернему агенту запись вне
рабочего каталога").

## Proper fix (options for this package)

The extension should be usable inside a taskflow child out of the box, cheaply.

1. **Docs-only (minimum):** document in README that `taskflow.piChild.extensions`
   must include `pi-cliproxyapi` for subagents to have models. Low effort, leaves
   every user to discover this the hard way.
2. **Slim child entrypoint (recommended):** export a lightweight "child mode" that
   only registers the model catalog + provider routing from the on-disk discovery
   cache (`~/.pi/agent/discovery-cache.json`) and skips parent-only concerns
   (interactive `/commands`, status/quota segments, live `fetchDiscovery`/`fetchUsage`).
   Cheap enough to load on every child spawn; avoids network under the child's
   `allowlist` resourceProfile (which may block discovery fetches → must rely on cache).
3. **Auto-detect child context:** when the extension detects it is running in a
   taskflow child (env/flag from pi-taskflow), self-limit to the slim registration
   path from (2) automatically, so no `piChild.extensions` edit is required.

Preference: (3) if pi-taskflow exposes a detectable child signal, else (2) plus a
short README note. Coordinate the child-detection signal with `pi-taskflow`.

## Acceptance criteria

- [ ] `taskflow action=run` with an agent pinned to a proxied model succeeds on a
      clean setup (no manual `piChild.extensions` edit), OR README documents the
      required allowlist entry.
- [ ] Child model registration does not perform blocking network fetches under
      `resourceProfile: allowlist` (uses discovery cache).
- [ ] Child startup overhead from this extension is negligible per spawn.
- [ ] Revert the user-level workaround once shipped.
