import { captureTabPrefillForBuilder } from "./link-builder.js";

const BUILDER_PAGE = "builder/builder.html";
const { LINK_BUILDER_PREFILL_KEY } = globalThis.SnLinksStorageKeys;

async function stashBuilderPrefill() {
  const prefill = await captureTabPrefillForBuilder();
  await browser.storage.session.set({ [LINK_BUILDER_PREFILL_KEY]: prefill });
}

export async function openLinkBuilderWindow({ editId } = {}) {
  const baseUrl = browser.runtime.getURL(BUILDER_PAGE);
  const targetUrl = editId
    ? `${baseUrl}?edit=${encodeURIComponent(editId)}`
    : `${baseUrl}?new=1`;

  if (!editId) {
    await stashBuilderPrefill();
  }

  const windows = await browser.windows.getAll({ populate: true });
  for (const win of windows) {
    for (const tab of win.tabs || []) {
      if (tab.url?.startsWith(baseUrl) && win.id != null) {
        await browser.windows.update(win.id, { focused: true });
        if (tab.id != null) {
          await browser.tabs.update(tab.id, { active: true, url: targetUrl });
        }
        return;
      }
    }
  }

  await browser.windows.create({
    url: targetUrl,
    type: "popup",
    width: 960,
    height: 720,
  });
}
