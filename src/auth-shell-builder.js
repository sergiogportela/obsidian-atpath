// auth-shell-builder.js — Login shell HTML for authenticated published pages.
// Uses Clerk JS SDK for authentication, then fetches content from /api/auth.

const { CSS_TEMPLATE } = require("./html-builder");
const { buildSiteIconHeadHtml } = require("./site-icon");

// ─── Helpers ────────────────────────────────────────────────────────

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── Builder ────────────────────────────────────────────────────────

function buildAuthShell(noteTitle, clerkPublishableKey, publisherEmail, publisherWhatsapp, siteIconDataUrl) {
  const title = escapeHtml(noteTitle);
  const pubKeyJSON = JSON.stringify(clerkPublishableKey);
  const publisherEmailJSON = JSON.stringify(publisherEmail || "");
  const publisherWhatsappJSON = JSON.stringify(publisherWhatsapp || "");
  const siteIconHead = buildSiteIconHeadHtml(siteIconDataUrl);

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${CSS_TEMPLATE}</style>
${siteIconHead}
</head>
<body>
<div class="container">
  <h1>${title}</h1>
  <div id="auth-ui">
    <p id="auth-msg" style="text-align:center;color:#888">Carregando...</p>
  </div>
</div>

<script>
(async function() {
  var authUI  = document.getElementById('auth-ui');
  var authMsg = document.getElementById('auth-msg');
  var publishableKey = ${pubKeyJSON};
  var publisherEmail = ${publisherEmailJSON};
  var publisherWhatsapp = ${publisherWhatsappJSON};
  var pollTimer = null;

  // Derive pageKey from URL
  var path = window.location.pathname.replace(/^\\//, '').replace(/\\.html?$/, '');
  var pageKey = path || 'main';
  if (pageKey === 'index') pageKey = 'main';

  // Load Clerk JS SDK — data-clerk-publishable-key triggers auto-init of window.Clerk
  var script = document.createElement('script');
  script.src = 'https://cdn.jsdelivr.net/npm/@clerk/clerk-js@5/dist/clerk.browser.js';
  script.crossOrigin = 'anonymous';
  script.setAttribute('data-clerk-publishable-key', publishableKey);
  script.onload = function() {
    initClerk().catch(function(e) {
      authMsg.style.display = '';
      authMsg.textContent = 'Erro de autentica\\u00e7\\u00e3o: ' + (e.message || e);
    });
  };
  script.onerror = function() { authMsg.textContent = 'Falha ao carregar autentica\\u00e7\\u00e3o.'; };
  document.head.appendChild(script);

  function fallbackCopy(text, btn) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); btn.textContent = 'Copiado!'; } catch(e) { btn.textContent = 'Falha ao copiar'; }
    document.body.removeChild(ta);
  }

  function showContent(html) {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    document.open();
    document.write(html);
    document.close();
  }

  function startApprovalPoll(clerk) {
    if (pollTimer) return;
    pollTimer = setInterval(async function() {
      try {
        var session = clerk.session;
        if (!session) return;
        var t = await session.getToken();
        var r = await fetch('/api/auth?page=' + encodeURIComponent(pageKey), {
          headers: { 'Authorization': 'Bearer ' + t }
        });
        if (r.status === 200) {
          var html = await r.text();
          showContent(html);
        }
      } catch(e) {}
    }, 15000);
  }

  async function fetchContent(clerk) {
    authMsg.textContent = 'Verificando acesso...';
    authMsg.style.display = '';

    var session = clerk.session;
    if (!session) {
      authMsg.textContent = 'Sess\\u00e3o inativa. Atualize a p\\u00e1gina e entre novamente.';
      return;
    }

    var token;
    try {
      token = await session.getToken();
    } catch(e) {
      authMsg.textContent = 'Falha ao obter token de sess\\u00e3o.';
      return;
    }

    var resp;
    try {
      resp = await fetch('/api/auth?page=' + encodeURIComponent(pageKey), {
        headers: { 'Authorization': 'Bearer ' + token }
      });
    } catch(e) {
      authMsg.textContent = 'Erro de rede. Tente novamente.';
      return;
    }

    if (resp.status === 200) {
      var html = await resp.text();
      showContent(html);
    } else if (resp.status === 403) {
      var body;
      try { body = await resp.json(); } catch(e) { body = {}; }
      var approvalUrl = body.approvalUrl || '';
      var siteUrl = approvalUrl ? new URL(approvalUrl).origin : '';
      var email = (clerk.user.primaryEmailAddress && clerk.user.primaryEmailAddress.emailAddress) || '';
      var subject = encodeURIComponent('Solicita\\u00e7\\u00e3o de acesso');
      var mailBody = encodeURIComponent('Ol\\u00e1, gostaria de ter acesso a ' + siteUrl + '\\n\\nMeu email: ' + email + (approvalUrl ? '\\n\\nAprovar: ' + approvalUrl : ''));
      authMsg.textContent = 'Voc\\u00ea n\\u00e3o tem acesso a esta p\\u00e1gina.';

      var wrapper = document.createElement('div');
      wrapper.style.cssText = 'text-align:center;margin-top:1em;';

      // Primary: WhatsApp button (when publisherWhatsapp + approvalUrl available)
      if (publisherWhatsapp && approvalUrl) {
        var waText = encodeURIComponent('Ol\\u00e1, gostaria de ter acesso a ' + siteUrl + '\\n\\nMeu email: ' + email + '\\n\\nAprovar: ' + approvalUrl);
        var waBtn = document.createElement('a');
        waBtn.href = 'https://wa.me/' + publisherWhatsapp + '?text=' + waText;
        waBtn.target = '_blank';
        waBtn.rel = 'noopener';
        waBtn.textContent = 'Solicitar acesso via WhatsApp';
        waBtn.style.cssText = 'display:inline-block;padding:0.6em 1.4em;background:#25D366;color:#fff;border-radius:6px;font-weight:600;text-decoration:none;font-size:1em;';
        wrapper.appendChild(waBtn);
      }

      // Fallback: copy + mailto (when publisherEmail available)
      if (publisherEmail) {
        var emailLabel = document.createElement('p');
        emailLabel.style.cssText = 'color:#888;font-size:0.9em;margin-top:1em;margin-bottom:0.5em;';
        emailLabel.textContent = 'Entre em contato: ' + publisherEmail;
        wrapper.appendChild(emailLabel);

        var copyText = 'Ol\\u00e1, gostaria de ter acesso a ' + siteUrl + '\\n\\nMeu email: ' + email + (approvalUrl ? '\\n\\nAprovar: ' + approvalUrl : '');
        var copyBtn = document.createElement('button');
        copyBtn.textContent = 'Copiar solicita\\u00e7\\u00e3o';
        copyBtn.style.cssText = 'display:inline-block;padding:0.6em 1.4em;background:#a88bfa;color:#1e1e1e;border-radius:6px;font-weight:600;border:none;cursor:pointer;font-size:1em;';
        copyBtn.addEventListener('click', function() {
          try {
            navigator.clipboard.writeText(copyText).then(function() {
              copyBtn.textContent = 'Copiado!';
            }, function() {
              fallbackCopy(copyText, copyBtn);
            });
          } catch(e) {
            fallbackCopy(copyText, copyBtn);
          }
        });
        wrapper.appendChild(copyBtn);

        var mailLink = document.createElement('a');
        mailLink.href = 'mailto:' + publisherEmail + '?subject=' + subject + '&body=' + mailBody;
        mailLink.textContent = 'Abrir cliente de email';
        mailLink.style.cssText = 'display:block;margin-top:0.75em;font-size:0.85em;color:#888;text-decoration:underline;';
        wrapper.appendChild(mailLink);
      }

      if (wrapper.children.length > 0) {
        authUI.appendChild(wrapper);
      }

      // Auto-poll: check every 15s if user has been approved
      var pollStatus = document.createElement('p');
      pollStatus.style.cssText = 'text-align:center;color:#888;font-size:0.8em;margin-top:1.2em;';
      pollStatus.textContent = 'Aguardando aprova\\u00e7\\u00e3o...';
      authUI.appendChild(pollStatus);
      startApprovalPoll(clerk);
    } else {
      authMsg.textContent = 'Autentica\\u00e7\\u00e3o falhou. Atualize a p\\u00e1gina e tente novamente.';
    }
  }

  async function initClerk() {
    var clerk = window.Clerk;
    if (!clerk) { authMsg.textContent = 'Falha ao inicializar autentica\\u00e7\\u00e3o.'; return; }
    await clerk.load({
      localization: {
        socialButtonsBlockButton: 'Continuar com {{provider|titleize}}',
        dividerText: 'ou',
        formButtonPrimary: 'Continuar',
        formFieldLabel__emailAddress: 'Endere\\u00e7o de e-mail',
        formFieldLabel__firstName: 'Primeiro nome',
        formFieldLabel__lastName: 'Sobrenome',
        formFieldLabel__password: 'Senha',
        formFieldInputPlaceholder__emailAddress: 'Digite seu e-mail',
        formFieldInputPlaceholder__firstName: 'Primeiro nome',
        formFieldInputPlaceholder__lastName: 'Sobrenome',
        formFieldInputPlaceholder__password: 'Digite sua senha',
        signUp: {
          start: {
            title: 'Criar sua conta',
            subtitle: 'Bem-vindo! Preencha os dados para continuar.',
            actionText: 'J\\u00e1 possui uma conta?',
            actionLink: 'Entrar',
          },
          emailCode: {
            title: 'Verifique seu e-mail',
            subtitle: 'para continuar',
            formTitle: 'C\\u00f3digo de verifica\\u00e7\\u00e3o',
            formSubtitle: 'Insira o c\\u00f3digo enviado para seu e-mail',
            resendButton: 'N\\u00e3o recebeu? Reenviar c\\u00f3digo',
          },
        },
        signIn: {
          start: {
            title: 'Entrar',
            subtitle: 'Bem-vindo de volta!',
            actionText: 'N\\u00e3o possui uma conta?',
            actionLink: 'Cadastrar-se',
          },
        },
      }
    });

    if (clerk.user) {
      // Already signed in — fetch content directly
      await fetchContent(clerk);
    } else {
      // Mount sign-in component inline (no redirect loop)
      authMsg.style.display = 'none';
      var signInDiv = document.createElement('div');
      signInDiv.id = 'clerk-sign-in';
      authUI.appendChild(signInDiv);
      clerk.mountSignUp(signInDiv, { fallbackRedirectUrl: window.location.href });

      // Wait for sign-in to complete via listener
      await new Promise(function(resolve) {
        clerk.addListener(function(res) {
          if (res.user) resolve();
        });
      });

      // Clean up sign-in UI and fetch content
      signInDiv.remove();
      await fetchContent(clerk);
    }
  }
})();
<\/script>
</body>
</html>`;
}

module.exports = { buildAuthShell };
