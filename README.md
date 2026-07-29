# ServiceNow Links (Firefox)

Firefox extension for quick links, bookmarklets, and page-interaction tools. Link definitions live in `data/links.json`; the popup renders them as section tabs with badges for each action type.

ServiceNow instance URLs are stored as paths and resolved against whichever `*.service-now.com` tab matches (active tab first, then nearest match in the window). Scriptlets run in the page MAIN world on the target tab.

## Install (temporary)

1. Open Firefox and go to `about:debugging`.
2. Click **This Firefox**.
3. Click **Load Temporary Add-on…**
4. Select `manifest.json` in this folder.

Temporary add-ons are removed when Firefox closes.

## Install (signed / persistent)

Package the folder as a `.zip` and submit to Mozilla Add-ons, or use Firefox Developer Edition with unsigned extensions enabled.

## Usage

1. Open a tab on the site the action targets (for ServiceNow sections, any `*.service-now.com` instance tab).
2. Click the extension toolbar button.
3. Choose an action (badge indicates type):
   - **Run** — scriptlet injected into the target tab
   - **Derive** — URL built from the tab (extract/template or path + origin)
   - **Open** — navigate to a declared relative path on the target tab
   - **Web** — absolute URL (`navigate` type only)

The popup shows the active tab origin. When a link has a `hostPattern`, the extension prefers the active tab if it matches, otherwise the nearest matching tab in the current window.

Reload the extension in `about:debugging` after editing `data/links.json`.

## Link catalog (`data/links.json`)

`data/links.json` is the canonical link catalog. Top-level keys are **section names** (popup tabs). Each section is an object with optional `hostPattern` and a `children` array (folders and leaf actions).

```json
{
  "ServiceNow": {
    "hostPattern": "\\.service-now\\.com$",
    "children": [ ]
  },
  "Reverse-engineering tools": {
    "children": [ ]
  }
}
```

### Folders

Nested menus use `{ "name": "…", "children": [ … ] }` with no `type`. Folders may override `hostPattern` for everything inside.

### `hostPattern`

Optional regex, inherited from the section or parent folder unless overridden on a folder or link. A link-level `hostPattern` always wins over its section or folder. Matched against the tab hostname and full href (case-insensitive).

| Value | Tab selection |
|---|---|
| Set (e.g. `\\.service-now\\.com$`) | Active tab if it matches; else nearest matching tab; else create/remember instance from `lastOrigins` |
| `"hostPattern": null` on a link | Overrides section inheritance — use the active tab only (for docs on non-instance hosts) |
| Absent on section | Active tab in the current window |

### Leaf types

| `type` | Badge | Purpose |
|---|---|---|
| `scriptlet` | Run | JavaScript run in the page MAIN world |
| `derived-url` | Derive | URL derived from tab context; requires `nav` |
| `navigate` | Open / Web | Explicit `path` (relative or absolute); optional `nav` |

#### `scriptlet`

```json
{
  "name": "Set list item limit",
  "type": "scriptlet",
  "code": "glideListClassRef.setRowsPerPage({limit});",
  "parameter": {
    "name": "limit",
    "placeholder": "limit",
    "default": "100"
  }
}
```

- **`code`** — injected into the target tab.
- **`nav`** (optional) — if set, `code` is evaluated in the background against a synthetic `location` object and must return a URL string; the extension performs navigation instead of injecting into the page.
- **On load** — non-navigation scriptlets can be enabled in the popup to inject at `document_start` on matching pages.

#### `derived-url`

Builds a URL from the target tab. **`nav` is required.**

Two forms:

**Path + origin** (typical for instance-independent ServiceNow links — opens on whichever instance tab matches):

```json
{
  "name": "Cancel transactions",
  "type": "derived-url",
  "nav": "foreground",
  "path": "/cancel_my_transaction.do"
}
```

Relative `path` values inherit the section `hostPattern`, resolve the tab origin, and wrap in the ServiceNow classic navigator URL when applicable.

**Extract + URL template** (values parsed from the current tab URL and/or page DOM):

`extract` is an object whose keys are parameter names. Each value is either a **URL regex** spec or a **DOM selector** spec:

| Spec | Shape | Source |
|---|---|---|
| URL regex | `{ "url": "<regex>" }` | Capture group 1 from the tab URL |
| DOM selector | `{ "selector": "<css>", "stringSource": "<source>" }` | First matching element in the page |

`stringSource` for DOM specs: `textContent` (default), `innerHTML`, `id`, or `attribute` (requires `"attribute": "<name>"`).

Single parameter from the tab URL:

```json
{
  "name": "Show navigator",
  "type": "derived-url",
  "nav": "same-tab",
  "extract": {
    "target": {
      "url": "^https?://[^/]+/(?!now\\/nav\\/ui\\/classic\\/params\\/target\\/)(.+)$"
    }
  },
  "url": "{origin}/now/nav/ui/classic/params/target/{encode:target}",
  "parameter": {
    "name": "target",
    "optional": true
  }
}
```

Multiple parameters (URL + DOM):

```json
{
  "type": "derived-url",
  "nav": "foreground",
  "extract": {
    "sys_id": {
      "url": "\\/([a-f0-9]{32})"
    },
    "table": {
      "selector": "input[name=\"sysparm_table\"]",
      "stringSource": "attribute",
      "attribute": "value"
    }
  },
  "url": "{origin}/incident.do?sys_id={sys_id}&sysparm_table={table}",
  "parameters": {
    "sys_id": { "optional": true },
    "table": { "optional": true }
  }
}
```

Parameter names in `extract` appear as popup inputs when not declared under `parameter` / `parameters`. User-provided values override extraction.

Template placeholders:

| Placeholder | Meaning |
|---|---|
| `{origin}` | Origin of the matched target tab |
| `{paramName}` | Parameter value (see below) |
| `{encode:paramName}` | `encodeURIComponent` of the parameter value |

When `extract` is set, capture group 1 (URL regex) or the DOM value fills the named parameter if the user did not provide a value. If all extract attempts fail and every failed parameter is `optional: true`, the action is a no-op (e.g. already on a navigator URL). Required parameters that fail extraction throw an error.

Absolute paths with `"hostPattern": null` open fixed external URLs:

```json
{
  "name": "Now Component Library | ServiceNow Developers",
  "type": "derived-url",
  "nav": "foreground",
  "hostPattern": null,
  "path": "https://developer.servicenow.com/dev.do#!/reference/..."
}
```

#### `navigate`

Explicit navigation without deriving from tab URL structure (except resolving relative paths against origin):

```json
{
  "name": "Example same-tab",
  "type": "navigate",
  "path": "/some_page.do"
}
```

Absolute `path` → badge **Web**, default `nav: foreground`. Relative `path` with `hostPattern` → default `nav: same-tab`.

### Navigation (`nav`)

| `nav` | Behavior |
|---|---|
| `same-tab` | Update the target tab |
| `foreground` | New focused tab |
| `background` | New background tab |
| `fetch` | `downloads.download` (e.g. CRX fetch) |

Defaults when omitted: `same-tab` for relative `navigate` paths, `foreground` for absolute `navigate` paths. Required on all `derived-url` links.

### Parameters

Declare placeholders with `parameter` (single) or `parameters` (multiple). Substitution applies to `path`, `url`, and scriptlet `code`.

```json
"parameter": { "name": "sys_id", "placeholder": "sys_id", "default": "abc123" }
```

```json
"parameters": {
  "sys_id": { "default": "abc123", "choices": ["abc123", "def456"] }
}
```

- **`{name}`** — replaced in paths, URLs, and scriptlet code.
- **`$name`** — replaced in scriptlet code only (regex-aware).
- **`optional: true`** — allow empty value (often combined with `extract` on `derived-url`).

Values persist in `browser.storage.local` under `linkParamValues`.

### Sections in the current catalog

| Section | `hostPattern` | Contents |
|---|---|---|
| ServiceNow | `\.service-now\.com$` | Instance links, scriptlets, community/developer docs (`hostPattern: null`) |
| Reverse-engineering tools | (none) | General DOM/event/network debugging scriptlets |
| Misc | per-link | e.g. Chrome Web Store CRX download (`derived-url` + `fetch`) |

See `data/links.json` for the full list. `CONTEXT.md` has additional architecture detail.

## Updating links from bookmarks

Legacy import from the **SN links** bookmarks folder only:

```bash
node scripts/parse-bookmarks.js
```

Requires `bookmarks.html` at the path expected by the script (see `CONTEXT.md`). Prefer editing `data/links.json` directly for reverse-engineering tools and new links.

Then reload the extension in `about:debugging`.
