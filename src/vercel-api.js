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

/**
 * Check if a project name is available on Vercel.
 * @returns {"available" | "ours" | "taken"}
 */
async function checkProjectAvailability(token, slug) {
  try {
    const { status, data } = await apiCall(token, "GET", `/v9/projects/${slug}`);
    if (status === 200 && data && data.id) return "ours";
  } catch (e) {
    if (e.status === 404) return "available";
    throw e;
  }
  return "available";
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

  // Create project — fail clearly on name collision instead of silent suffix
  try {
    await apiCall(token, "POST", "/v10/projects", {
      name: slug,
      framework: null,
    });
    return slug;
  } catch (e) {
    if (e.status === 409 || (e.message && e.message.includes("already"))) {
      throw new Error("The project name \"" + slug + "\" is already taken on Vercel. Please choose a different name.");
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

async function waitForDeployment(token, deploymentId, onProgress, timeoutMs) {
  if (!timeoutMs) timeoutMs = 60000;
  const interval = 3000;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const { data } = await apiCall(token, "GET", `/v13/deployments/${deploymentId}`);
    const state = data && data.readyState;

    if (state === "READY") return { ready: true, url: data.url, state };
    if (state === "ERROR" || state === "CANCELED") {
      const detail = (data.errorMessage) || state;
      return { ready: false, url: data.url, state, error: detail };
    }

    if (onProgress) {
      const label = state === "BUILDING" ? "Building..." : "Deploying...";
      onProgress(label);
    }

    await new Promise(r => setTimeout(r, interval));
  }

  return { ready: false, state: "TIMEOUT", error: "Deployment timed out after " + (timeoutMs / 1000) + "s" };
}

async function healthCheck(url) {
  // Wait briefly for edge propagation
  await new Promise(r => setTimeout(r, 2000));
  try {
    const resp = await requestUrl({ url, method: "GET" });
    const text = typeof resp.text === "string" ? resp.text : "";
    if (text.includes("NOT_FOUND") || text.includes("DEPLOYMENT_NOT_FOUND")) {
      return { ok: false, status: resp.status, detail: "Vercel returned NOT_FOUND at deployed URL" };
    }
    if (resp.status >= 400) {
      return { ok: false, status: resp.status, detail: "HTTP " + resp.status };
    }
    return { ok: true, status: resp.status };
  } catch (e) {
    return { ok: false, status: null, detail: e.message || String(e) };
  }
}

async function resolveReachableUrl(preferredUrl, fallbackUrl) {
  const preferredHealth = await healthCheck(preferredUrl);
  if (preferredHealth.ok || !fallbackUrl || fallbackUrl === preferredUrl) {
    return { url: preferredUrl, healthCheck: preferredHealth };
  }

  const fallbackHealth = await healthCheck(fallbackUrl);
  if (fallbackHealth.ok) {
    return { url: fallbackUrl, healthCheck: fallbackHealth };
  }

  return { url: preferredUrl, healthCheck: preferredHealth };
}

async function deployToVercel(token, noteTitle, files, opts) {
  const projectName = (opts && opts.projectName) || await ensureProject(token, slugify(noteTitle));
  const onProgress = opts && opts.onProgress;

  // Set environment variables for private pages
  if (opts && opts.isPrivate && opts.envVars) {
    await setEnvVars(token, projectName, opts.envVars);
  }

  // Prepare file entries for the deployment API
  const fileEntries = files.map(f => ({
    file: f.path,
    data: f.content,
    encoding: f.encoding || "utf-8",
  }));

  const { data } = await apiCall(token, "POST", "/v13/deployments", {
    name: projectName,
    target: "production",
    projectSettings: { framework: null },
    files: fileEntries,
  });

  const deploymentId = data && data.id;
  const projectUrl = "https://" + projectName + ".vercel.app";
  let deploymentUrl = data && data.url ? "https://" + data.url : "";
  const result = { url: deploymentUrl || projectUrl, projectName, deploymentState: "UNKNOWN" };

  if (!deploymentId) return result;

  const readyState = data.readyState;

  if (readyState === "READY") {
    result.deploymentState = "READY";
  } else if (readyState === "ERROR" || readyState === "CANCELED") {
    result.deploymentState = readyState;
    result.deploymentError = data.errorMessage || readyState;
  } else {
    // Poll until ready
    if (onProgress) onProgress("Building...");
    const poll = await waitForDeployment(token, deploymentId, onProgress);
    result.deploymentState = poll.state || "UNKNOWN";
    if (poll.error) result.deploymentError = poll.error;
    if (!deploymentUrl && poll.url) {
      deploymentUrl = "https://" + poll.url;
      result.url = deploymentUrl;
    }
  }

  // Verify the production alias matches the project name exactly
  if (result.deploymentState === "READY") {
    try {
      const { data: projData } = await apiCall(token, "GET", `/v9/projects/${projectName}`);
      const aliases = projData && projData.targets && projData.targets.production && projData.targets.production.alias;
      const expectedAlias = projectName + ".vercel.app";
      const vercelAlias = aliases && aliases.find(a => a.endsWith(".vercel.app"));

      if (vercelAlias && vercelAlias !== expectedAlias) {
        // Vercel truncated the name — URL won't match title
        result.deploymentState = "NAME_TRUNCATED";
        result.deploymentError = "The project name \"" + projectName + "\" is too long for a .vercel.app URL. "
          + "Vercel shortened it to \"" + vercelAlias.replace(".vercel.app", "") + "\". "
          + "Please shorten the note title and try again.";
        const resolved = await resolveReachableUrl("https://" + vercelAlias, deploymentUrl);
        result.url = resolved.url;
        result.healthCheck = resolved.healthCheck;
      } else {
        const preferredUrl = vercelAlias ? "https://" + vercelAlias : (deploymentUrl || projectUrl);
        const resolved = await resolveReachableUrl(preferredUrl, deploymentUrl);
        result.url = resolved.url;
        result.healthCheck = resolved.healthCheck;
      }
    } catch (_) {
      const resolved = await resolveReachableUrl(result.url, deploymentUrl);
      result.url = resolved.url;
      result.healthCheck = resolved.healthCheck;
    }
  }

  return result;
}

module.exports = { slugify, ensureProject, checkProjectAvailability, deployToVercel, setEnvVars };
