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
 * @param {Object} config
 * @param {string} config.projectName - Vercel project name
 * @returns {string} Complete Node.js module source for api/approve.js
 */
function buildApproveFunction(config) {
  const projectNameJSON = JSON.stringify(config.projectName);

  return `import { createHmac, timingSafeEqual } from "crypto";
import { createClerkClient } from "@clerk/backend";

const PROJECT_NAME = ${projectNameJSON};
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

function htmlPage(title, message, ok) {
  return \`<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>\${title}</title>
<style>body{font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:\${ok?"#f0fdf4":"#fef2f2"};color:#1e1e1e}
.card{background:#fff;border-radius:12px;padding:2em 2.5em;max-width:420px;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,.08)}
h1{font-size:1.3em;margin:0 0 .5em}p{color:#555;margin:0}</style></head>
<body><div class="card"><h1>\${title}</h1><p>\${message}</p></div></body></html>\`;
}

export default async function handler(req, res) {
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

  try {
    var result = await clerkClient.users.getUserList({ emailAddress: [payload.email] });
    var user = result.data && result.data[0];
    if (!user) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(404).send(htmlPage("Usu\\u00e1rio n\\u00e3o encontrado", "O usu\\u00e1rio " + payload.email + " ainda n\\u00e3o criou uma conta.", false));
    }

    await clerkClient.users.updateUserMetadata(user.id, {
      privateMetadata: { ["approved:" + PROJECT_NAME]: true }
    });

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(htmlPage("Acesso aprovado \\u2705", payload.email + " agora tem acesso a esta p\\u00e1gina.", true));
  } catch(e) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(500).send(htmlPage("Erro", "Falha ao aprovar usu\\u00e1rio. Tente novamente.", false));
  }
};
`;
}

module.exports = { buildAuthFunction, buildApproveFunction };
