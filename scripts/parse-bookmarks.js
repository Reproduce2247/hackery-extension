const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(
  path.join(__dirname, "..", "..", "bookmarks.html"),
  "utf8"
);

const snLinksHeader = html.match(/<DT><H3[^>]*>SN links<\/H3>/i);
if (!snLinksHeader) {
  console.error("SN links folder not found");
  process.exit(1);
}
const snLinksSection = extractDlInner(html, snLinksHeader.index);
if (!snLinksSection) {
  console.error("SN links DL block not found");
  process.exit(1);
}

function decodeHref(href) {
  return href
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/%22/g, '"');
}

function makeItem(folderPath, title, rawHref) {
  const href = decodeHref(rawHref);
  const item = { title: title.trim(), folder: folderPath };

  if (href.startsWith("javascript:")) {
    item.type = "scriptlet";
    let code = href.slice("javascript:".length);
    if (code.startsWith("void(") && code.endsWith(")")) {
      code = code.slice(5, -1);
    }
    item.code = code;
  } else if (/^https?:\/\//.test(href)) {
    const url = new URL(href);
    if (/\.service-now\.com$/i.test(url.hostname)) {
      item.type = "instance-path";
      item.path = url.pathname + url.search + url.hash;
    } else {
      item.type = "external";
      item.url = href;
    }
  } else {
    item.type = "instance-path";
    item.path = href.startsWith("/") ? href : `/${href}`;
  }

  return item;
}

function extractDlInner(content, startIdx) {
  const open = content.indexOf("<DL><p>", startIdx);
  if (open === -1) return null;
  let depth = 1;
  let i = open + "<DL><p>".length;
  while (i < content.length && depth > 0) {
    const nextOpen = content.indexOf("<DL><p>", i);
    const nextClose = content.indexOf("</DL><p>", i);
    if (nextClose === -1) return null;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth += 1;
      i = nextOpen + "<DL><p>".length;
    } else {
      depth -= 1;
      if (depth === 0) {
        return {
          inner: content.slice(open + "<DL><p>".length, nextClose),
          end: nextClose + "</DL><p>".length,
        };
      }
      i = nextClose + "</DL><p>".length;
    }
  }
  return null;
}

function parseBlock(block, folderPath) {
  const items = [];
  let i = 0;
  while (i < block.length) {
    const dtIdx = block.indexOf("<DT>", i);
    if (dtIdx === -1) break;

    const h3Match = block.slice(dtIdx).match(/^<DT><H3[^>]*>([^<]+)<\/H3>/);
    if (h3Match) {
      const folderName = h3Match[1].trim();
      const dl = extractDlInner(block, dtIdx + h3Match[0].length);
      if (!dl) break;
      items.push(...parseBlock(dl.inner, folderPath.concat(folderName)));
      i = dl.end;
      continue;
    }

    const linkMatch = block.slice(dtIdx).match(/^<DT><A HREF="([^"]*)"[^>]*>([^<]*)<\/A>/);
    if (linkMatch) {
      items.push(makeItem(folderPath, linkMatch[2], linkMatch[1]));
      i = dtIdx + linkMatch[0].length;
      continue;
    }

    i = dtIdx + 4;
  }
  return items;
}

function buildTree(items) {
  const root = {
    ServiceNow: {
      hostPattern: String.raw`\.service-now\.com$`,
      children: [],
    },
  };

  for (const item of items) {
    let node = root.ServiceNow;
    for (const part of item.folder) {
      let child = node.children.find(
        (c) => c.name === part && Array.isArray(c.children)
      );
      if (!child) {
        child = { name: part, children: [] };
        node.children.push(child);
      }
      node = child;
    }
    const link = { name: item.title, type: item.type };
    if (item.type === "scriptlet") link.code = item.code;
    else if (item.type === "instance-path") link.path = item.path;
    else link.url = item.url;
    node.children.push(link);
  }

  return root;
}

const items = parseBlock(snLinksSection.inner, []);
const tree = buildTree(items);
const outPath = path.join(__dirname, "..", "data", "links.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(tree, null, 2));
console.log(`Wrote ${items.length} links to ${outPath}`);
