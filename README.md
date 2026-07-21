# ServiceNow Links (Firefox)

Firefox extension that exposes every bookmark from the **SN links** folder as instance-independent links. ServiceNow instance URLs are stored as paths only; scriptlets run against whichever `*.service-now.com` tab you have open (or the last instance you visited).

## Install (temporary)

1. Open Firefox and go to `about:debugging`.
2. Click **This Firefox**.
3. Click **Load Temporary Add-on…**
4. Select `manifest.json` in this folder.

Temporary add-ons are removed when Firefox closes.

## Install (signed / persistent)

Package the folder as a `.zip` and submit to Mozilla Add-ons, or use Firefox Developer Edition with unsigned extensions enabled.

## Usage

1. Open any ServiceNow instance tab (`*.service-now.com`).
2. Click the extension toolbar button.
3. Choose a link:
   - **Run** — bookmarklet / scriptlet executed on the instance tab
   - **Open** — navigates using the current instance origin + saved path
   - **Web** — external reference (opens as-is)

The popup shows which instance origin will be used. If the active tab is not ServiceNow, the extension uses the last visited instance stored in local storage.

## Updating links from bookmarks

After editing `bookmarks.html`, regenerate link data:

```bash
node scripts/parse-bookmarks.js
```

Then reload the extension in `about:debugging`.

## Included links

All 13 bookmarks from the SN links folder:

- Show navigator (scriptlet)
- SN Upload XML
- Cancel transactions (scriptlet)
- Demo instance
- App Log — current hour (scriptlet)
- App Log — last hour (URI)
- Converting XML to a Record (external)
- Custom Layout for sp-model (external)
- UIB form component folder (3 instance links)
- ServiceNow node logs (scriptlet)
- Now Component Library (external)
