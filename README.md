# ServiceNow Links (Firefox extension)

Firefox extension for reusable page actions: run JavaScript in the page MAIN world, open derived or declared URLs, and optionally inject scriptlets at document start. Includes a large **ServiceNow** section and a **Reverse-engineering tools** section for general site debugging.

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
   - **Run** — script injected into the target tab
   - **Derive** — URL built from the tab (`navParams` / template)
   - **Open** — relative path on the target tab
   - **Web** — absolute URL

The popup shows the active tab origin. When a link has a `match` pattern, the extension prefers the active tab if it matches, otherwise the nearest matching tab in the current window.

Reload the extension in `about:debugging` after editing `data/links.json`.

**Schema v3 note:** updating to the `params` / `navParams` split clears saved parameter values and on-load preferences once. Re-enable on-load checkboxes and re-enter saved values after reload.

## Link catalog (`data/links.json`)

Top-level keys are **section names** (popup tabs). Each section has optional `match` and a `children` array (folders and leaf actions). Leaves have **no `type` field** — behavior is inferred from properties.

```json
{
  "ServiceNow": {
    "match": "\\.service-now\\.com$",
    "children": [ ]
  },
  "Reverse-engineering tools": {
    "children": [ ]
  }
}
```

### Folders

`{ "name": "…", "children": [ … ] }` — may override `match` for descendants.

### `match`

Optional regex inherited from section or parent unless overridden. Matched against tab hostname and full href (case-insensitive).

| Value | Tab selection |
|---|---|
| Set (e.g. `\\.service-now\\.com$`) | Active tab if it matches; else nearest match; else remembered origin |
| `"match": null` on a link | Active tab only (overrides section inheritance) |
| Absent on section | Active tab in the current window |

### Leaf actions

| Shape | Badge | Fields |
|---|---|---|
| `code` only | Run | Script runs in MAIN world; optional on-load |
| `code` + `open` | Open | Script returns URL; extension navigates |
| `url` + `open` | Open / Web / Derive | Optional `navParams`, `{…}` templates |

#### Run (`code`)

```json
{
  "name": "Set list item limit",
  "code": "glideListClassRef.setRowsPerPage(limit);",
  "params": {
    "limit": { "placeholder": "limit", "default": "100" }
  }
}
```

Script `params` are **lexical bindings** — use bare names in `code` (`limit`), not `{limit}` or `$limit`.

#### Open URL (`url` + `open`)

```json
{
  "name": "Cancel transactions",
  "open": "tab",
  "url": "/cancel_my_transaction.do"
}
```

Derived URL with `navParams` + template:

```json
{
  "name": "Show navigator",
  "open": "same-tab",
  "navParams": {
    "target": {
      "fromUrl": "^https?://[^/]+/(?!now\\/nav\\/ui\\/classic\\/params\\/target\\/)(.+)$"
    }
  },
  "url": "{origin}/now/nav/ui/classic/params/target/{encode:target}"
}
```

URL templates support `{paramName}`, `{encode:paramName}`, and `{origin}`. Resolve order for each navParam: non-empty manual input → `fromUrl`/`fromSelector` → `default`. Blank input means no manual value. When a required navParam cannot be filled, the action is a **no-op**. Set `"optional": true` only when the action should still run with that value empty. Presence of `placeholder` (including `""`) shows a popup input; `placeholder` is never a value source.

#### Navigation (`open`)

Required on URL actions. On scriptlets only when returning a URL (`code` + `open`).

| `open` | Behavior |
|---|---|
| `same-tab` | Replace the target tab’s URL |
| `tab` | New focused tab |
| `background` | New background tab |
| `download` | `browser.downloads.download` |

### `params` (scripts) vs `navParams` (URLs)

Mutual exclusion: `params` on `code` actions, `navParams` on `url` actions. Do not declare both on one leaf.

**`params`** — script bindings only (bare names in `code`):

```json
"params": {
  "limit": { "default": "100", "placeholder": "limit", "choices": ["50", "100"] }
}
```

**`navParams`** — URL substitution only:

```json
"navParams": {
  "id": {
    "fromUrl": "\\/detail\\/([a-p]{32})",
    "placeholder": "extension id",
    "optional": true
  },
  "sys_id": {
    "placeholder": "sys_id",
    "default": "abc123"
  }
}
```

| `navParams` key | Role |
|---|---|
| `fromUrl` | Regex on tab URL (capture group 1); xor `fromSelector` |
| `fromSelector` | CSS selector on tab DOM |
| `placeholder` | Show popup input (including `""`); never a value |
| `default` | After derivation if still empty |
| `optional` | Allow empty; else missing required → no-op |

Resolve order: non-empty manual → derive → `default`. Blank input = no manual value.

Saved values live under `linkParamValues`. See `CONTEXT.md` and [ADR 0001](docs/adr/0001-params-vs-navparams.md).

### Sections in the current catalog

| Section | `match` | Contents |
|---|---|---|
| ServiceNow | `\.service-now\.com$` | Instance links, scriptlets, external docs (`match: null`) |
| Reverse-engineering tools | (none) | General DOM/event/network debugging scriptlets |
| Misc | per-link | e.g. Chrome Web Store CRX download |

See `data/links.json` for the full list. `CONTEXT.md` has architecture detail, network rules, and deferred sandbox notes.

## Updating links from bookmarks

Legacy import from the **SN links** bookmarks folder only:

```bash
node scripts/parse-bookmarks.js
```

Output is normalized to schema v3 on catalog load. Prefer editing `data/links.json` directly for reverse-engineering tools and new links.

Then reload the extension in `about:debugging`.
