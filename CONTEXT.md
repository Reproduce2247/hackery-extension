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

Sidebar link rows show a **green apply-dot** (tooltip: “Applies to this tab”) when the active tab URL matches the link’s resolved `match` (or when the link has no `match` and therefore always targets the active tab). Dots update on tab switch / URL change without a full catalog re-render.

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
| `open-from-script` | Open | `code` + `open` (script returns URL, evaluated in the page) |
| `open-url` | Open / Web / Derive | `url` + `open`; optional `navParams` and/or `{…}` templates |

Popup badges: **Run**, **Open**, **Web** (absolute `url`), **Derive** (`navParams` or template tokens in `url`). Each badge has a descriptive hover tooltip (e.g. Run → “Runs a scriptlet on the page”).

### Common fields

| Field | Purpose |
|---|---|
| `id` | Stable leaf identity (UUID). Bundled leaves all have one; custom leaves get one on create. Order/shortcuts/storage prefer `id`, fall back to `name`-based keys for legacy nodes without one. |
| `name` | Display label (also used in path/order fallbacks when `id` is absent) |
| `code` | Script body; `params` keys are lexical bindings at runtime |
| `url` | Relative path, absolute URL, or template |
| `open` | How to open a resolved URL (see below) |
| `tooltip` | Optional hover text on the link label in the sidebar |
| `params` | Script/function bindings only (see below) |
| `navParams` | URL/URI substitution values only (see below) |
| `match` | Host/URL regex; `null` = active tab |
| `frames` | Optional scriptlet injection targets: `top`, `nestingLevel`, `match` (see below) |

Folders: `{ "name": "…", "children": [ … ] }` (no `id`).

### Frame targeting (`frames`)

Optional on `code` actions (`run`, `open-from-script`). Absent `frames` keeps today’s defaults: manual activation injects the **top** document only; on-load injects into **each reporting frame**.

```json
"frames": {
  "top": true,
  "nestingLevel": 1,
  "match": ["incident\\.do"]
}
```

| Key | Meaning |
|---|---|
| `top` | Include the tab’s outermost document (depth 0) |
| `nestingLevel` | Max iframe nesting depth. Omit / `0` = no descendants. `N` = every descendant with depth `1..N`. `-1` = unlimited descendant depth. Does **not** include top. |
| `match` | Regex strings (`i`) against each frame’s **document URL** (not iframe `name`/`id`). With no `match`, every frame in the `nestingLevel` band is included. When set, URL match **ANDs** with that band. If `nestingLevel` is omit/`0`, `match` applies at any descendant depth. |

Depth is hops from the top document via `parentFrameId`. `match` does not apply to top; `top: true` always includes frame 0.

Empty `{ }` is treated as top-only. Unknown keys are rejected. Integer `nestingLevel` only (no boolean aliases).

| Intent | Config |
|---|---|
| Top + first-level iframes | `{ "top": true, "nestingLevel": 1 }` |
| First-level iframes only | `{ "nestingLevel": 1 }` |
| Entire tree | `{ "top": true, "nestingLevel": -1 }` |
| Form iframe at any depth | `{ "match": ["incident\\.do"] }` |
| First-level form iframe | `{ "nestingLevel": 1, "match": ["incident\\.do"] }` |

Do not add `{ "top": true }` alone as a stand-in for “default”: present `frames` changes on-load to the resolved set (top only), instead of every reporting frame.

After a run, a `console.table` of `{ frameId, depth, url, ok, error }` is injected into the top document. Mixed results throw `failed in some frames`; zero successes throw `failed in all frames`. Copy writes successful `open-from-script` URLs, then surfaces the partial-failure message. `open-from-script` with `tab` / `background` / `download` navigates each successful URL; `same-tab` uses the first successful URL only.

On-load: if `frames` is set, the reporting frame is injected only when it is in that target set. Bundled reverse-engineering tools that set `frames`: blur (`nestingLevel: 1`); unmask passwords, disable form validation, background overlay, restore context menu, disable clipboard tampering (`nestingLevel: -1`); all with `top: true`.

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

Future `sandbox` on `code` actions: `"main"` (default), `"isolated"`, `"readonly-dom"`. Not implemented.

| Value | Intent |
|---|---|
| `main` | Current behavior — MAIN-world `executeScript` against the live page |
| `isolated` | Extension isolated world (no page globals); still the live DOM if the world can see it |
| `readonly-dom` | Run against a **cloned DOM in its own document scope**, not the live tab |

#### `readonly-dom` design (planned)

**Mechanism:** snapshot page markup into a dedicated iframe document with its own browsing context and JS realm. Preferred shape:

1. Serialize a best-effort DOM snapshot (`documentElement.outerHTML` and/or tree walk; open shadow roots included when reachable; closed shadows / cross-origin iframes omitted).
2. Create an iframe under a host the extension controls for teardown (extension page preferred; page-inserted frame only if needed for packaging).
3. Load the snapshot via `srcdoc` (or equivalent) into that iframe.
4. Evaluate the scriptlet only inside that frame’s `contentWindow` — never rebind the live tab’s `document`.

**Own scope / origin:** give the frame an **opaque origin** so it is neither the page origin nor a privileged extension principal for same-origin access:

- `sandbox` attribute **without** `allow-same-origin` (scripts allowed via `allow-scripts` only as needed to run the scriptlet).
- Result: unique opaque (`null`) origin — separate security principal from the tab and from `moz-extension://` same-origin privileges.

This is still not a hard security boundary against a hostile scriptlet if the host document mishandles results; treat it as **best-effort isolation** for “don’t mutate the live page,” not as a threat model for untrusted code with extension APIs.

**Lift CSP inside the clone (not the live page):**

- Strip CSP **from the snapshot only** before load: remove `<meta http-equiv="Content-Security-Policy">` (and report-only variants) from serialized HTML; do not rely on the live tab’s Disable CSP toggle for this path.
- Prefer loading via `srcdoc` / controlled document so the clone does not inherit the page’s HTTP CSP headers.
- Optionally set a permissive policy on the clone document only if a default opaque-frame policy still blocks `new Function` / inline evaluation — scoped to the iframe, never written back to the tab.
- Live-page CSP disable (`csp-disable.js` header/meta strip) remains a separate feature for MAIN-world / page-policy cases.

**Prevent interaction with the main page:**

| Guard | Purpose |
|---|---|
| Omit `allow-same-origin` | Opaque origin — no `parent.document` / page DOM access |
| Omit `allow-top-navigation` / `allow-top-navigation-by-user-activation` | No replacing the tab URL |
| Omit `allow-popups` / `allow-popups-to-escape-sandbox` (unless explicitly required later) | No window.open side channels |
| Omit `allow-forms` if navigation-via-form is a concern | No form submit to the parent’s network context |
| Do not pass live `window` / node references into the frame | Avoid bridging the realm via arguments |
| Return values via structured-cloneable postMessage (or inject-and-read once) | Results cross the boundary as data only |
| Tear down the iframe after the run | No lingering frame with a copy of page HTML |
| No `parent` / `top` helpers injected into the scriptlet bindings | Scriptlet sees clone `document` / `window` only |

Scriptlets under `readonly-dom` **cannot** use live page globals (`GlideList2`, Angular injectors, etc.). Those actions stay on `sandbox: "main"` (default).

**Known fidelity limits:** closed shadow DOM, cross-origin iframe trees, framework instance state, and any object graph beyond markup are out of scope — HTML/DOM snapshot only.

### Planned: userscripts + user CSS UI

Add a dedicated management surface (sidebar section and/or builder mode) for **persistent userscripts and user stylesheets**, closer to Greasemonkey / Stylus than one-shot catalog actions.

**Intent**

| Kind | Behavior |
|---|---|
| Userscript | Stored JS with `@match`-style host patterns, enable/disable, optional on-load inject (`document_start` / `document_end` / `document_idle`) |
| User CSS | Stored CSS injected into matching pages (same match model); no page JS |

**UI sketch**

- List installed scripts/styles with enable toggle, match summary, edit, delete (soft-delete/undo welcome)
- Editor (CodeMirror already in-tree) for source + metadata: name, match patterns, run-at, notes
- Install/import paths: paste source, import file, optional “save current Run action as userscript”
- Clear separation from the action catalog: userscripts/CSS are always-on page customizations; catalog links remain explicit activate / optional on-load tools

**Out of scope for v1 of this feature:** `@grant`-style capability menus (only relevant once sandboxed / untrusted install is a goal), `@require` / `@resource`, remote auto-update.

**Relation to today:** on-load Run actions already cover “inject this JS on matching tabs.” Userscripts/CSS would generalize that into a first-class library with stylesheets and a management UI, without requiring each item to be a catalog leaf.

### Idea: page-context clipboard (Greasemonkey `GM_setClipboard`)

Sidebar copy today uses the extension page clipboard APIs (`sidebar/copy-link.js`). That is enough for Copy from the sidebar.

If a **scriptlet running in the page** later needs to write the clipboard (e.g. “copy derived URL from inside the page”), prefer Greasemonkey’s page-context approach: dispatch a synthetic `copy` event / use `document.execCommand('copy')` in MAIN world, rather than assuming `navigator.clipboard` or extension `clipboardWrite` reach the injected realm. Only implement when a concrete action needs in-page copy; do not bridge clipboard through background by default.

### Bookmark sync contract (future)

Canonical export/import fields: `code`, `url`, `open`, `match`, `params`, `navParams`, `frames`. Scriptlet bookmarklets should use the same binding model as the extension, not string substitution into `code`.

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

**Event-page listener registration:** `webRequest` listeners register at module load in `network-webrequest.js`, and `initCspDisable()` runs at the top level of `background.js`. Firefox only wakes an event page for listeners added during the background script's first synchronous run, so anything registered after an `await` stops firing once the background suspends.

**Disable CSP (`lib/csp-disable.js`):** per-tab toggle in the sidebar, split across two mechanisms. DNR **session rules** (`tabIds` condition, `modifyHeaders`/`remove`) strip CSP and cross-origin isolation response headers — browser-held, so they apply while the event page is suspended. The **webRequest body filter** removes `<meta http-equiv="content-security-policy">`, which DNR cannot reach; a meta policy takes effect as the parser reads it and cannot be lifted later. The webRequest path also strips headers, so a network header rule cannot hand back a policy the DNR rule already removed. Requires a **hard reload** (`Ctrl+Shift+R`): a cached document can be replayed with its original policy without the headers passing through us.

Scope and lifetime: applies to the tab plus any tab opened from it (`tabs.onCreated` + `openerTabId`), so `open: "tab"` actions do not land on a protected tab. Expires after the fixed `CSP_DISABLE_MINUTES` duration; activity does not renew it. Timers use `alarms`, not `setTimeout`, which dies with the event page. Any change the sidebar did not initiate broadcasts `CSP_DISABLED_CHANGED` so the checkbox does not go stale.

`filterResponseData` must be called synchronously from the webRequest listener — a request id is only accepted while that request's listener is on the stack — so the body filter attaches before the disabled-tab set is known and decides in `onstop`, where async work is fine because the filter stays open until `close()`.

**Hook idempotency:** re-install restores native `fetch`/XHR from the first install before re-wrapping, so in-tab re-inject does not stack wrappers.

**Rule test:** DevTools rules editor **Test** opens a URL in a new tab and shows an in-page toast when that rule matches (8s timeout).

**DevTools status:** the Network Rules panel header dot reflects hooks disabled (grey), enabled (teal), or a recent match on the inspected tab (green). The toolbar badge `●` tooltip explains active hooks / recent match / inject-on-load.

**Auto re-inject:** saving rules or toggling hooks re-runs the page hook on open http(s) tabs (manual **Re-inject** still available).

### Untested intent: header forwarding on redirect (#10)

When a page-hook **redirect** changes an XHR/fetch URL, sensitive headers (e.g. `Authorization`) may not carry the way Requestly’s session DNR rules do. Header **modify** rules on fetch/XHR apply in the page hook; **webRequest** header rules apply to other resource types. Preserving auth across redirect rewritten URLs is **not implemented** — documented for future work in `network/ui/rules.html`.

**Privileged request headers (Cookie / Origin / Referer / User-Agent):** page JS cannot set these on fetch/XHR. The page hook encodes them as `x-complexlinker-{name}`; `network-webrequest.js` always rewrites those dummies to the real header names in `onBeforeSendHeaders` (even when rule matching defers to the page hook). Add more names to `PRIVILEGED_REQUEST_HEADER_NAMES` in `network-rule-engine-core.js` if needed. The **User-Agent Switcher** network rule template relies on this path for fetch/XHR; navigations and other resource types get `setHeaders` from webRequest directly.

When matching tabs in the current window: the **active tab** wins if it matches; otherwise the nearest tab to the active tab (searching outward in the tab strip). Among tabs sharing a remembered origin, the nearest to the active tab is preferred.

Values persist in `browser.storage.local` under `linkParamValues`, keyed by a stable **link key**: `id` when present, otherwise section + behavior + name + template.

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
- Edit / Remove are offered only for links **stored in the overlay** (`collectOverlayCustomLinkIds()`), not merely because a leaf has an `id` — bundled `data/links.json` leaves all carry ids, and neither edit nor delete can reach those. Removing a bundled link means editing `data/links.json`.
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
| `cspDisabledTabs` | Tab ids with the sidebar "Disable CSP" toggle on |

## Conventions for changes

- **New reverse-engineering tools:** add to `Reverse-engineering tools` in `data/links.json`; prefer scriptlets that log to `console` and are idempotent where possible (many check a `window.__…` guard).
- **New ServiceNow links:** edit `data/links.json` ServiceNow section.
- **Scriptlet execution:** always MAIN world — required to touch page globals (`window`, `GlideList2`, etc.). This includes `open-from-script` navigation scripts: activation and copy-link both inject them, and no code path evaluates them in an extension realm (extension pages have no `unsafe-eval` under MV3, and the page globals would be missing anyway). Row hints therefore never show a resolved URL for them. Optional `frames` selects top and/or nested documents; see Frame targeting.
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
