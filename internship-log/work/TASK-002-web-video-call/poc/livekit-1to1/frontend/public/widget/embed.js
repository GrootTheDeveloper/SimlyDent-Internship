/**
 * SimlyDent visitor embed loader (Phase 2 PR-C).
 *
 * Clinic site snippet:
 *   <script
 *     src="https://YOUR_DOMAIN/widget/embed.js"
 *     data-site-key="pk_clinic_a"
 *     data-api-base="https://YOUR_DOMAIN"
 *     data-name="Phòng khám A"
 *     data-color="#0066cc"
 *     async></script>
 *
 * Session is created from the **parent** page so Origin is the clinic website.
 * Page load: floating button only. Iframe (+ LiveKit later) created on first open.
 */
(function () {
  'use strict';

  var script = document.currentScript;
  if (!script) {
    var scripts = document.getElementsByTagName('script');
    script = scripts[scripts.length - 1];
  }

  var siteKey = (script.getAttribute('data-site-key') || '').trim();
  var apiBase = (script.getAttribute('data-api-base') || '').trim().replace(/\/$/, '');
  var clinicName = script.getAttribute('data-name') || 'Tư vấn video';
  var color = script.getAttribute('data-color') || '#0066cc';
  var position = (script.getAttribute('data-position') || 'bottom-right').toLowerCase();

  if (!siteKey) {
    console.error('[SimlyDent embed] data-site-key is required');
    return;
  }

  // Default apiBase = origin of this script (SimlyDent host).
  if (!apiBase) {
    try {
      var u = new URL(script.src);
      apiBase = u.origin;
    } catch (e) {
      apiBase = window.location.origin;
    }
  }

  var FRAME_URL = apiBase + '/widget/frame.html';
  var NS = 'simlydent-embed';
  var open = false;
  var iframe = null;
  var panel = null;
  var launcher = null;
  var frameMounted = false;
  var sessionCache = null; // { accessToken, expiresAt, sessionId, clinicId }

  function storageKey(part) {
    return NS + ':' + siteKey + ':' + part;
  }

  function readParentSession() {
    try {
      var raw = sessionStorage.getItem(storageKey('session'));
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || !parsed.accessToken) return null;
      if (parsed.expiresAt && Date.parse(parsed.expiresAt) < Date.now() + 60_000) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function writeParentSession(session) {
    try {
      sessionStorage.setItem(storageKey('session'), JSON.stringify(session));
    } catch { /* private mode */ }
  }

  /** Inline SVG icons only — never system emoji (inconsistent across OS). */
  function svgIcon(paths, opts) {
    opts = opts || {};
    var sw = opts.strokeWidth || '1.75';
    var fill = opts.fill || 'none';
    return (
      '<svg viewBox="0 0 24 24" fill="' + fill + '" stroke="currentColor" stroke-width="' + sw + '" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>'
    );
  }

  var ICONS = {
    phone:
      '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.81.36 1.6.68 2.34a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.74.32 1.53.55 2.34.68A2 2 0 0 1 22 16.92z"/>',
    close:
      '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    wait:
      '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    live:
      '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.81.36 1.6.68 2.34a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.74.32 1.53.55 2.34.68A2 2 0 0 1 22 16.92z"/>' +
      '<circle cx="18.5" cy="5.5" r="2.2" fill="currentColor" stroke="none"/>'
  };

  var lastCallState = '';

  function setLauncherFace(mode) {
    if (!launcher) return;
    // mode: open | idle | waiting | live
    if (mode === 'open') {
      launcher.innerHTML = svgIcon(ICONS.close) + '<span>Đóng</span>';
      launcher.setAttribute('aria-label', 'Đóng cửa sổ gọi');
      launcher.classList.add('is-open');
      return;
    }
    launcher.classList.remove('is-open');
    if (mode === 'waiting') {
      launcher.innerHTML = svgIcon(ICONS.wait) + '<span>Đang chờ…</span>';
      launcher.setAttribute('aria-label', clinicName + ' — Đang chờ nhân viên');
      return;
    }
    if (mode === 'live') {
      launcher.innerHTML = svgIcon(ICONS.live) + '<span>Đang gọi</span>';
      launcher.setAttribute('aria-label', clinicName + ' — Đang trong cuộc gọi');
      return;
    }
    launcher.innerHTML = svgIcon(ICONS.phone) + '<span>Gọi tư vấn</span>';
    launcher.setAttribute('aria-label', clinicName + ' — Gọi tư vấn');
  }

  function refreshLauncherFromState() {
    if (open) {
      setLauncherFace('open');
      return;
    }
    if (lastCallState === 'Ringing' || lastCallState === 'Queued') {
      setLauncherFace('waiting');
    } else if (lastCallState === 'Accepted' || lastCallState === 'Connected') {
      setLauncherFace('live');
    } else {
      setLauncherFace('idle');
    }
  }

  function ensureStyles() {
    if (document.getElementById(NS + '-styles')) return;
    var style = document.createElement('style');
    style.id = NS + '-styles';
    style.textContent = [
      '#' + NS + '-launcher{',
      'position:fixed;z-index:2147483000;min-width:56px;height:52px;border-radius:9999px;',
      'border:none;cursor:pointer;box-shadow:0 8px 28px rgba(0,102,204,.32);',
      'color:#fff;font:400 14px/1 Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;',
      'letter-spacing:-0.02em;padding:0 18px;display:flex;align-items:center;justify-content:center;gap:8px;',
      'transition:transform .12s ease,box-shadow .12s ease,filter .12s ease;',
      '}',
      '#' + NS + '-launcher:hover{transform:translateY(-1px);filter:brightness(1.05);box-shadow:0 12px 32px rgba(0,102,204,.4);}',
      '#' + NS + '-launcher:active{transform:scale(0.98);}',
      '#' + NS + '-launcher.bottom-right{right:20px;bottom:20px;}',
      '#' + NS + '-launcher.bottom-left{left:20px;bottom:20px;}',
      '#' + NS + '-launcher svg{width:18px;height:18px;flex-shrink:0;display:block;}',
      '#' + NS + '-launcher span{line-height:1;white-space:nowrap;}',
      '#' + NS + '-launcher.is-open{padding:0 16px;}',
      '#' + NS + '-panel{',
      'position:fixed;z-index:2147483001;width:min(400px,calc(100vw - 24px));',
      'height:min(680px,calc(100vh - 100px));border-radius:22px;overflow:hidden;',
      'box-shadow:0 20px 50px rgba(0,0,0,.18);background:#ffffff;',
      'display:none;border:1px solid rgba(0,0,0,.08);',
      '}',
      '#' + NS + '-panel.open{display:block;}',
      '#' + NS + '-panel.bottom-right{right:20px;bottom:88px;}',
      '#' + NS + '-panel.bottom-left{left:20px;bottom:88px;}',
      '#' + NS + '-panel iframe{width:100%;height:100%;border:0;display:block;background:#f5f5f7;}',
      '@media (max-width:480px){',
      '#' + NS + '-panel{',
      'width:100vw;height:100vh;left:0!important;right:0!important;top:0!important;bottom:0!important;',
      'border-radius:0;max-height:none;',
      '}}'
    ].join('');
    document.head.appendChild(style);
  }

  function createUi() {
    ensureStyles();

    launcher = document.createElement('button');
    launcher.id = NS + '-launcher';
    launcher.type = 'button';
    launcher.className = position.indexOf('left') >= 0 ? 'bottom-left' : 'bottom-right';
    launcher.style.background = color;
    setLauncherFace('idle');
    launcher.addEventListener('click', togglePanel);

    // Panel shell only — iframe mounted lazily on first open (point 10).
    panel = document.createElement('div');
    panel.id = NS + '-panel';
    panel.className = position.indexOf('left') >= 0 ? 'bottom-left' : 'bottom-right';

    document.body.appendChild(panel);
    document.body.appendChild(launcher);
    window.addEventListener('message', onMessage);
  }

  function ensureFrame() {
    if (frameMounted && iframe) return;
    iframe = document.createElement('iframe');
    iframe.title = clinicName + ' video call';
    iframe.allow = 'camera; microphone; autoplay; display-capture';
    iframe.setAttribute('allowfullscreen', '');
    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
    iframe.src = FRAME_URL + '?siteKey=' + encodeURIComponent(siteKey);
    panel.appendChild(iframe);
    frameMounted = true;
  }

  function togglePanel() {
    open = !open;
    if (open) {
      ensureFrame();
      panel.classList.add('open');
      setLauncherFace('open');
      setTimeout(sendInit, 50);
    } else {
      panel.classList.remove('open');
      refreshLauncherFromState();
    }
  }

  function onMessage(event) {
    var data = event.data;
    if (!data || data.ns !== NS) return;
    // Only accept messages from our frame origin.
    try {
      if (event.origin !== new URL(apiBase).origin) return;
    } catch {
      return;
    }

    if (data.type === 'ready') {
      sendInit();
      return;
    }
    if (data.type === 'need-session') {
      ensureSession().then(function (session) {
        postToFrame({ type: 'session', session: session });
      }).catch(function (err) {
        postToFrame({ type: 'error', error: String(err && err.message ? err.message : err) });
      });
      return;
    }
    if (data.type === 'close') {
      if (open) togglePanel();
      return;
    }
    if (data.type === 'state') {
      lastCallState = data.state || '';
      refreshLauncherFromState();
    }
  }

  function postToFrame(payload) {
    if (!iframe || !iframe.contentWindow) return;
    var origin;
    try {
      origin = new URL(apiBase).origin;
    } catch {
      origin = '*';
    }
    iframe.contentWindow.postMessage(Object.assign({ ns: NS }, payload), origin);
  }

  function sendInit() {
    postToFrame({
      type: 'init',
      siteKey: siteKey,
      apiBase: apiBase,
      clinicName: clinicName,
      color: color,
      session: sessionCache || readParentSession()
    });
  }

  function ensureSession() {
    var cached = sessionCache || readParentSession();
    if (cached && cached.accessToken) {
      sessionCache = cached;
      return Promise.resolve(cached);
    }
    return fetch(apiBase + '/embed/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ siteKey: siteKey }),
      credentials: 'omit'
    }).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok) {
          throw new Error((body && body.error) || ('Session failed (' + res.status + ')'));
        }
        var session = {
          accessToken: body.accessToken,
          expiresAt: body.expiresAt,
          sessionId: body.sessionId,
          clinicId: body.clinicId,
          siteKey: body.siteKey || siteKey
        };
        sessionCache = session;
        writeParentSession(session);
        return session;
      });
    });
  }

  function boot() {
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', boot);
      return;
    }
    createUi();
  }

  boot();
})();
