# SN Links Extension — Context

## Purpose

**Primary:** A Firefox extension for **reverse-engineering and interacting with arbitrary websites**. It stores reusable JavaScript actions (bookmarklets), runs them in the page's MAIN world, and supports persistent on-load injection — useful for debugging DOM behavior, intercepting events, disabling redirects, tracing network calls, and similar site interaction work.

**Secondary:** A **ServiceNow productivity tool**. The original use case was the a bookmarks folder: relative instance-independent paths and scriptlets that resolve against whichever `*.service-now.com` tab is active (or the last visited instance). ServiceNow-specific helpers (navigator URLs, app logs, upload XML, etc.) live in the `ServiceNow` section of link data. Support for matching other URL patterns in the json is required.

The UI still says "ServiceNow Links" in places (`manifest.json`, README); treat that as legacy naming. New work should reflect the broader reverse-engineering scope unless explicitly ServiceNow-only.

## Platform

- **Browser:** Firefox (Manifest V3 via `browser_specific_settings.gecko`)
- **Load:** Temporary add-on via `about:debugging` → Load Temporary Add-on → select `manifest.json`
- **Permissions:** `activeTab`, `scripting`, `storage`, `tabs`, `webNavigation`, `<all_urls>`

## Architecture

```
manifest.json
├── background.js          # Content-script registration, scriptlet execution, inject cache
├── lib/link-model.js        # Shared link tree, parameters, host patterns, scriptlet normalization
├── lib/navigation-shared.js # Shared URL resolution and nav execution
├── lib/network-rules-shared.js # Rule model, matching, shared state helpers
├── lib/network-hook-install.js # MAIN-world fetch/XHR hook (injected)
├── lib/network-webrequest.js   # webRequest blocking/filter for non-hook traffic
├── inject/on-load.js      # Thin bootstrap: asks background to run enabled on-load scriptlets
├── rules/                 # Network rules editor (rules.html, rules.js)
├── popup/
│   ├── popup.html         # Toolbar popup UI
│   ├── popup.js           # Bootstrap, settings, render orchestration
│   ├── link-ui.js         # Link row rendering, params, on-load checkboxes
│   ├── activate-link.js   # Run / navigate / derive activation
│   ├── tab-target.js      # Tab matching and origin memory
│   ├── search.js          # Fuzzy search overlay and section switching
│   └── popup.css
├── data/links.json        # Canonical link catalog (sections → tree of actions)
└── scripts/
    ├── parse-bookmarks.js # One-way import from bookmarks.html → links.json (ServiceNow folder only)
    └── generate-icons.js  # Icon asset generation
```

### Execution flow

1. User opens popup → `popup.js` loads `data/links.json` and renders section tabs.
2. **Run (scriptlet):** popup sends `RUN_SCRIPTLET` to background → `browser.scripting.executeScript` in **MAIN** world (`runInjectedSource` via `new Function`).
3. **Navigate (`navigate`):** explicit `path`; resolved via `hostPattern` and `nav`.
4. **Derive (`derived-url`):** `path` and/or `extract`+`url` — origin from matching tab; opened per `nav`.
5. **On load:** user enables checkbox → background registers `inject/on-load.js` at `document_start` on all http(s) pages → inject script messages background with page URL → enabled scriptlets whose **hostPattern** matches the tab URL run in MAIN world (`hostPattern` null/absent = every page). Navigation scriptlets are excluded. Master toggle **On load** in popup disables all on-load injection.
6. **Network rules:** `rules/rules.html` edits `networkRules` in storage → fetch/XHR hooks + `webRequest` apply block/redirect/modify/mock. Rules re-inject on open tabs when saved. Master toggle **Network** in popup disables hooks and webRequest rule handling.

### On-load + `hostPattern`

On-load is **not** a separate rule engine — it reuses link `hostPattern` inheritance from `links.json`:

| Scriptlet `hostPattern` | On-load runs when… |
|---|---|
| Inherited from section (e.g. `\.service-now\.com$`) | Tab URL hostname or href matches the regex |
| Set on the link node | Same; overrides section default |
| `null` / absent (e.g. Reverse-engineering tools, custom scripts) | Every http(s) page |

The bootstrap content script is registered on all http(s) URLs; `background.js` filters which scriptlets run per navigation via `codesForUrl()`.

### Network rules (`rules/`)

| Action | Behavior |
|---|---|
| `modify` | URL/body/header replacements + request/response scripts |
| `mock` | Return mock status/body without calling the network (fetch/XHR) |
| `block` | Abort matching requests |
| `redirect` | Replace request URL |

**Filters:** regex on request host, page host, page URL, request URL, Content-Type, request body; optional `w:` wildcard prefix (e.g. `w:*/api/now/table/*`); HTTP methods; resource types; response status range.

**Shared state:** request/response scripts receive `ctx.sharedState` (persisted in `networkSharedState`) and `ctx.tabState` (per-tab session). Mutations from page hooks sync back via `NETWORK_SHARED_STATE` messages.

**Mock:** use action `mock`, or `modify` + **Serve without request** with mock status/body fields.

**Rule visibility:** recent matches log to session storage; toolbar badge `●` on tabs where a rule fired; rules UI highlights the last matched rule.

**Auto re-inject:** saving rules or toggling hooks re-runs the page hook on open http(s) tabs (manual **Re-inject** still available).

### Untested intent: header forwarding on redirect (#10)

When a page-hook **redirect** changes an XHR/fetch URL, sensitive headers (e.g. `Authorization`) may not carry the way Requestly’s session DNR rules do. Header **modify** rules on fetch/XHR apply in the page hook; **webRequest** header rules apply to other resource types. Preserving auth across redirect rewritten URLs is **not implemented** — documented for future work in `rules/rules.html`.

### Tab / origin targeting

| `hostPattern` | Behavior |
|---|---|
| Set (e.g. `\.service-now\.com$`) | Find or create a tab matching the pattern; remember origin per pattern in `lastOrigins` |
| Set with path (e.g. `chromewebstore\.google\.com/detail/`) | Same, but pattern can match the full tab URL (hostname-only patterns still work) |
| `null` / absent on node | Use the **active tab** in the current window (overrides section inheritance when set explicitly on a link) |

When matching tabs in the current window: the **active tab** wins if it matches; otherwise the nearest tab to the active tab (searching outward in the tab strip). Among tabs sharing a remembered origin, the nearest to the active tab is preferred.

Reverse-engineering tools have no section-level `hostPattern` — they always run on whatever tab is active.

## Link data model (`data/links.json`)

Top-level keys are **section names** (shown as popup tabs). Each section:

```json
{
  "hostPattern": "\\.service-now\\.com$",
  "children": [ /* tree nodes */ ]
}
```

`hostPattern` is optional and inherited by nested folders/links unless overridden.

### Node types (leaves)

| `type` | Badge | Fields | Runs on |
|---|---|---|---|
| `scriptlet` | Run | `code`; optional `nav` + returning `code` | Target tab, MAIN world (or background eval when `nav` set) |
| `navigate` | Open / Web | `path` (relative or absolute); optional `hostPattern`; optional `nav` | Declared path resolved per `hostPattern` |
| `derived-url` | Derive | `path` and/or `extract`+`url`; required `nav` | Origin from matching tab; `path` for instance-independent SN links |

Use **`derived-url`** with `path` + section `hostPattern` for instance-relative links that should open in a new tab (default pattern for ServiceNow catalog entries). Use **`navigate`** for same-tab or explicitly declared paths. Set `"hostPattern": null` on links that must not bind to the section instance (e.g. community/developer docs on non-instance hosts).

Folders use `{ "name": "…", "children": [ … ] }` with no `type`.

### Navigation (`nav`)

Optional on `navigate` (defaults: `same-tab` for relative paths, `foreground` for absolute URLs). **Required** on `derived-url`. Optional on `scriptlet` when `code` returns a URL evaluated in the background against tab `location`.

| `nav` | Behavior |
|---|---|
| `same-tab` | `browser.tabs.update` on target tab |
| `foreground` | New tab, focused |
| `background` | New tab, unfocused |
| `fetch` | `browser.downloads.download` (direct request / file download) |

### Parameters

Placeholders in paths, URLs, and scriptlet code (`{name}`, `$name`) are substituted only when declared via `parameter` or `parameters` on the same node — not inferred from template text.

```json
"parameter": { "name": "limit", "placeholder": "…", "default": "100" }
```

Or multiple:

```json
"parameters": { "sys_id": { "default": "…", "choices": ["a", "b"] } }
```

Set `"optional": true` to allow running without a value (e.g. filled from the tab URL instead). For `derived-url`, when extract finds no match and the param is optional, the action is a no-op (e.g. already on a navigator URL).

`derived-url` templates support `{paramName}` placeholders and `{encode:paramName}` for `encodeURIComponent`. `{origin}` is filled from the target tab origin.

Scriptlets may set `"nav"` so `code` returns a URL string when given a `location` object (evaluated in the background from the tab URL). Relative returns are resolved against the target origin; ServiceNow sections still apply navigator wrapping when `hostPattern` is set.

Values persist in `browser.storage.local` under `linkParamValues`, keyed by a stable **link key** derived from section + type + name + template.

## Sections (current)

### Reverse-engineering tools

General-purpose page interaction scriptlets — no host restriction. Examples:

- Compare `window` to a clean iframe (non-default attributes)
- Remove blur / `overflow: hidden`
- Intercept or hook events (`addEventListener`, `postMessage`, capture-phase click)
- Disable redirects, beforeunload, auto-refresh throttling
- Enable disabled form controls
- Trace button clicks (fetch/XHR logging)
- Performance watcher (`window.__perfWatch`)

These are the **primary** reason the extension exists; extend this section when adding new debugging/interaction tools.

### ServiceNow

Instance-scoped actions with `hostPattern: \.service-now\.com$`. Examples:

- Set list row limit (parameterized GlideList2 scriptlet)
- Show navigator (`derived-url`: extract current path, wrap in classic navigator URL)
- Upload XML, cancel transactions, app logs
- UIB / macroponent deep links (parameterized `sys_id`)
- External docs (community, developer portal)

Originally populated from the **SN links** Firefox bookmarks folder via `scripts/parse-bookmarks.js`.

## User-added actions

Popup **Add action** panel stores scripts in `customScripts` (local storage):

- Paste raw JS or a `javascript:` bookmarklet (normalized by `normalizeScriptInput`)
- Optional name; defaults from navigation path or "Custom script N"
- Same Run / On load / parameter behavior as built-in scriptlets
- Removable from the Custom scripts folder in the popup

## Storage keys (`browser.storage.local`)

| Key | Purpose |
|---|---|
| `lastOrigins` | Map of `hostPattern` → last seen origin |
| `linkParamValues` | Saved parameter values per link key |
| `injectOnLoad` | Map of link key → true for on-load scriptlets |
| `injectOnLoadEnabled` | Master switch for on-load injection (default true) |
| `networkRules` | Network rules editor state (`enabled` + `rules[]`) |
| `networkHooksEnabled` | Master switch for network hooks + webRequest rules (default true) |
| `networkSharedState` | Persistent key/value for network rule scripts (`ctx.sharedState`) |
| `customScripts` | User-added scriptlet array |
| `activeSectionTab` | Last selected section tab |
| `addScriptExpanded` | Add-action panel collapsed state |
| `popupSize` | Persisted popup dimensions |

### Session storage

| Key | Purpose |
|---|---|
| `networkRulesLog` | Recent network rule matches (cap 100) |
| `networkTabState` | Per-tab objects for `ctx.tabState` keyed by tab id |

## Conventions for changes

- **New reverse-engineering tools:** add to `Reverse-engineering tools` in `data/links.json`; prefer scriptlets that log to `console` and are idempotent where possible (many check a `window.__…` guard).
- **New ServiceNow links:** edit `links.json` directly, or update `bookmarks.html` and run `node scripts/parse-bookmarks.js` (only imports the SN links folder into the ServiceNow section).
- **Scriptlet execution:** always MAIN world — required to touch page globals (`window`, `GlideList2`, etc.).
- **On-load inject:** only for non-navigation scriptlets; respects per-link `hostPattern`; background re-registers and re-injects on open tabs when `injectOnLoad` or `injectOnLoadEnabled` changes.
- **Host patterns:** regex tested against tab `URL.hostname` and `URL.href` (case-insensitive). Hostname-only patterns (e.g. `\.service-now\.com$`) still work; include path segments to restrict to specific pages.
- Reload extension after changing `links.json` or background logic.

## Known limitations

- Firefox-only (uses `browser.*` APIs, gecko manifest settings).
- Temporary add-ons do not persist across browser restarts unless signed/packaged.
- `parse-bookmarks.js` reads `../../bookmarks.html` relative to the script — path assumes a sibling bookmarks export outside this repo.
- Duplicate logic between `background.js` and `popup.js` for link/parameter handling lives in `lib/link-model.js` — update that module when changing behavior.
- README describes an older, smaller link set; `data/links.json` is authoritative.

## Related tooling

- **ServiceNow CLI (`snc`):** for instance queries when debugging SN-specific scriptlets — not part of this extension.
- **Bookmarks source:** legacy import path; manual `links.json` edits are now the normal workflow for reverse-engineering tools.
