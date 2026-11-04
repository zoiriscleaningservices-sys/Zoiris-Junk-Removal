/* command-center/assets/login.js */
(function () {
  const notice = document.getElementById('auth-notice');
  const loginForm = document.getElementById('login-form');
  const mfaFields = document.getElementById('mfa-fields');
  const setupForm = document.getElementById('setup-form');
  const recoveryPanel = document.getElementById('recovery-panel');
  const toggleRecovery = document.getElementById('toggle-recovery');
  const submitBtn = document.getElementById('login-submit');

  const params = new URLSearchParams(window.location.search);
  const nextUrl = params.get('next') && params.get('next').startsWith('/owner/') ? params.get('next') : '/owner/command-center/';

  function showMsg(text, kind) {
    notice.textContent = text;
    notice.className = 'cc-alert ' + (kind === 'error' ? 'cc-alert--error' : kind === 'warn' ? 'cc-alert--warn' : 'cc-alert--ok');
    notice.hidden = false;
  }

  fetch('/api/auth/status', { headers: { Accept: 'application/json' } })
    .then((r) => r.json())
    .then((st) => {
      if (st.authenticated) {
        window.location.replace(nextUrl);
        return;
      }
      if (st.needsInitialSetup) {
        if (st.setupSecretConfigured) {
          setupForm.hidden = false;
          loginForm.hidden = true;
        } else {
          showMsg(
            'No owner account is provisioned yet. Run `npm run owner:provision -- --email <you> --password <strong-pass>` on the server or configure OWNER_SETUP_SECRET.',
            'warn'
          );
        }
      }
    })
    .catch(() => {});

  function getDeviceHint() {
    let standalone = false;
    try {
      standalone = Boolean(window.matchMedia?.('(display-mode: standalone)')?.matches || window.navigator.standalone);
    } catch {}
    return {
      platform: String(navigator.userAgentData?.platform || navigator.platform || '').slice(0, 64),
      maxTouchPoints: Number(navigator.maxTouchPoints || 0),
      standalone
    };
  }

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    notice.hidden = true;
    submitBtn.disabled = true;
    try {
      const rememberEl = document.getElementById('login-remember');
      const payload = {
        email: document.getElementById('login-email').value.trim(),
        password: document.getElementById('login-password').value,
        totp: document.getElementById('login-totp').value.trim(),
        recoveryCode: document.getElementById('login-recovery').value.trim(),
        rememberDevice: rememberEl ? rememberEl.checked : true,
        deviceHint: getDeviceHint()
      };
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        showMsg(data.error || 'Authentication failed.', 'error');
        return;
      }
      if (data.mfaRequired) {
        mfaFields.hidden = false;
        document.getElementById('login-totp').focus();
        submitBtn.textContent = 'Verify Code & Sign In';
        return;
      }
      try {
        if (data.currentDevice) sessionStorage.setItem('zoiris_just_signed_in', data.currentDevice);
      } catch {}
      window.location.replace(nextUrl);
    } catch (_err) {
      showMsg('Unable to reach authentication service.', 'error');
    } finally {
      submitBtn.disabled = false;
    }
  });

  setupForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    notice.hidden = true;
    try {
      const res = await fetch('/api/auth/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          setupSecret: document.getElementById('setup-secret').value,
          displayName: document.getElementById('setup-name').value.trim(),
          email: document.getElementById('setup-email').value.trim(),
          password: document.getElementById('setup-password').value,
          deviceHint: getDeviceHint()
        })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        showMsg(data.error || 'Owner provisioning failed.', 'error');
        return;
      }
      try {
        if (data.currentDevice) sessionStorage.setItem('zoiris_just_signed_in', data.currentDevice);
      } catch {}
      window.location.replace('/owner/command-center/');
    } catch (_err) {
      showMsg('Provisioning request failed.', 'error');
    }
  });

  toggleRecovery.addEventListener('click', () => {
    recoveryPanel.hidden = !recoveryPanel.hidden;
    toggleRecovery.setAttribute('aria-expanded', recoveryPanel.hidden ? 'false' : 'true');
    if (!recoveryPanel.hidden) document.getElementById('rec-email').focus();
  });

  const pwToggle = document.getElementById('login-pw-toggle');
  if (pwToggle) {
    pwToggle.addEventListener('click', () => {
      const pw = document.getElementById('login-password');
      const show = pw.type === 'password';
      pw.type = show ? 'text' : 'password';
      pwToggle.textContent = show ? 'Hide' : 'Show';
      pwToggle.setAttribute('aria-pressed', show ? 'true' : 'false');
    });
  }

  document.getElementById('rec-request-btn').addEventListener('click', async () => {
    const email = document.getElementById('rec-email').value.trim();
    if (!email) return showMsg('Enter your owner email address first.', 'warn');
    const res = await fetch('/api/auth/recovery/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const data = await res.json();
    showMsg(data.message || 'Recovery request processed.', 'ok');
  });

  document.getElementById('rec-complete-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const res = await fetch('/api/auth/recovery/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: document.getElementById('rec-token').value.trim(),
        newPassword: document.getElementById('rec-new-pw').value
      })
    });
    const data = await res.json();
    if (!res.ok || !data.ok) return showMsg(data.error || 'Recovery failed.', 'error');
    recoveryPanel.hidden = true;
    showMsg('Password updated. Sign in with your new password.', 'ok');
  });
})();
