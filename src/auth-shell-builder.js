// auth-shell-builder.js — Login shell HTML for authenticated published pages.
// Returns a single HTML page that handles auth flow client-side, then fetches
// and injects the real content from the /api/auth endpoint.

const { CSS_TEMPLATE } = require("./html-builder");

// ─── CDN URLs (must match html-builder.js) ──────────────────────────
const HLJS_CSS   = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/atom-one-dark.min.css";
const HLJS_JS    = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/highlight.min.js";
const MERMAID_JS = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js";

// ─── Helpers ────────────────────────────────────────────────────────

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── Auth-specific CSS ──────────────────────────────────────────────

const AUTH_CSS = `
#auth-ui {
  max-width: 400px;
  margin: 2em auto;
  text-align: center;
}
#auth-ui .auth-input {
  width: 100%;
  padding: 0.6em 0.8em;
  margin-bottom: 0.8em;
  background: #2d2d2d;
  color: #dcddde;
  border: 1px solid #444;
  border-radius: 6px;
  font-size: 1em;
  outline: none;
}
#auth-ui .auth-input:focus {
  border-color: #a88bfa;
}
#auth-ui .auth-btn {
  display: inline-block;
  padding: 0.6em 1.4em;
  background: #a88bfa;
  color: #1e1e1e;
  border: none;
  border-radius: 6px;
  font-size: 1em;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
}
#auth-ui .auth-btn:hover {
  background: #9370f0;
}
#auth-ui .auth-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
#auth-ui .auth-msg {
  color: #888;
  font-size: 0.95em;
  margin: 1em 0;
}
#auth-ui .auth-msg.error {
  color: #e06c75;
}
`;

// ─── Builder ────────────────────────────────────────────────────────

function buildAuthShell(noteTitle) {
  const title = escapeHtml(noteTitle);

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${CSS_TEMPLATE}</style>
<style>${AUTH_CSS}</style>
<link rel="stylesheet" href="${HLJS_CSS}">
</head>
<body>
<div class="container">
  <h1>${title}</h1>
  <div id="auth-ui">
    <p class="auth-msg">Checking session...</p>
  </div>
  <div id="content" style="display:none"></div>
</div>

<script src="${HLJS_JS}"><\/script>
<script src="${MERMAID_JS}"><\/script>
<script>
(function() {
  var authUI  = document.getElementById('auth-ui');
  var content = document.getElementById('content');

  // ── Derive pageKey from URL ────────────────────────────────────
  var path = window.location.pathname.replace(/^\\//, '').replace(/\\.html$/, '');
  var pageKey = path || 'main';
  if (pageKey === 'index') pageKey = 'main';

  // ── State: email the user typed (persisted across states) ──────
  var currentEmail = '';

  // ── Renderers for each auth state ──────────────────────────────

  function showLoading() {
    authUI.innerHTML = '<p class="auth-msg">Checking session...</p>';
  }

  function showLoginForm() {
    authUI.innerHTML =
      '<input id="email-input" class="auth-input" type="email" placeholder="Email address" value="' + escapeAttr(currentEmail) + '">' +
      '<button id="send-link-btn" class="auth-btn">Send magic link</button>';

    document.getElementById('send-link-btn').addEventListener('click', handleSendLink);
    document.getElementById('email-input').addEventListener('keydown', function(e) {
      if (e.key === 'Enter') handleSendLink();
    });
  }

  function showLinkSent() {
    authUI.innerHTML = '<p class="auth-msg">Check your email for the login link.</p>';
  }

  function showNotApproved() {
    authUI.innerHTML =
      '<p class="auth-msg">Your account has not been approved yet.</p>' +
      '<button id="request-btn" class="auth-btn">Request access</button>';

    document.getElementById('request-btn').addEventListener('click', handleRequestAccess);
  }

  function showAccessRequested() {
    authUI.innerHTML = '<p class="auth-msg">Request sent, you\\u2019ll receive an email when approved.</p>';
  }

  function showError(msg) {
    authUI.innerHTML = '<p class="auth-msg error">' + escapeText(msg) + '</p>';
  }

  function showAuthenticated(html) {
    authUI.style.display = 'none';
    content.innerHTML = html;
    content.style.display = '';

    // Syntax highlighting
    try {
      document.querySelectorAll('#content pre code').forEach(function(el) {
        if (!el.classList.contains('language-mermaid')) hljs.highlightElement(el);
      });
    } catch(e) {}

    // Mermaid diagrams
    try {
      document.querySelectorAll('#content pre code.language-mermaid').forEach(function(el) {
        var div = document.createElement('div');
        div.className = 'mermaid';
        div.textContent = el.textContent;
        el.closest('pre').replaceWith(div);
      });
      mermaid.initialize({ startOnLoad: false, theme: 'dark' });
      mermaid.run();
    } catch(e) {}
  }

  // ── Escape helpers ─────────────────────────────────────────────

  function escapeAttr(s) {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function escapeText(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ── API helpers ────────────────────────────────────────────────

  function apiGet(url) {
    return fetch(url, { credentials: 'include' }).then(function(r) {
      return r.text().then(function(body) {
        return { status: r.status, body: body };
      });
    });
  }

  function apiPost(url, data) {
    return fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    }).then(function(r) { return r.json(); });
  }

  // ── Action handlers ────────────────────────────────────────────

  function handleSendLink() {
    var input = document.getElementById('email-input');
    var email = (input && input.value || '').trim();
    if (!email) return;
    currentEmail = email;

    var btn = document.getElementById('send-link-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Sending...'; }

    apiPost('/api/auth', { action: 'send-link', email: email })
      .then(function(data) {
        if (data.status === 'sent') {
          showLinkSent();
        } else if (data.status === 'not_approved') {
          showNotApproved();
        } else {
          showError('Unexpected response. Please try again.');
        }
      })
      .catch(function() {
        showError('Network error. Please try again.');
      });
  }

  function handleRequestAccess() {
    var btn = document.getElementById('request-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Sending...'; }

    apiPost('/api/auth', { action: 'request-access', email: currentEmail })
      .then(function(data) {
        if (data.status === 'requested') {
          showAccessRequested();
        } else {
          showError('Unexpected response. Please try again.');
        }
      })
      .catch(function() {
        showError('Network error. Please try again.');
      });
  }

  // ── Boot: check session then show correct state ────────────────

  showLoading();

  apiGet('/api/auth?action=content&page=' + encodeURIComponent(pageKey))
    .then(function(res) {
      if (res.status === 200) {
        showAuthenticated(res.body);
      } else {
        showLoginForm();
      }
    })
    .catch(function() {
      showLoginForm();
    });
})();
<\/script>
</body>
</html>`;
}

module.exports = { buildAuthShell };
