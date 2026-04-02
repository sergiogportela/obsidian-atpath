// site-icon.js — persistent favicon helpers for published sites.

function escapeHtmlAttr(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isImageDataUrl(value) {
  return typeof value === "string" && /^data:image\//i.test(value.trim());
}

function getImageMimeType(siteIconDataUrl) {
  const match = String(siteIconDataUrl || "").match(/^data:([^;,]+)/i);
  return match ? match[1] : "image/png";
}

function buildSiteIconHeadHtml(siteIconDataUrl) {
  if (!isImageDataUrl(siteIconDataUrl)) return "";

  const href = escapeHtmlAttr(siteIconDataUrl.trim());
  const mimeType = escapeHtmlAttr(getImageMimeType(siteIconDataUrl));

  return `<link rel="icon" type="${mimeType}" href="${href}">
<link rel="shortcut icon" type="${mimeType}" href="${href}">`;
}

function hasIconLink(html) {
  return /<link\b[^>]*\brel\s*=\s*["'][^"']*\bicon\b[^"']*["'][^>]*>/i.test(String(html || ""));
}

function injectSiteIconIntoHtml(html, siteIconDataUrl) {
  if (typeof html !== "string" || !html) return html;

  const iconHeadHtml = buildSiteIconHeadHtml(siteIconDataUrl);
  if (!iconHeadHtml || hasIconLink(html)) return html;

  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, iconHeadHtml + "\n</head>");
  }

  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b[^>]*>/i, (match) => match + "\n" + iconHeadHtml);
  }

  if (/<html\b[^>]*>/i.test(html)) {
    return html.replace(/<html\b[^>]*>/i, (match) => match + "\n<head>\n" + iconHeadHtml + "\n</head>");
  }

  return "<head>\n" + iconHeadHtml + "\n</head>\n" + html;
}

function applySiteIconToDeployFiles(deployFiles, siteIconDataUrl) {
  if (!Array.isArray(deployFiles) || !siteIconDataUrl) return deployFiles;

  return deployFiles.map((file) => {
    const filePath = String(file && (file.path || file.relPath) || "");
    const isHtmlFile = /\.html?$/i.test(filePath);
    if (!isHtmlFile || typeof file.content !== "string") return file;

    const nextContent = injectSiteIconIntoHtml(file.content, siteIconDataUrl);
    if (nextContent === file.content) return file;

    return { ...file, content: nextContent };
  });
}

module.exports = {
  buildSiteIconHeadHtml,
  injectSiteIconIntoHtml,
  applySiteIconToDeployFiles,
};
