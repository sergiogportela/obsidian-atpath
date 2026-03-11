// html-builder.js — Markdown → styled HTML pages for Vercel publishing
// Ported from build.mjs with multi-page @path support.

const markdownit = require("markdown-it");

// ─── CDN URLs (syntax highlighting & diagrams) ─────────────────────
const HLJS_CSS  = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/atom-one-dark.min.css";
const HLJS_JS   = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/highlight.min.js";
const MERMAID_JS = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js";

// ─── Helpers for code-file fencing ───────────────────────────────────

function makeFence(content) {
  let max = 2;
  const runs = content.match(/`{3,}/g);
  if (runs) for (const r of runs) { if (r.length > max) max = r.length; }
  return "`".repeat(max + 1);
}

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown"]);

// ─── Markdown rendering ──────────────────────────────────────────────

const mdi = markdownit({ html: true, linkify: true, typographer: true });

function preprocessObsidianImages(md) {
  return md.replace(
    /!\[([^\]]*?)\|(\d+)\]\(([^)]+)\)/g,
    '<img src="$3" alt="$1" width="$2" style="max-width:100%">'
  );
}

function renderMarkdown(md) {
  return mdi.render(preprocessObsidianImages(md));
}

// ─── Collapsible sections (h2–h4 → <details><summary>) ──────────────

const HEADING_RE = /^<(h[1-4])>(.*?)<\/\1>$/i;

function wrapSections(html) {
  const lines = html.split("\n");
  const out = [];
  const stack = [];

  for (const line of lines) {
    const m = line.match(HEADING_RE);
    if (!m) { out.push(line); continue; }

    const tag = m[1].toLowerCase();
    const level = parseInt(tag[1], 10);
    const content = m[2];

    if (level === 1) { out.push(line); continue; }

    while (stack.length > 0 && stack[stack.length - 1] >= level) {
      stack.pop();
      out.push("</details>");
    }

    stack.push(level);
    out.push(`<details>`);
    out.push(`<summary><${tag}>${content}</${tag}></summary>`);
  }

  while (stack.length > 0) { stack.pop(); out.push("</details>"); }
  return out.join("\n");
}

// ─── Fold bold list items into <details class="principle"> ───────────

function foldBoldListItems(html) {
  const lines = html.split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    if (
      lines[i].trim() === "<li>" &&
      i + 1 < lines.length &&
      /^<p><strong>.*<\/strong><\/p>$/.test(lines[i + 1].trim())
    ) {
      const titleMatch = lines[i + 1].match(/<p><strong>(.*?)<\/strong><\/p>/);
      const title = titleMatch[1];

      let depth = 1;
      let j = i + 2;
      const content = [];

      while (j < lines.length && depth > 0) {
        const opens = (lines[j].match(/<li[\s>]/g) || []).length;
        const closes = (lines[j].match(/<\/li>/g) || []).length;
        depth += opens - closes;
        if (depth <= 0) break;
        content.push(lines[j]);
        j++;
      }

      out.push("<li>");
      out.push(`<details class="principle"><summary><strong>${title}</strong></summary>`);
      out.push(...content);
      out.push("</details>");
      out.push("</li>");
      i = j + 1;
    } else {
      out.push(lines[i]);
      i++;
    }
  }

  return out.join("\n");
}

// ─── CSS template ────────────────────────────────────────────────────

const CSS_TEMPLATE = `
*, *::before, *::after { box-sizing: border-box; }
body {
  margin: 0; padding: 3.5rem 1rem 2rem;
  background: #1e1e1e; color: #dcddde;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
               "Helvetica Neue", Arial, sans-serif;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}
.container { max-width: 100%; padding: 0 1rem; }
h1 { font-size: 1.8em; text-decoration: underline; margin-top: 0; }
h2 { font-size: 1.554em; }
h3 { font-size: 1.342em; }
h4 { font-size: 1.158em; }
h5, h6 { font-size: 1em; }
p { margin: 0 0 0.9em 0; }
a { color: #a88bfa; text-decoration: none; }
a:hover { text-decoration: underline; }
ul, ol { padding-left: 1.8em; margin: 0 0 0.9em 0; }
li { margin-bottom: 0.25em; }
li > ul, li > ol { margin-top: 0.25em; margin-bottom: 0; }
img { border-radius: 4px; display: block; margin: 0.9em 0; }
code {
  background: #2d2d2d; padding: 0.15em 0.35em;
  border-radius: 3px; font-size: 0.9em;
}
pre {
  background: #2d2d2d; padding: 1em;
  border-radius: 6px; overflow-x: auto; margin: 0 0 0.9em 0;
}
pre code { background: none; padding: 0; }
strong { color: #e0e0e0; }
details {
  border-left: 2px solid #444;
  margin: 0.4em 0 0.4em 0.2em; padding-left: 0.8em;
}
details > details { border-left-color: #555; }
summary {
  cursor: pointer; list-style: none;
  position: relative; padding-left: 1.2em;
}
summary::-webkit-details-marker { display: none; }
summary::before {
  content: "\\25B6"; position: absolute; left: 0; top: 0.15em;
  font-size: 0.7em; color: #888; transition: transform 0.15s ease;
}
details[open] > summary::before { transform: rotate(90deg); }
summary h2, summary h3, summary h4 { display: inline; margin: 0; }
details.principle { border-left: none; margin: 0.2em 0; padding-left: 0; }
details.principle > summary { padding-left: 1.2em; }
details.principle > summary strong { font-size: 1em; }
.top-btns {
  position: fixed; top: 1rem; right: 1rem;
  display: flex; gap: 0.5rem; z-index: 10;
}
.contact-btn {
  background: #25d366; color: #fff; border: 1px solid #1da851;
  padding: 0.4em 0.8em; border-radius: 6px; font-size: 0.85em;
  text-decoration: none; transition: background 0.15s;
}
.contact-btn:hover { background: #1da851; text-decoration: none; color: #fff; }
.dl-btn {
  background: #2d2d2d; color: #a88bfa; border: 1px solid #444;
  padding: 0.4em 0.8em; border-radius: 6px; font-size: 0.85em;
  text-decoration: none; transition: background 0.15s;
}
.dl-btn:hover { background: #3a3a3a; text-decoration: none; }
hr { border: none; border-top: 1px solid #444; margin: 1.5em 0; }
.atpath-ref {
  color: #a88bfa; text-decoration: underline dotted;
  cursor: pointer;
}
.atpath-ref:hover { text-decoration: underline solid; }
.atpath-nested {
  color: #a88bfa; opacity: 0.6;
  font-style: italic;
}
.back-nav {
  margin-bottom: 1.5em; padding-bottom: 0.8em;
  border-bottom: 1px solid #444;
}
.back-nav a { font-size: 0.95em; }
pre code.hljs { background: transparent; padding: 0; }
.mermaid { text-align: center; margin: 1em 0; }
.mermaid svg { max-width: 100%; }
`;

// ─── HTML scaffolding ────────────────────────────────────────────────

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function topButtons(downloadBase64, downloadFilename, contactUrl, contactLabel) {
  let btns = "";
  if (contactUrl) {
    btns += `  <a class="contact-btn" href="${escapeHtml(contactUrl)}" target="_blank" rel="noopener">${escapeHtml(contactLabel || "Contact")}</a>\n`;
  }
  const ext = (downloadFilename.match(/\.(\w+)$/) || [])[1] || "md";
  const mime = ext === "md" ? "text/markdown" : "text/plain";
  btns += `  <a class="dl-btn" href="data:${mime};base64,${downloadBase64}" download="${escapeHtml(downloadFilename)}">Baixar .${ext}</a>\n`;
  return `<div class="top-btns">\n${btns}</div>`;
}

function htmlPage(title, bodyContent, extraHead) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${CSS_TEMPLATE}</style>
<link rel="stylesheet" href="${HLJS_CSS}">
${extraHead || ""}
</head>
<body>
${bodyContent}
<script src="${HLJS_JS}"><\/script>
<script src="${MERMAID_JS}"><\/script>
<script>
(function() {
  try {
    document.querySelectorAll('pre code').forEach(function(el) {
      if (!el.classList.contains('language-mermaid')) hljs.highlightElement(el);
    });
  } catch(e) {}
  try {
    document.querySelectorAll('pre code.language-mermaid').forEach(function(el) {
      var div = document.createElement('div');
      div.className = 'mermaid';
      div.textContent = el.textContent;
      el.closest('pre').replaceWith(div);
    });
    mermaid.initialize({ startOnLoad: false, theme: 'dark' });
    mermaid.run();
  } catch(e) {}
})();
<\/script>
</body>
</html>`;
}

// ─── Slug helpers ────────────────────────────────────────────────────

function slugifyPath(filePath) {
  return filePath
    .replace(/[\/\\.]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

// ─── @path replacement in markdown ───────────────────────────────────

const AT_PATH_RE = /(?<=^|[\s(])@([\w\p{L}\p{M}./_-]+\.[\w]+|[\w\p{L}\p{M}./_-][\w\p{L}\p{M}./ _()&-]+?\.[\w]+)/gu;

function replaceAtPathsWithLinks(md, atPathSlugs, compactLinks) {
  const regex = new RegExp(AT_PATH_RE.source, AT_PATH_RE.flags);
  return md.replace(regex, (match, relPath) => {
    const slug = atPathSlugs.get(relPath);
    if (slug) {
      const linkText = compactLinks ? relPath.split("/").pop() : "@" + relPath;
      return `<a href="atpath/${slug}.html" class="atpath-ref">${linkText}</a>`;
    }
    return match;
  });
}

function replaceNestedAtPaths(md) {
  const regex = new RegExp(AT_PATH_RE.source, AT_PATH_RE.flags);
  return md.replace(regex, (match, relPath) => {
    return `<span class="atpath-nested">@${escapeHtml(relPath)}</span>`;
  });
}

// ─── Pipeline ────────────────────────────────────────────────────────

function processMarkdown(md) {
  let html = renderMarkdown(md);
  html = wrapSections(html);
  html = foldBoldListItems(html);
  return html;
}

function toBase64(str) {
  // Works in both Node and browser (Obsidian)
  if (typeof Buffer !== "undefined") return Buffer.from(str).toString("base64");
  return btoa(unescape(encodeURIComponent(str)));
}

// ─── Exported builders ──────────────────────────────────────────────

function buildMainPage(title, markdown, atPathSlugs, contactUrl, contactLabel, compactLinks) {
  const mdBase64 = toBase64(markdown);
  const downloadFilename = title + ".md";

  // Replace first-level @paths with links before rendering
  let md = replaceAtPathsWithLinks(markdown, atPathSlugs, compactLinks);

  const bodyHtml = processMarkdown(md);
  const buttons = topButtons(mdBase64, downloadFilename, contactUrl, contactLabel);

  return htmlPage(title, `${buttons}\n<div class="container">\n${bodyHtml}\n</div>`);
}

function buildAtPathPage(title, markdown, mainPageTitle, contactUrl, contactLabel) {
  const mdBase64 = toBase64(markdown);
  const downloadFilename = title.replace(/\//g, "-");

  // Wrap non-markdown files in a fenced code block so they render as <pre><code>
  const ext = (title.match(/\.(\w+)$/) || [])[1]?.toLowerCase();
  let md = markdown;
  if (ext && !MARKDOWN_EXTENSIONS.has(ext)) {
    const fence = makeFence(md);
    md = fence + ext + "\n" + md + "\n" + fence;
  }

  // Replace second-level @paths as inert spans
  md = replaceNestedAtPaths(md);

  const bodyHtml = processMarkdown(md);
  const buttons = topButtons(mdBase64, downloadFilename, contactUrl, contactLabel);

  const backNav = `<div class="back-nav"><a href="../index.html">&larr; Back to ${escapeHtml(mainPageTitle)}</a></div>`;

  return htmlPage(title, `${buttons}\n<div class="container">\n${backNav}\n${bodyHtml}\n</div>`);
}

module.exports = { buildMainPage, buildAtPathPage, slugifyPath, AT_PATH_RE };
