// vercel-api.js — Vercel REST API client using Obsidian's requestUrl

const { requestUrl } = require("obsidian");

const VERCEL_API = "https://api.vercel.com";

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

function sha1Hex(str) {
  // Simple hash for collision suffix — not cryptographic, just for uniqueness
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash |= 0;
  }
  return Math.abs(hash).toString(16).slice(0, 4);
}

async function apiCall(token, method, path, body) {
  const options = {
    url: VERCEL_API + path,
    method,
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
  };
  if (body) options.body = JSON.stringify(body);

  const resp = await requestUrl(options);
  return { status: resp.status, data: resp.json };
}

async function ensureProject(token, slug) {
  // Check if project exists
  try {
    const { status, data } = await apiCall(token, "GET", `/v9/projects/${slug}`);
    if (status === 200 && data && data.id) {
      // Clear stale build settings that may have been set by `vercel` CLI
      await apiCall(token, "PATCH", `/v9/projects/${slug}`, {
        buildCommand: "",
        outputDirectory: "",
        framework: null,
      });
      return slug;
    }
  } catch (e) {
    // 404 or other error — proceed to create
    if (e.status && e.status !== 404) throw new Error("Vercel API error: " + (e.message || e.status));
  }

  // Create project
  try {
    await apiCall(token, "POST", "/v10/projects", {
      name: slug,
      framework: null,
    });
    return slug;
  } catch (e) {
    // Name collision — append hash suffix
    if (e.status === 409 || (e.message && e.message.includes("already"))) {
      const fallback = slug + "-" + sha1Hex(slug + Date.now());
      await apiCall(token, "POST", "/v10/projects", {
        name: fallback,
        framework: null,
      });
      return fallback;
    }
    throw new Error("Failed to create Vercel project: " + (e.message || e.status));
  }
}

async function deployToVercel(token, noteTitle, files) {
  const slug = slugify(noteTitle);
  const projectName = await ensureProject(token, slug);

  // Prepare file entries for the deployment API
  const fileEntries = files.map(f => ({
    file: f.path,
    data: f.content,
    encoding: "utf-8",
  }));

  const { data } = await apiCall(token, "POST", "/v13/deployments", {
    name: projectName,
    target: "production",
    projectSettings: { framework: null },
    files: fileEntries,
  });

  const url = data.url ? "https://" + data.url : data.alias && data.alias[0] ? "https://" + data.alias[0] : null;

  return { url: url || "https://" + projectName + ".vercel.app", projectName };
}

module.exports = { slugify, deployToVercel };
