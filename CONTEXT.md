# SN Links Extension — Context

## Purpose

**Primary:** A Firefox extension for **reverse-engineering and interacting with arbitrary websites**. It stores reusable JavaScript actions (bookmarklets), runs them in the page's MAIN world, and supports persistent on-load injection — useful for debugging DOM behavior, intercepting events, disabling redirects, tracing network calls, and similar site interaction work.

**Secondary:** A **ServiceNow productivity tool**. The original use case was a bookmarks folder: relative instance-independent paths and scriptlets that resolve against whichever pattern-matching tab is active (or the last visited instance). Support for matching all URL regex patterns in the json is required.

The repo still says "ServiceNow" in places (`manifest.json`, README); treat that as legacy naming. New work should reflect the broader scope and be renamed accordingly.

## Platform

- **Browser:** Firefox (Manifest V3 via `browser_specific_settings.gecko`)
- **Load:** Temporary add-on via `about:debugging` → Load Temporary Add-on → select `manifest.json`
- **Permissions:** `activeTab`, `scripting`, `storage`, `tabs`, `webNavigation`, `<all_urls>`

## Architecture

```
manifest.json
├── background.js            # Inject cache, omnibox, shortcuts, context menus, badges
├── lib/link-model.js        # Shared link tree, parameters, match patterns, normalization
├── lib/link-behaviors.js    # Behavior registry (run / open-url / open-from-script)
├── lib/link-search.js       # Fuzzy scoring (sidebar + omnibox)
├── lib/url-normalize.js     # Runtime URL canonicalization
├── lib/catalog-order.js     # Stable keys + display/export order override
├── lib/catalog-events.js    # CATALOG_CHANGED broadcast
├── lib/link-shortcuts.js    # Alt+1…0 slot map
├── lib/tab-target.js        # Tab matching / origin memory
├── lib/activate-link.js     # Shared leaf activation (sidebar / omnibox / shortcuts)
├── lib/scriptlet-inject.js  # Scriptlet binding injection helper
├── lib/navigation-shared.js # Shared URL resolution and open execution
├── inject/on-load.js        # Thin bootstrap for on-load scriptlets
├── inject/context-target.js # Last contextmenu target → CSS selector
├── sidebar/
│   ├── sidebar.html         # Firefox sidebar UI
│   ├── sidebar.js           # Bootstrap, settings, render, DnD
│   ├── link-ui.js           # Link rows, context menu, shortcuts
│   ├── search.js            # Explicit / / Ctrl+K search
│   └── …
├── builder/                 # Advanced link editor window
├── network/                 # Network-rules plugin (engine, UI, inject, host API)
│   ├── plugin.js            # ESM network-rules host API
│   ├── background.js        # Hook/webRequest orchestration
│   ├── ui/                  # DevTools rules editor
│   └── engine/              # Rule engine + page hook + webRequest
├── data/links.json          # Canonical bundled catalog
└── scripts/
```

### Module owners

| Concern | Owner |
|---|---|
| Catalog merge / import / export | `lib/link-catalog.js` |
| Display / export order | `lib/catalog-order.js` |
| URL canonicalization | `lib/url-normalize.js` |
| Leaf activation | `lib/activate-link.js` + `lib/link-behaviors.js` |
| Search scoring | `lib/link-search.js` |
| Shortcut slots | `lib/link-shortcuts.js` |
| Catalog change broadcast | `lib/catalog-events.js` |
| Sidebar UI | `sidebar/` |
| Builder dirty/import UX | `builder/builder.js` |

### Execution flow

1. User opens sidebar (toolbar or Ctrl+Period) → `sidebar.js` loads ordered merged catalog and renders section tabs.
2. **Omnibox `cl`** — page-focused search/run without focusing the sidebar.
3. **Alt+1…0** — run assigned link slots (right-click a link → Assign Alt+N).
4. **Run / Open / Derive** — via `lib/activate-link.js` + behaviors.
5. **On load / Network rules** — unchanged (see below).

### On-load + `match`

On-load reuses link `match` inheritance from `links.json` (same rules as tab targeting). Only **Run** actions (`code` without `open`) are eligible.

### Tab / origin targeting

| `match` | Behavior |
|---|---|
| Set (e.g. `\.service-now\.com$`) | Find or create a tab matching the pattern; remember origin per pattern in `lastOrigins` |
| Set with path (e.g. `chromewebstore\.google\.com/detail/`) | Same; pattern can match full tab URL |
| `null` / absent on node | Use the **active tab** (overrides section inheritance when set explicitly on a link) |

Reverse-engineering tools have no section-level `match` — they run on the active tab.

## Link data model (`data/links.json`) — schema v3

Top-level keys are **section names** (sidebar tabs):

```json
{
  "match": "\\.service-now\\.com$",
  "children": [ /* folders + leaves */ ]
}
```

`match` is optional and inherited by nested folders/leaves unless overridden.

### Leaf actions (no `type` field)

Discriminated by properties; [`lib/link-behaviors.js`](lib/link-behaviors.js) picks the first matching behavior:

| Behavior | Badge | Shape |
|---|---|---|
| `run` | Run | `code` only |
| `open-from-script` | Open | `code` + `open` (script returns URL) |
| `open-url` | Open / Web / Derive | `url` + `open`; optional `navParams` and/or `{…}` templates |

Popup badges: **Run**, **Open**, **Web** (absolute `url`), **Derive** (`navParams` or template tokens in `url`).

### Common fields

| Field | Purpose |
|---|---|
| `code` | Script body; `params` keys are lexical bindings at runtime |
| `url` | Relative path, absolute URL, or template |
| `open` | How to open a resolved URL (see below) |
| `params` | Script/function bindings only (see below) |
| `navParams` | URL/URI substitution values only (see below) |
| `match` | Host/URL regex; `null` = active tab |

Folders: `{ "name": "…", "children": [ … ] }`.

### Navigation (`open`)

Required on URL actions. On scriptlets, only when the script returns a URL (`code` + `open`).

| Value | Behavior |
|---|---|
| `same-tab` | Replace the target tab’s URL |
| `tab` | Open in a new focused tab |
| `background` | Open in a new background tab |
| `download` | Trigger `browser.downloads.download` |

Legacy aliases normalized on load: `foreground` → `tab`, `fetch` → `download`.

### params vs navParams

Mutual exclusion by behavior (see [ADR 0001](docs/adr/0001-params-vs-navparams.md)):

| | `params` | `navParams` |
|---|---|---|
| **Owns** | Script/function bindings | URL `{name}` / `{encode:name}` substitution |
| **Used on** | `code` actions (`run`, `open-from-script`) | `url` actions (`open-url`) |
| **Runtime** | `new Function(...names, code)(...values)` | Applied to `url` template after resolve |

A leaf should not declare both. Normalization moves URL-only legacy `params` into `navParams` and drops `navParams`/`extract` on pure script actions.

#### `params` fields

```json
"params": {
  "limit": {
    "placeholder": "limit",
    "default": "100",
    "optional": false,
    "choices": ["50", "100", "200"]
  }
}
```

| Key | Purpose |
|---|---|
| `placeholder` | Popup input hint (also implies the input is shown) |
| `default` | Used when the input is blank |
| `optional` | Allow running with an empty value |
| `choices` | Optional combobox suggestions |

Script code uses bare names (`limit`), not `{limit}` or `$limit`.

#### `navParams` fields

```json
"navParams": {
  "target": { "fromUrl": "^https?://[^/]+/(.+)$" },
  "id": {
    "fromUrl": "\\/detail\\/([a-p]{32})",
    "placeholder": "extension id",
    "optional": true
  },
  "sys_id": {
    "placeholder": "sys_id",
    "default": "67ee2538534501108135ddeeff7b121b"
  }
}
```

| Key | Purpose |
|---|---|
| `fromUrl` | Regex against the tab URL; capture group 1 is the value |
| `fromSelector` | CSS selector on the tab DOM (mutually exclusive with `fromUrl`) |
| `stringSource` | With `fromSelector`: `textContent` (default), `innerHTML`, `id`, or `attribute` |
| `attribute` | Required when `stringSource` is `attribute` |
| `placeholder` | **UI opt-in:** presence (including `""`) shows a popup input; never used as a value |
| `default` | Used after derivation if still empty |
| `optional` | Allow navigating with an empty value; otherwise missing required → no-op |
| `choices` / `label` | Same semantics as `params` when an input is shown |

**Resolve order** per key: non-empty manual input → `fromUrl` / `fromSelector` → `default`. Blank input means “no manual value” (fall through). At most one derivation source per key.

URL templates also support `{origin}` (target tab origin), independent of `navParams`.

### Schema migration

`LINKS_SCHEMA_VERSION` is **3**. Bumping clears `linkParamValues` and `injectOnLoad` once (`linksSchemaVersion` in storage). Overlay / catalog normalize on load:

| Legacy | Canonical |
|---|---|
| `extract` | `navParams` |
| `extract.*.url` | `navParams.*.fromUrl` |
| `extract.*.selector` | `navParams.*.fromSelector` |
| URL-only `params` (no `code`) | merged into `navParams` |
| `type` / `path` / `nav` / `hostPattern` / `parameter` | as in v2 |

One-off file rewrite: `node scripts/migrate-links-json.js`.

### Deferred: sandbox

Future `sandbox` on `code` actions: `"main"` (default), `"isolated"`, `"readonly-dom"`. Readonly-dom is best-effort (cloned document); not a security boundary. Not implemented.

### Bookmark sync contract (future)

Canonical export/import fields: `code`, `url`, `open`, `match`, `params`, `navParams`. Scriptlet bookmarklets should use the same binding model as the extension, not string substitution into `code`.

### Network rules (`network/`)

| Action | Behavior |
|---|---|
| `modify` | URL/body/header replacements + request/response scripts |
| `mock` | Return mock status/body without calling the network (fetch/XHR) |
| `block` | Abort matching requests |
| `redirect` | Replace request URL |

**Filters:** page URL, request URL, Content-Type, request body — `*` wildcards by default, optional per-field **regex** mode; HTTP methods; resource types; response status range. Legacy `w:` prefixes migrate to wildcard mode on load.

**Shared state:** request/response scripts receive `ctx.sharedState` (persisted in `networkSharedState`) and `ctx.tabState` (per-tab session). Mutations from page hooks sync back via `NETWORK_SHARED_STATE` messages.

**Mock:** use action `mock`, or `modify` + **Serve without request** with mock status/body fields.

**Rule visibility:** recent matches log to session storage (FIFO cap of 100); toolbar badge `●` on tabs where a rule fired; rules UI highlights the last matched rule. Log entries include `tabId` when known.

**Pattern compilation:** filter regexes compile once on rules refresh in the background and once per hook install in the page. Rule refresh is debounced (300ms).

**Scripts vs webRequest:** request/response scripts run in the page hook (fetch/XHR). webRequest applies declarative block/redirect/header/body actions only — Firefox MV3 CSP blocks `new Function()` in extension pages. A CSP-safe interpreter can be wired later in `network-webrequest.js`.

**Hook reentrancy:** fetch/XHR triggered from inside a rule script skips other rules unless they set **`matchHookOriginated: true`**. A rule never matches its own request while its script is running.

**Hook idempotency:** re-install restores native `fetch`/XHR from the first install before re-wrapping, so in-tab re-inject does not stack wrappers.

**Rule test:** DevTools rules editor **Test** opens a URL in a new tab and shows an in-page toast when that rule matches (8s timeout).

**DevTools status:** the Network Rules panel header dot reflects hooks disabled (grey), enabled (teal), or a recent match on the inspected tab (green). The toolbar badge `●` tooltip explains active hooks / recent match / inject-on-load.

**Auto re-inject:** saving rules or toggling hooks re-runs the page hook on open http(s) tabs (manual **Re-inject** still available).

### Untested intent: header forwarding on redirect (#10)

When a page-hook **redirect** changes an XHR/fetch URL, sensitive headers (e.g. `Authorization`) may not carry the way Requestly’s session DNR rules do. Header **modify** rules on fetch/XHR apply in the page hook; **webRequest** header rules apply to other resource types. Preserving auth across redirect rewritten URLs is **not implemented** — documented for future work in `network/ui/rules.html`.

When matching tabs in the current window: the **active tab** wins if it matches; otherwise the nearest tab to the active tab (searching outward in the tab strip). Among tabs sharing a remembered origin, the nearest to the active tab is preferred.

Values persist in `browser.storage.local` under `linkParamValues`, keyed by a stable **link key** derived from section + behavior + name + template.

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

Instance-scoped actions with `match: \.service-now\.com$`. Examples:

- Set list row limit (parameterized GlideList2 scriptlet)
- Show navigator (`url` + `navParams` + `open`)
- Upload XML, cancel transactions, app logs
- UIB / macroponent deep links (parameterized `sys_id`)
- External docs (community, developer portal)

Originally populated from the **SN links** Firefox bookmarks folder via `scripts/parse-bookmarks.js`.

## User-added actions

Sidebar **Add action** panel quick-adds scriptlets or URLs. **Advanced…** opens `builder/builder.html`. Page context menu **Create Complex Linker action** opens the builder with tab URL / clicked-element `fromSelector` prefill.

- Drag-and-drop in the sidebar reorders bundled and custom items; order is stored in `catalogOrder` and used for display and export
- Custom links stored in `linksJsonOverlay`; export follows catalog order
- Right-click → Assign Alt+1…0 for global shortcuts

## Storage keys (`browser.storage.local`)

| Key | Purpose |
|---|---|
| `lastOrigins` | Map of match pattern → last seen origin |
| `linkParamValues` | Saved parameter values per link key |
| `injectOnLoad` | Map of link key → true for on-load scriptlets |
| `injectOnLoadEnabled` | Master switch for on-load injection (default true) |
| `networkRules` | Network rules editor state (`enabled` + `rules[]`) |
| `networkHooksEnabled` | Master switch for network hooks + webRequest rules (default true) |
| `networkSharedState` | Persistent key/value for network rule scripts (`ctx.sharedState`) |
| `linksSchemaVersion` | Catalog schema version (v3 triggers one-time overlay migration + storage reset) |
| `linksJsonOverlay` | Custom section links in `links.json` format (merged at load) |
| `customScripts` | Legacy user scripts (migrated to `linksJsonOverlay`) |
| `activeSectionTab` | Last selected section tab |
| `addScriptExpanded` | Add-action panel collapsed state |
| `catalogOrder` | `{ linkKeys[], sectionOrder[] }` display/export order override |
| `linkShortcutSlots` | Map of `run_link_N` → stable link key |
| `lastActivatedLinkKey` | Last activated stable key |
| `preferredOpenDefault` | Preferred `open` default for new links |

### Session storage

| Key | Purpose |
|---|---|
| `networkRulesLog` | Recent network rule matches (cap 100) |
| `networkTabState` | Per-tab objects for `ctx.tabState` keyed by tab id |
| `linkBuilderPrefill` | Tab/context prefill for new builder links |
| `linkBuilderSection` | Default section for builder |

## Conventions for changes

- **New reverse-engineering tools:** add to `Reverse-engineering tools` in `data/links.json`; prefer scriptlets that log to `console` and are idempotent where possible (many check a `window.__…` guard).
- **New ServiceNow links:** edit `data/links.json` ServiceNow section.
- **Scriptlet execution:** always MAIN world — required to touch page globals (`window`, `GlideList2`, etc.).
- **On-load inject:** only for Run actions (`code` without `open`); respects per-link `match`; background re-registers and re-injects on open tabs when `injectOnLoad` or `injectOnLoadEnabled` changes.
- **Match patterns:** regex tested against tab `URL.hostname` and `URL.href` (case-insensitive). Hostname-only patterns (e.g. `\.service-now\.com$`) still work; include path segments to restrict to specific pages.
- **Schema v3 update:** clears saved parameter values and on-load preferences once; reload preferences after updating.
- Reload extension after changing `links.json` or background logic.

## Known limitations

- Firefox-only (uses `browser.*` APIs, gecko manifest settings).
- Temporary add-ons do not persist across browser restarts unless signed/packaged.
- `parse-bookmarks.js` reads `../../bookmarks.html` relative to the script — path assumes a sibling bookmarks export outside this repo.
- Duplicate activation/search logic belongs in `lib/activate-link.js` / `lib/link-search.js` — not sidebar-only copies.
- README describes an older, smaller link set; `data/links.json` is authoritative.

## Related tooling

- **ServiceNow CLI (`snc`):** for instance queries when debugging SN-specific scriptlets — not part of this extension.
- **Bookmarks source:** legacy import path; manual `links.json` edits are now the normal workflow for reverse-engineering tools.
