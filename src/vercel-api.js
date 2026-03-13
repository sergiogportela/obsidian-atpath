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

function buildRequestError(service, method, path, status, detail) {
  let message = service + " " + method + " " + path + " failed";
  if (status != null) message += ", status " + status;
  if (detail) message += ": " + detail;
  const err = new Error(message);
  if (status != null) err.status = status;
  return err;
}

function extractErrorDetail(data, text) {
  if (data && typeof data === "object") {
    if (typeof data.error === "string") return data.error;
    if (data.error && typeof data.error.message === "string") return data.error.message;
    if (typeof data.message === "string") return data.message;
  }
  if (typeof text === "string" && text.trim()) return text.trim();
  return "";
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

  let resp;
  try {
    resp = await requestUrl(options);
  } catch (e) {
    const status = typeof e.status === "number" ? e.status : null;
    throw buildRequestError("Vercel API", method, path, status, e.message || "");
  }
  if (resp.status >= 400) {
    throw buildRequestError("Vercel API", method, path, resp.status, extractErrorDetail(resp.json, resp.text));
  }
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

async function setEnvVars(token, projectSlug, vars) {
  // List existing env vars
  const { data: existing } = await apiCall(token, "GET", `/v9/projects/${projectSlug}/env`);
  const envList = (existing && existing.envs) || [];
  const envMap = {};
  for (const e of envList) {
    envMap[e.key] = e.id;
  }

  for (const [key, value] of Object.entries(vars)) {
    if (envMap[key]) {
      // Update existing
      await apiCall(token, "PATCH", `/v9/projects/${projectSlug}/env/${envMap[key]}`, {
        value,
        type: "encrypted",
        target: ["production"],
      });
    } else {
      // Create new
      await apiCall(token, "POST", `/v10/projects/${projectSlug}/env`, {
        key,
        value,
        type: "encrypted",
        target: ["production"],
      });
    }
  }
}

function generateAuthSecret() {
  return require("crypto").randomBytes(32).toString("hex");
}

async function provisionUpstashRedis(upstashEmail, upstashApiKey) {
  if (!upstashEmail) {
    throw new Error("Upstash account email is required to provision Redis.");
  }
  const basicAuth = Buffer.from(upstashEmail + ":" + upstashApiKey).toString("base64");
  let resp;
  try {
    resp = await requestUrl({
      url: "https://api.upstash.com/v2/redis/database",
      method: "POST",
      headers: {
        Authorization: "Basic " + basicAuth,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        database_name: "atpath-auth",
        region: "global",
        primary_region: "us-east-1",
        tls: true,
      }),
    });
  } catch (e) {
    const status = typeof e.status === "number" ? e.status : null;
    throw buildRequestError("Upstash API", "POST", "/v2/redis/database", status, e.message || "");
  }
  if (resp.status >= 400) {
    throw buildRequestError("Upstash API", "POST", "/v2/redis/database", resp.status, extractErrorDetail(resp.json, resp.text));
  }
  const data = resp.json;
  return {
    endpoint: data.endpoint,
    password: data.password,
    restUrl: data.rest_url || ("https://" + data.endpoint),
    restToken: data.rest_token,
  };
}

async function deployToVercel(token, noteTitle, files, opts) {
  const projectName = (opts && opts.projectName) || await ensureProject(token, slugify(noteTitle));

  // Set environment variables for private pages
  if (opts && opts.isPrivate && opts.envVars) {
    await setEnvVars(token, projectName, opts.envVars);
  }

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

  return { url: "https://" + projectName + ".vercel.app", projectName };
}

module.exports = { slugify, ensureProject, deployToVercel, setEnvVars, generateAuthSecret, provisionUpstashRedis };
