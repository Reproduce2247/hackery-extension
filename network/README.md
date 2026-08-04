# Network rules plugin

Self-contained network-rules feature pack for Complex Linker. Designed so the
tree can become its own Firefox extension later with minimal glue.

## Layout

```
network/
  plugin.js              # ESM host API (init, createMessageHandlers, …)
  background.js          # orchestration (hooks, webRequest sync, log, test)
  messages.js            # runtime message handlers
  message-types.js       # NetworkMessageTypes / NetworkMessageTypeSet
  storage-keys.js        # network storage key constants
  engine/                # rule engine, page hook, webRequest
  inject/                # classic content-script bootstrap
  ui/                    # DevTools rules editor (ES module entry)
  data/                  # rule templates
  scripts/               # build-network-hook.js
```

## Host wiring

From the ESM background entry:

```js
import * as Network from "./network/plugin.js";

await Network.init({ onRulesChanged });
const handlers = {
  ...hostHandlers,
  ...Network.createMessageHandlers(),
};
```

Also forward `storage.onChanged` / `tabs.onRemoved`, and use `Network.getBadgeMark(tabId)` when refreshing the action badge. CSP stripping stays in `lib/csp-disable.js` (shared with the sidebar toggle).

## Build

```bash
npm run build:network-hook
```

Regenerates `engine/network-hook-install.js` from the engine core + page hook source.

## Standalone extraction checklist

- Copy `network/` (and `lib/csp-disable.js` if CSP stripping stays).
- New manifest: `permissions` + `host_permissions` from the plugin exports, `devtools_page` → `ui/rules.html`, `background: { scripts: ["background.js"], type: "module" }`.
- Replace host settings merge with local GET/SET for `networkHooksEnabled` only.
- Drop sidebar Network toggle; use the DevTools panel header / enabled checkbox.
