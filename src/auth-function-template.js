/**
 * Builds a complete JavaScript source string for a Vercel serverless function (api/auth.js)
 * that verifies Clerk session tokens and serves content to approved emails.
 *
 * @param {Object} config
 * @param {string[]} config.approvedEmails - Lowercase email addresses allowed access
 * @param {Object<string, string>} config.pages - Map of page keys to HTML content strings
 * @param {string} config.projectName - Vercel project name (used for privateMetadata key + approval URL)
 * @returns {string} Complete Node.js module source for api/auth.js
 */
function buildAuthFunction(config) {
  const approvedEmailsJSON = JSON.stringify(config.approvedEmails);
  const pagesJSON = JSON.stringify(config.pages);
  const projectNameJSON = JSON.stringify(config.projectName);

  return `import { createHmac } from "crypto";
import { verifyToken, createClerkClient } from "@clerk/backend";

// --- Embedded config (generated at build time) ---
const APPROVED_EMAILS = ${approvedEmailsJSON};
const PAGES = ${pagesJSON};
const PROJECT_NAME = ${projectNameJSON};

const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

function signToken(payload) {
  var data = JSON.stringify(payload);
  var sig = createHmac("sha256", process.env.CLERK_SECRET_KEY).update(data).digest("hex");
  return Buffer.from(data).toString("base64url") + "." + sig;
}

export default async function handler(req, res) {
  const auth = (req.headers.authorization || "").replace(/^Bearer\\s+/, "");
  if (!auth) return res.status(401).json({ error: "Not authenticated" });

  let claims;
  try {
    claims = await verifyToken(auth, { secretKey: process.env.CLERK_SECRET_KEY });
  } catch {
    return res.status(401).json({ error: "Invalid session" });
  }

  // Fetch user to get email (not in default JWT claims)
  let email, user;
  try {
    user = await clerkClient.users.getUser(claims.sub);
    const primary = user.emailAddresses.find(function(e) { return e.id === user.primaryEmailAddressId; });
    email = (primary && primary.emailAddress || "").toLowerCase();
  } catch {
    return res.status(500).json({ error: "Failed to resolve user" });
  }

  // Check approved emails list
  var isApproved = APPROVED_EMAILS.includes(email);

  // Check privateMetadata approval
  if (!isApproved) {
    var meta = user.privateMetadata || {};
    if (meta["approved:" + PROJECT_NAME] === true) {
      isApproved = true;
    }
  }

  if (!isApproved) {
    var token = signToken({ email: email, site: PROJECT_NAME, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 });
    var approvalUrl = "https://" + PROJECT_NAME + ".vercel.app/api/approve?token=" + encodeURIComponent(token);
    return res.status(403).json({ error: "Access denied", approvalUrl: approvalUrl });
  }

  const pageKey = (req.query && req.query.page) || "main";
  const html = PAGES[pageKey];
  if (!html) return res.status(404).json({ error: "Page not found" });

  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.status(200).send(html);
};
`;
}

/**
 * Builds a complete JavaScript source string for a Vercel serverless function (api/approve.js)
 * that validates an HMAC-signed token and approves the user via Clerk privateMetadata.
 *
 * GET: Serves an HTML page that loads Clerk JS, authenticates the publisher, and auto-POSTs.
 * POST: Requires Clerk session (Bearer token), verifies publisher email, then approves the user.
 *
 * @param {Object} config
 * @param {string} config.projectName - Vercel project name
 * @param {string} config.clerkPublishableKey - Clerk publishable key for frontend auth
 * @param {string} config.publisherEmail - Publisher email (only this user can approve)
 * @returns {string} Complete Node.js module source for api/approve.js
 */
function buildApproveFunction(config) {
  const projectNameJSON = JSON.stringify(config.projectName);
  const publishableKeyJSON = JSON.stringify(config.clerkPublishableKey);
  const publisherEmailJSON = JSON.stringify((config.publisherEmail || "").toLowerCase().trim());

  return `import { createHmac, timingSafeEqual } from "crypto";
import { verifyToken, createClerkClient } from "@clerk/backend";

const PROJECT_NAME = ${projectNameJSON};
const CLERK_PUBLISHABLE_KEY = ${publishableKeyJSON};
const PUBLISHER_EMAIL = ${publisherEmailJSON};
const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

function verifySignedToken(raw) {
  var parts = raw.split(".");
  if (parts.length !== 2) return null;
  var data = Buffer.from(parts[0], "base64url");
  var expected = createHmac("sha256", process.env.CLERK_SECRET_KEY).update(data).digest("hex");
  if (!timingSafeEqual(Buffer.from(parts[1]), Buffer.from(expected))) return null;
  var payload = JSON.parse(data.toString());
  if (payload.site !== PROJECT_NAME) return null;
  if (Date.now() > payload.exp) return null;
  return payload;
}

function escapeHtml(str) {
  return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function htmlPage(title, message, ok) {
  return \`<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>\${title}</title>
<style>body{font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:\${ok?"#f0fdf4":"#fef2f2"};color:#1e1e1e}
.card{background:#fff;border-radius:12px;padding:2em 2.5em;max-width:420px;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,.08)}
h1{font-size:1.3em;margin:0 0 .5em}p{color:#555;margin:0}</style></head>
<body><div class="card"><h1>\${title}</h1><p>\${message}</p></div></body></html>\`;
}

function approvalPage(email, token) {
  var safeEmail = escapeHtml(email);
  return \`<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Aprovar acesso</title>
<style>body{font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f8fafc;color:#1e1e1e}
.card{background:#fff;border-radius:12px;padding:2em 2.5em;max-width:480px;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,.08)}
h1{font-size:1.3em;margin:0 0 .5em}p{color:#555;margin:.5em 0}
#clerk-auth{margin:1.5em 0}
#status{color:#888;font-style:italic}
.ok{color:#16a34a}.err{color:#dc2626}</style></head>
<body><div class="card">
<h1>Aprovar acesso</h1>
<p>Aprovar acesso para <strong>\${safeEmail}</strong>?</p>
<div id="clerk-auth"></div>
<p id="status">Carregando...</p>
</div>
<script>
var hmacToken = \${JSON.stringify(token)};
var publisherEmail = \${JSON.stringify(PUBLISHER_EMAIL)};

function setStatus(msg, cls) {
  var el = document.getElementById("status");
  el.textContent = msg;
  el.className = cls || "";
}

function doApprove(sessionToken) {
  setStatus("Aprovando...");
  fetch("/api/approve", {
    method: "POST",
    headers: { "Authorization": "Bearer " + sessionToken, "Content-Type": "application/json" },
    body: JSON.stringify({ token: hmacToken })
  }).then(function(r) { return r.json().then(function(b) { return { ok: r.ok, body: b }; }); })
    .then(function(res) {
      if (res.ok) {
        setStatus("Acesso aprovado \\u2705", "ok");
        document.querySelector("h1").textContent = "Acesso aprovado \\u2705";
      } else {
        setStatus(res.body.error || "Erro ao aprovar", "err");
      }
    })
    .catch(function() { setStatus("Erro de rede", "err"); });
}

function checkAndApprove() {
  if (!window.Clerk) return;
  var user = window.Clerk.user;
  if (!user) {
    setStatus("Fa\\u00e7a login para continuar");
    var el = document.getElementById("clerk-auth");
    if (el && window.Clerk.mountSignIn) window.Clerk.mountSignIn(el);
    window.Clerk.addListener(function() {
      if (window.Clerk.user) checkAndApprove();
    });
    return;
  }
  var email = (user.primaryEmailAddress && user.primaryEmailAddress.emailAddress || "").toLowerCase();
  if (email !== publisherEmail) {
    setStatus("Apenas o propriet\\u00e1rio do site pode aprovar acessos.", "err");
    return;
  }
  window.Clerk.session.getToken().then(doApprove);
}

(function() {
  var s = document.createElement("script");
  s.src = "https://cdn.jsdelivr.net/npm/@clerk/clerk-js@5/dist/clerk.browser.min.js";
  s.setAttribute("data-clerk-publishable-key", \${JSON.stringify(CLERK_PUBLISHABLE_KEY)});
  s.addEventListener("load", function() {
    window.Clerk.load().then(checkAndApprove);
  });
  document.head.appendChild(s);
})();
</script></body></html>\`;
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    var raw = req.query && req.query.token;
    if (!raw) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(400).send(htmlPage("Link inv\\u00e1lido", "Token ausente.", false));
    }

    var payload = verifySignedToken(raw);
    if (!payload) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(400).send(htmlPage("Link inv\\u00e1lido", "Token expirado ou inv\\u00e1lido.", false));
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(approvalPage(payload.email, raw));
  }

  if (req.method === "POST") {
    var auth = (req.headers.authorization || "").replace(/^Bearer\\s+/, "");
    if (!auth) return res.status(401).json({ error: "Not authenticated" });

    var claims;
    try {
      claims = await verifyToken(auth, { secretKey: process.env.CLERK_SECRET_KEY });
    } catch {
      return res.status(401).json({ error: "Invalid session" });
    }

    var callerUser;
    try {
      callerUser = await clerkClient.users.getUser(claims.sub);
    } catch {
      return res.status(500).json({ error: "Failed to resolve user" });
    }
    var primary = callerUser.emailAddresses.find(function(e) { return e.id === callerUser.primaryEmailAddressId; });
    var callerEmail = (primary && primary.emailAddress || "").toLowerCase();

    if (callerEmail !== PUBLISHER_EMAIL) {
      return res.status(403).json({ error: "Only the site owner can approve access" });
    }

    var tokenStr = req.body && req.body.token;
    if (!tokenStr) return res.status(400).json({ error: "Token missing" });

    var tokenPayload = verifySignedToken(tokenStr);
    if (!tokenPayload) return res.status(400).json({ error: "Token expired or invalid" });

    try {
      var result = await clerkClient.users.getUserList({ emailAddress: [tokenPayload.email] });
      var user = result.data && result.data[0];
      if (!user) return res.status(404).json({ error: "User not found" });

      await clerkClient.users.updateUserMetadata(user.id, {
        privateMetadata: { ["approved:" + PROJECT_NAME]: true }
      });

      return res.status(200).json({ success: true });
    } catch(e) {
      return res.status(500).json({ error: "Failed to approve user" });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
};
`;
}

module.exports = { buildAuthFunction, buildApproveFunction };
