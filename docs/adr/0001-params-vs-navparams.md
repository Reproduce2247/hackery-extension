# Separate script `scriptParams` from URL `navParams`

Script bindings and page-derived URL values used to share one dual-use model (`params` + `extract`), which forced merge logic in the popup UI and resolve path. Schema v3 splits them: **`scriptParams`** are lexical bindings for `code` actions only; **`navParams`** are values substituted into `url` templates (with optional `fromUrl` / `fromSelector` derivation). A leaf uses one or the other, not both. The script map was renamed from `params` to `scriptParams` so the two channels are not the same word. `type` is `boolean` or omitted (`string`) on both maps.

**Considered:** a third `urlParams` map for typed-only URL values; rejected in favor of folding typed values into `navParams` and using `placeholder` presence as the UI opt-in.

**Consequences:** blank popup input means “no manual value” (fall through to derive → default); `placeholder` is never a value source; missing required navParams no-op navigation.
