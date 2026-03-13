/**
 * Builds a complete JavaScript source string for a Vercel serverless function (api/auth.js)
 * that handles magic-link authentication with Upstash Redis and Resend email.
 *
 * @param {Object} config
 * @param {string[]} config.approvedEmails - Lowercase email addresses allowed to receive magic links
 * @param {Object<string, string>} config.pages - Map of page keys to HTML content strings
 * @param {string} config.noteTitle - Title of the published note
 * @param {string} config.siteUrl - Full URL of the deployed site (no trailing slash)
 * @returns {string} Complete Node.js module source for api/auth.js
 */
function buildAuthFunction(config) {
  const approvedEmailsJSON = JSON.stringify(config.approvedEmails);
  const pagesJSON = JSON.stringify(config.pages);
  const noteTitleJSON = JSON.stringify(config.noteTitle);
  const siteUrlJSON = JSON.stringify(config.siteUrl);

  return `const crypto = require("crypto");

// --- Embedded config (generated at build time) ---
const APPROVED_EMAILS = ${approvedEmailsJSON};
const PAGES = ${pagesJSON};
const NOTE_TITLE = ${noteTitleJSON};
const SITE_URL = ${siteUrlJSON};

// --- JWT helpers (manual, no library) ---

function base64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\\+/g, "-")
    .replace(/\\//g, "_")
    .replace(/=+$/, "");
}

function base64urlDecode(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return Buffer.from(str, "base64");
}

function signJWT(payload, secret) {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  const signature = base64url(
    crypto.createHmac("sha256", secret).update(header + "." + body).digest()
  );
  return header + "." + body + "." + signature;
}

function verifyJWT(token, secret) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = Buffer.from(
    base64url(
      crypto.createHmac("sha256", secret).update(header + "." + body).digest()
    )
  );
  const actual = Buffer.from(sig);
  if (expected.length !== actual.length) return null;
  if (!crypto.timingSafeEqual(expected, actual)) return null;
  const payload = JSON.parse(base64urlDecode(body).toString("utf8"));
  if (payload.exp && Date.now() / 1000 > payload.exp) return null;
  return payload;
}

// --- Upstash Redis REST helpers ---

async function redis(command) {
  const res = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + process.env.UPSTASH_REDIS_REST_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });
  return res.json();
}

async function redisSet(key, value, exSeconds) {
  return redis(["SET", key, value, "EX", String(exSeconds)]);
}

async function redisGet(key) {
  const data = await redis(["GET", key]);
  return data.result;
}

async function redisDel(key) {
  return redis(["DEL", key]);
}

// --- Resend email helper ---

async function sendEmail(to, subject, html) {
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + process.env.RESEND_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "AtPath <onboarding@resend.dev>",
      to: [to],
      subject: subject,
      html: html,
    }),
  });
}

// --- Body parser ---

function parseBody(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === "object") {
      resolve(req.body);
      return;
    }
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
  });
}

// --- Cookie helpers ---

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const cookies = {};
  header.split(";").forEach((pair) => {
    const [key, ...rest] = pair.trim().split("=");
    if (key) cookies[key.trim()] = rest.join("=").trim();
  });
  return cookies;
}

// --- Confirmation HTML template ---

function confirmationPage(title, message) {
  return \`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>\${title}</title>
<style>
  body {
    background: #1e1e1e;
    color: #d4d4d4;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 100vh;
    margin: 0;
    padding: 1rem;
  }
  .card {
    background: #2d2d2d;
    border-radius: 8px;
    padding: 2rem 2.5rem;
    max-width: 480px;
    text-align: center;
    box-shadow: 0 4px 24px rgba(0,0,0,0.4);
  }
  h1 { color: #e0e0e0; font-size: 1.3rem; margin-top: 0; }
  p { line-height: 1.6; }
  a { color: #7cafc2; }
</style>
</head>
<body>
<div class="card">
  <h1>\${title}</h1>
  <p>\${message}</p>
</div>
</body>
</html>\`;
}

// --- Handler ---

module.exports = async function handler(req, res) {
  const secret = process.env.AUTH_SECRET;

  // For POST requests, action may be in JSON body instead of query string
  let action = req.query && req.query.action;
  let parsedBody = null;
  if (!action && req.method === "POST") {
    parsedBody = await parseBody(req);
    action = parsedBody.action;
  }

  // ---- send-link (POST) ----
  if (action === "send-link" && req.method === "POST") {
    const body = parsedBody || await parseBody(req);
    const email = (body.email || "").toLowerCase().trim();
    const approved = APPROVED_EMAILS.includes(email);

    const start = Date.now();
    if (approved) {
      const tokenId = crypto.randomUUID();
      await redisSet("link:" + tokenId, "1", 300);
      const jwt = signJWT(
        { sub: email, jti: tokenId, exp: Math.floor(Date.now() / 1000) + 300 },
        secret
      );
      const link = SITE_URL + "/api/auth?action=verify-link&token=" + jwt;
      await sendEmail(
        email,
        "Your login link for " + NOTE_TITLE,
        "<p>Click the link below to sign in:</p>" +
          '<p><a href="' + link + '">Sign in to ' + NOTE_TITLE + "</a></p>" +
          "<p>This link expires in 5 minutes and can only be used once.</p>"
      );
    } else {
      await new Promise((r) => setTimeout(r, 500));
    }
    // Pad both paths to consistent timing to prevent email enumeration
    const elapsed = Date.now() - start;
    const minTime = 1500;
    if (elapsed < minTime) {
      await new Promise((r) => setTimeout(r, minTime - elapsed));
    }

    res.status(200).json({ status: approved ? "sent" : "not_approved" });
    return;
  }

  // ---- verify-link (GET) ----
  if (action === "verify-link" && req.method === "GET") {
    const token = req.query.token;
    const payload = verifyJWT(token || "", secret);
    if (!payload || !payload.jti) {
      res.status(401).send("Invalid or expired link.");
      return;
    }

    const stored = await redisGet("link:" + payload.jti);
    if (!stored) {
      res.status(401).send("Link already used or expired.");
      return;
    }
    await redisDel("link:" + payload.jti);

    const sessionId = crypto.randomUUID();
    await redisSet("session:" + sessionId, payload.sub, 604800);

    res.setHeader(
      "Set-Cookie",
      "session=" + sessionId + "; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800"
    );
    res.writeHead(302, { Location: "/" });
    res.end();
    return;
  }

  // ---- request-access (POST) ----
  if (action === "request-access" && req.method === "POST") {
    const body = parsedBody || await parseBody(req);
    const email = (body.email || "").toLowerCase().trim();
    const publisherEmail = process.env.PUBLISHER_EMAIL;

    const approveId = crypto.randomUUID();
    const denyId = crypto.randomUUID();

    await Promise.all([
      redisSet("approval:" + approveId, email, 604800),
      redisSet("approval:" + denyId, email, 604800),
    ]);

    const approveJWT = signJWT(
      { action: "approve", jti: approveId, email: email, exp: Math.floor(Date.now() / 1000) + 604800 },
      secret
    );
    const denyJWT = signJWT(
      { action: "deny", jti: denyId, email: email, exp: Math.floor(Date.now() / 1000) + 604800 },
      secret
    );

    const approveLink = SITE_URL + "/api/auth?action=approve&token=" + approveJWT;
    const denyLink = SITE_URL + "/api/auth?action=deny&token=" + denyJWT;

    await sendEmail(
      publisherEmail,
      "Access request for " + NOTE_TITLE,
      "<p><strong>" + email + "</strong> is requesting access to <strong>" + NOTE_TITLE + "</strong>.</p>" +
        '<p><a href="' + approveLink + '">Approve</a> | <a href="' + denyLink + '">Deny</a></p>' +
        "<p>These links expire in 7 days.</p>"
    );

    res.status(200).json({ status: "requested" });
    return;
  }

  // ---- approve (GET) ----
  if (action === "approve" && req.method === "GET") {
    const token = req.query.token;
    const payload = verifyJWT(token || "", secret);
    if (!payload || payload.action !== "approve" || !payload.jti) {
      res.status(401).send(confirmationPage("Invalid link", "This approval link is invalid or has expired."));
      return;
    }

    const email = await redisGet("approval:" + payload.jti);
    if (!email) {
      res.status(401).send(confirmationPage("Already used", "This approval link has already been used or has expired."));
      return;
    }
    await redisDel("approval:" + payload.jti);

    // Send magic link to the approved reader (link expires in 5 min, session lasts 30 days)
    const tokenId = crypto.randomUUID();
    await redisSet("link:" + tokenId, "30d", 300);
    const magicJWT = signJWT(
      { sub: email, jti: tokenId, longSession: true, exp: Math.floor(Date.now() / 1000) + 300 },
      secret
    );
    const magicLink = SITE_URL + "/api/auth?action=access&token=" + magicJWT;

    await sendEmail(
      email,
      "You've been approved for " + NOTE_TITLE,
      "<p>Your access request has been approved.</p>" +
        '<p><a href="' + magicLink + '">Click here to access ' + NOTE_TITLE + "</a></p>" +
        "<p>This link expires in 5 minutes.</p>"
    );

    res.status(200).send(
      confirmationPage(
        "Access approved",
        "<strong>" + email + "</strong> has been approved. A sign-in link has been sent to their email."
      )
    );
    return;
  }

  // ---- deny (GET) ----
  if (action === "deny" && req.method === "GET") {
    const token = req.query.token;
    const payload = verifyJWT(token || "", secret);
    if (!payload || payload.action !== "deny" || !payload.jti) {
      res.status(401).send(confirmationPage("Invalid link", "This denial link is invalid or has expired."));
      return;
    }

    const email = await redisGet("approval:" + payload.jti);
    if (!email) {
      res.status(401).send(confirmationPage("Already used", "This denial link has already been used or has expired."));
      return;
    }
    await redisDel("approval:" + payload.jti);

    await sendEmail(
      email,
      "Access request for " + NOTE_TITLE,
      "<p>Your access request for <strong>" + NOTE_TITLE + "</strong> has been denied.</p>" +
        "<p>If you believe this is a mistake, please contact the publisher.</p>"
    );

    res.status(200).send(
      confirmationPage(
        "Access denied",
        "<strong>" + email + "</strong> has been denied access. A notification email has been sent."
      )
    );
    return;
  }

  // ---- access (GET) ----
  if (action === "access" && req.method === "GET") {
    const token = req.query.token;
    const payload = verifyJWT(token || "", secret);
    if (!payload || !payload.jti) {
      res.status(401).send("Invalid or expired link.");
      return;
    }

    const stored = await redisGet("link:" + payload.jti);
    if (!stored) {
      res.status(401).send("Link already used or expired.");
      return;
    }
    await redisDel("link:" + payload.jti);

    const sessionTTL = payload.longSession ? 2592000 : 604800;
    const sessionId = crypto.randomUUID();
    await redisSet("session:" + sessionId, payload.sub, sessionTTL);

    res.setHeader(
      "Set-Cookie",
      "session=" + sessionId + "; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=" + sessionTTL
    );
    res.writeHead(302, { Location: "/" });
    res.end();
    return;
  }

  // ---- content (GET) ----
  if (action === "content" && req.method === "GET") {
    const cookies = parseCookies(req);
    const sessionId = cookies.session;
    if (!sessionId) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }

    const email = await redisGet("session:" + sessionId);
    if (!email) {
      res.status(401).json({ error: "Session expired" });
      return;
    }

    const pageKey = req.query.page || "main";
    const html = PAGES[pageKey];
    if (!html) {
      res.status(404).json({ error: "Page not found" });
      return;
    }

    res.setHeader("Cache-Control", "no-store, private");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(html);
    return;
  }

  // ---- Unknown action ----
  res.status(400).json({ error: "Unknown action" });
};
`;
}

module.exports = { buildAuthFunction };
