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

## Matching and logging

Filters alone determine whether a rule matches. All configured filters must
match; scripts run afterward as actions and are not scripting conditions.
Recent matches records each filter match even when replacements and scripts
leave the request unchanged.

Page URL matches the top-level tab URL. Same-origin frames read
`top.location.href`; cross-origin frames use the tab URL supplied at inject
time (refreshed on top-frame navigation and Re-inject). Hooks are still
installed on all frames; Page URL does not gate injection.

## Request / response script contract

Scripts run in the page hook (fetch/XHR). webRequest stays declarative —
block, redirect, header/body replacements — because Firefox MV3 CSP blocks
`new Function()` in extension pages. Revisit with a CSP-safe interpreter in
`network-webrequest.js` (`applyHeaderRules` / `applyResponseBodyRules`) if
non-fetch scripting is needed later.

Modify rules run field replacements first, then the phase script.

| Script return | Effect |
| --- | --- |
| modified `ctx` | Apply script changes to method/url/headers/body/status |
| `null` | Block the request/response |
| `undefined` / no return | Discard in-place script mutations; keep only prior regex replacements |
| throw | Same as no return (wire fields restored; error logged) |

If nothing changed the request after replacements + script, the page hook calls the native `fetch` / `XHR.send` with the original arguments so `Request`, `FormData`, `Blob`, and similar bodies pass through untouched.

Re-inject installs both the isolated-world log bridge and the MAIN-world hook into existing frames (`allFrames`), not only the top frame. The bridge is idempotent so repeated injects do not stack listeners.

For future navigations, `network-early-hook.js` is registered directly in the
MAIN world at `document_start`. It queues fetch and asynchronous XHR calls until
the configured hook arrives, then replays them through the matcher. The gate
fails open to native APIs after 250 ms if configuration does not arrive;
synchronous XHR always passes through immediately.

## Standalone extraction checklist

- Copy `network/` (and `lib/csp-disable.js` if CSP stripping stays).
- New manifest: `permissions` + `host_permissions` from the plugin exports, `devtools_page` → `ui/rules.html`, `background: { scripts: ["background.js"], type: "module" }`.
- Replace host settings merge with local GET/SET for `networkHooksEnabled` only.
- Drop sidebar Network toggle; use the DevTools panel header / enabled checkbox.
