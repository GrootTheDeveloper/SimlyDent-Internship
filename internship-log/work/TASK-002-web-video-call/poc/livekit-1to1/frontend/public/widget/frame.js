/**
 * Visitor call UI (Phase 2 PR-C lifecycle fix).
 * - Cancel/End clear local state only after backend terminal status.
 * - Media disconnect → reconnect pane + keep polling (not auto-Ended).
 * - After Accept → Ready pane; Join starts getUserMedia + LiveKit.
 * - LiveKit SDK loaded lazily on first Join.
 */
(function () {
  'use strict';

  var NS = 'simlydent-embed';
  var LIVEKIT_CDN = 'https://cdn.jsdelivr.net/npm/livekit-client@2.21.0/dist/livekit-client.umd.min.js';
  var parentOrigin = '*';
  var apiBase = '';
  var siteKey = '';
  var clinicName = 'Tư vấn video';
  var accessToken = '';
  var sessionId = '';
  var callId = '';
  var pollTimer = null;
  var room = null;
  var localTracks = [];
  var micEnabled = true;
  var camEnabled = true;
  var joining = false;
  var intentionalLeave = false;
  var livekitLoadPromise = null;
  /** idle | waiting | ready | media | reconnect | perm | ended | error */
  var uiState = 'idle';
  var lastServerStatus = '';

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    clinicName: $('clinicName'),
    statusLine: $('statusLine'),
    idlePane: $('idlePane'),
    waitPane: $('waitPane'),
    readyPane: $('readyPane'),
    mediaPane: $('mediaPane'),
    permPane: $('permPane'),
    reconnectPane: $('reconnectPane'),
    endedPane: $('endedPane'),
    errorPane: $('errorPane'),
    waitText: $('waitText'),
    waitMeta: $('waitMeta'),
    readyMeta: $('readyMeta'),
    reconnectMeta: $('reconnectMeta'),
    endedText: $('endedText'),
    errorText: $('errorText'),
    permText: $('permText'),
    mediaHint: $('mediaHint'),
    remoteVideo: $('remoteVideo'),
    localVideo: $('localVideo'),
    btnCall: $('btnCall'),
    btnCancel: $('btnCancel'),
    btnJoin: $('btnJoin'),
    btnEnd: $('btnEnd'),
    btnEndFromReady: $('btnEndFromReady'),
    btnEndFromPerm: $('btnEndFromPerm'),
    btnEndFromReconnect: $('btnEndFromReconnect'),
    btnRetryMedia: $('btnRetryMedia'),
    btnReconnect: $('btnReconnect'),
    btnAgain: $('btnAgain'),
    btnRetry: $('btnRetry'),
    btnClose: $('btnClose'),
    btnMic: $('btnMic'),
    btnCam: $('btnCam')
  };

  function storageKey(part) {
    return NS + ':' + siteKey + ':' + part;
  }

  function saveCallState() {
    if (!siteKey || !callId) return;
    try {
      sessionStorage.setItem(storageKey('call'), JSON.stringify({
        accessToken: accessToken,
        sessionId: sessionId,
        callId: callId
      }));
    } catch { /* ignore */ }
  }

  function clearCallState() {
    try { sessionStorage.removeItem(storageKey('call')); } catch { /* ignore */ }
  }

  function loadCallState() {
    try {
      var raw = sessionStorage.getItem(storageKey('call'));
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function postParent(payload) {
    if (!window.parent || window.parent === window) return;
    window.parent.postMessage(Object.assign({ ns: NS }, payload), parentOrigin || '*');
  }

  function showPane(name) {
    uiState = name;
    var map = {
      idle: els.idlePane,
      waiting: els.waitPane,
      ready: els.readyPane,
      media: els.mediaPane,
      reconnect: els.reconnectPane,
      perm: els.permPane,
      ended: els.endedPane,
      error: els.errorPane
    };
    Object.keys(map).forEach(function (k) {
      if (map[k]) map[k].classList.toggle('hidden', k !== name);
    });
  }

  function setStatus(text) {
    els.statusLine.textContent = text || '';
  }

  function setHardError(message) {
    stopPoll();
    disconnectMedia({ silent: true });
    clearCallState();
    callId = '';
    els.errorText.textContent = message || 'Có lỗi xảy ra.';
    showPane('error');
    setStatus('Lỗi');
    postParent({ type: 'state', state: 'Error' });
  }

  function setAccent(color) {
    if (color) document.documentElement.style.setProperty('--accent', color);
  }

  async function api(path, options) {
    options = options || {};
    var headers = Object.assign({ Accept: 'application/json' }, options.headers || {});
    if (accessToken) headers.Authorization = 'Bearer ' + accessToken;
    if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    var res = await fetch(apiBase + path, {
      method: options.method || 'GET',
      headers: headers,
      body: options.body,
      credentials: 'omit'
    });
    var body = null;
    var text = await res.text();
    if (text) {
      try { body = JSON.parse(text); } catch { body = { raw: text }; }
    }
    return { ok: res.ok, status: res.status, body: body };
  }

  function ensureSessionFromParent() {
    return new Promise(function (resolve, reject) {
      if (accessToken) {
        resolve({ accessToken: accessToken, sessionId: sessionId });
        return;
      }
      var done = false;
      function onMsg(ev) {
        if (!ev.data || ev.data.ns !== NS) return;
        if (ev.data.type === 'session' && ev.data.session) {
          done = true;
          window.removeEventListener('message', onMsg);
          applySession(ev.data.session);
          resolve(ev.data.session);
        } else if (ev.data.type === 'error') {
          done = true;
          window.removeEventListener('message', onMsg);
          reject(new Error(ev.data.error || 'Session error'));
        }
      }
      window.addEventListener('message', onMsg);
      postParent({ type: 'need-session' });
      setTimeout(function () {
        if (done) return;
        window.removeEventListener('message', onMsg);
        reject(new Error('Timeout waiting for embed session from parent page.'));
      }, 15000);
    });
  }

  function applySession(session) {
    if (!session) return;
    accessToken = session.accessToken || accessToken;
    sessionId = session.sessionId || sessionId;
  }

  function stopPoll() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function startPoll() {
    stopPoll();
    pollTimer = setInterval(function () {
      refreshCall().catch(function (err) {
        console.warn('[embed frame] poll', err);
      });
    }, 1500);
  }

  function isTerminal(status) {
    return status === 'Cancelled' || status === 'Rejected' || status === 'Timeout'
      || status === 'NoAgent' || status === 'Closed' || status === 'Ended';
  }

  function applyTerminal(status) {
    intentionalLeave = true;
    stopPoll();
    disconnectMedia({ silent: true });
    clearCallState();
    callId = '';
    lastServerStatus = status;
    els.endedText.textContent = endedMessage(status);
    showPane('ended');
    setStatus('Kết thúc');
    postParent({ type: 'state', state: status });
  }

  async function startCall() {
    els.btnCall.disabled = true;
    try {
      await ensureSessionFromParent();
      var res = await api('/embed/calls', { method: 'POST', body: '{}' });
      if (!res.ok) {
        throw new Error((res.body && res.body.error) || ('Create call failed (' + res.status + ')'));
      }
      callId = res.body.id;
      lastServerStatus = res.body.status;
      saveCallState();
      showWaiting(res.body);
      startPoll();
      postParent({ type: 'state', state: res.body.status || 'Queued' });
    } catch (err) {
      setHardError(err.message || String(err));
    } finally {
      els.btnCall.disabled = false;
    }
  }

  function showWaiting(call) {
    showPane('waiting');
    var status = (call && call.status) || 'Queued';
    if (status === 'Ringing') {
      els.waitText.textContent = 'Đang gọi nhân viên…';
      setStatus('Đang reo');
    } else {
      els.waitText.textContent = 'Đang xếp hàng…';
      setStatus('Chờ phục vụ');
    }
    var wait = call && typeof call.waitingSeconds === 'number' ? call.waitingSeconds : 0;
    els.waitMeta.textContent = wait > 0 ? ('Đã chờ ~' + wait + 's') : 'Vui lòng giữ tab này mở';
  }

  function showReady() {
    showPane('ready');
    setStatus('Sẵn sàng tham gia');
    els.readyMeta.textContent = 'Nhân viên đã Accept — bấm Tham gia khi bạn sẵn sàng.';
    postParent({ type: 'state', state: 'Accepted' });
  }

  async function refreshCall() {
    if (!callId || !accessToken) return;
    var res = await api('/embed/calls/' + callId);
    if (res.status === 401) {
      accessToken = '';
      await ensureSessionFromParent();
      res = await api('/embed/calls/' + callId);
    }
    if (res.status === 404) {
      applyTerminal('Ended');
      els.endedText.textContent = 'Cuộc gọi không còn tồn tại (hết hạn hoặc đã dọn).';
      return;
    }
    if (!res.ok) return;

    var status = res.body.status;
    lastServerStatus = status;
    postParent({ type: 'state', state: status });

    if (status === 'Queued' || status === 'Ringing') {
      if (uiState !== 'waiting') showWaiting(res.body);
      else showWaiting(res.body);
      return;
    }

    if (status === 'Accepted') {
      // Keep heartbeat. Do NOT auto joinMedia.
      if (uiState === 'media' && room) {
        setStatus('Đang tư vấn');
        return;
      }
      if (uiState === 'reconnect') {
        els.reconnectMeta.textContent = 'Backend vẫn Accepted — thử nối lại media.';
        return;
      }
      if (uiState === 'perm') return;
      if (uiState !== 'ready' && uiState !== 'media') showReady();
      return;
    }

    if (isTerminal(status)) {
      applyTerminal(status);
    }
  }

  function endedMessage(status) {
    switch (status) {
      case 'Cancelled': return 'Bạn đã hủy cuộc gọi.';
      case 'Rejected': return 'Nhân viên chưa thể nhận. Vui lòng gọi lại sau.';
      case 'Timeout': return 'Hết thời gian chờ. Vui lòng gọi lại.';
      case 'NoAgent': return 'Hiện không có nhân viên sẵn sàng.';
      case 'Closed': return 'Phòng khám đang đóng cửa.';
      case 'Ended': return 'Cuộc gọi đã kết thúc.';
      default: return 'Cuộc gọi đã kết thúc (' + status + ').';
    }
  }

  function loadLivekit() {
    if (window.LivekitClient && window.LivekitClient.Room) {
      return Promise.resolve(window.LivekitClient);
    }
    if (livekitLoadPromise) return livekitLoadPromise;
    livekitLoadPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = LIVEKIT_CDN;
      s.async = true;
      s.onload = function () {
        var lk = window.LivekitClient || window.LiveKit || window.livekit;
        if (lk && lk.Room) resolve(lk);
        else reject(new Error('LiveKit client failed to initialize.'));
      };
      s.onerror = function () {
        livekitLoadPromise = null;
        reject(new Error('Không tải được LiveKit SDK.'));
      };
      document.head.appendChild(s);
    });
    return livekitLoadPromise;
  }

  async function joinMedia() {
    if (joining || room) return;
    if (!callId) return;
    joining = true;
    intentionalLeave = false;
    showPane('media');
    setStatus('Đang kết nối');
    els.mediaHint.classList.remove('hidden');
    els.mediaHint.textContent = 'Đang tải media SDK…';

    try {
      var LivekitClient = await loadLivekit();
      els.mediaHint.textContent = 'Đang xin quyền camera / micro…';

      var tok = await api('/embed/calls/' + callId + '/token', { method: 'POST', body: '{}' });
      if (!tok.ok) {
        throw new Error((tok.body && tok.body.error) || ('Token failed (' + tok.status + ')'));
      }

      var createLocalTracks = LivekitClient.createLocalTracks;
      localTracks = await createLocalTracks({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: {
          facingMode: 'user',
          resolution: LivekitClient.VideoPresets
            ? LivekitClient.VideoPresets.h720.resolution
            : { width: 1280, height: 720, frameRate: 30 }
        }
      });

      var localVideoTrack = localTracks.find(function (t) { return t.kind === 'video'; });
      if (localVideoTrack) localVideoTrack.attach(els.localVideo);

      els.mediaHint.textContent = 'Đang vào phòng media…';
      room = new LivekitClient.Room({ adaptiveStream: true, dynacast: true });
      room.on(LivekitClient.RoomEvent.TrackSubscribed, function (track) {
        var kind = track.kind;
        var isVideo = kind === 'video' ||
          (LivekitClient.Track && kind === LivekitClient.Track.Kind.Video);
        if (isVideo) {
          track.attach(els.remoteVideo);
          els.mediaHint.classList.add('hidden');
          return;
        }
        var audioEl = track.attach();
        audioEl.autoplay = true;
        audioEl.setAttribute('playsinline', '');
        audioEl.style.display = 'none';
        document.body.appendChild(audioEl);
      });
      room.on(LivekitClient.RoomEvent.Disconnected, function () {
        onMediaDisconnected();
      });

      await room.connect(tok.body.url, tok.body.token);
      for (var i = 0; i < localTracks.length; i++) {
        await room.localParticipant.publishTrack(localTracks[i]);
      }

      setStatus('Đang tư vấn');
      els.mediaHint.classList.add('hidden');
      postParent({ type: 'state', state: 'Connected' });
      if (!pollTimer) startPoll();
      saveCallState();
    } catch (err) {
      console.error(err);
      disconnectMedia({ silent: true });
      // Keep call Accepted — offer retry / end (permission or join failure).
      els.permText.textContent = err.message || String(err);
      showPane('perm');
      setStatus('Cần camera/mic');
      if (!pollTimer) startPoll();
    } finally {
      joining = false;
    }
  }

  function onMediaDisconnected() {
    if (intentionalLeave) return;
    room = null;
    // Do not clear callId — 90s in-call stale / reconnect policy.
    showPane('reconnect');
    setStatus('Mất media');
    els.reconnectMeta.textContent = 'Giữ cuộc gọi, tiếp tục poll backend. Bấm nối lại khi mạng ổn định.';
    postParent({ type: 'state', state: 'Reconnect' });
    if (!pollTimer) startPoll();
  }

  function disconnectMedia(opts) {
    opts = opts || {};
    if (!opts.silent) intentionalLeave = true;
    try {
      if (room) room.disconnect();
    } catch { /* ignore */ }
    room = null;
    localTracks.forEach(function (t) {
      try { t.stop(); } catch { /* ignore */ }
    });
    localTracks = [];
    try {
      els.localVideo.srcObject = null;
      els.remoteVideo.srcObject = null;
    } catch { /* ignore */ }
  }

  /**
   * Cancel only clears local state when backend confirms terminal (Cancelled)
   * or when still Queued/Ringing response. 409 Accepted → show ready / keep call.
   */
  async function cancelCall() {
    if (!callId) {
      showPane('idle');
      return;
    }
    els.btnCancel.disabled = true;
    try {
      var res = await api('/embed/calls/' + callId + '/cancel', { method: 'POST', body: '{}' });
      if (res.ok && res.body && isTerminal(res.body.status)) {
        applyTerminal(res.body.status);
        return;
      }
      if (res.status === 409) {
        // Staff may have Accepted concurrently.
        lastServerStatus = (res.body && res.body.status) || lastServerStatus;
        if (lastServerStatus === 'Accepted' || (res.body && res.body.status === 'Accepted')) {
          showReady();
          if (!pollTimer) startPoll();
          els.waitMeta && (els.readyMeta.textContent = 'Không hủy được — nhân viên đã nhận cuộc gọi.');
          return;
        }
        // Re-poll truth
        await refreshCall();
        return;
      }
      if (!res.ok) {
        els.waitMeta.textContent = (res.body && res.body.error) || ('Hủy thất bại (' + res.status + ')');
        return;
      }
    } catch (err) {
      els.waitMeta.textContent = err.message || String(err);
    } finally {
      els.btnCancel.disabled = false;
    }
  }

  /**
   * End only finishes locally after backend Ended (or already terminal).
   */
  async function endCall() {
    if (!callId) {
      applyTerminal('Ended');
      return;
    }
    intentionalLeave = true;
    disconnectMedia({ silent: true });
    try {
      var res = await api('/embed/calls/' + callId + '/end', { method: 'POST', body: '{}' });
      if (res.ok && res.body && isTerminal(res.body.status)) {
        applyTerminal(res.body.status);
        return;
      }
      if (res.status === 409) {
        // Not Accepted yet — try cancel path
        var c = await api('/embed/calls/' + callId + '/cancel', { method: 'POST', body: '{}' });
        if (c.ok && c.body && isTerminal(c.body.status)) {
          applyTerminal(c.body.status);
          return;
        }
      }
      // Keep call; re-sync
      intentionalLeave = false;
      if (!pollTimer) startPoll();
      await refreshCall();
      els.readyMeta && (els.readyMeta.textContent = (res.body && res.body.error) || 'Kết thúc chưa xác nhận — đang đồng bộ…');
    } catch (err) {
      intentionalLeave = false;
      if (!pollTimer) startPoll();
      console.warn(err);
    }
  }

  function toggleMic() {
    micEnabled = !micEnabled;
    if (room && room.localParticipant) {
      try { room.localParticipant.setMicrophoneEnabled(micEnabled); } catch { /* ignore */ }
    }
    els.btnMic.classList.toggle('off', !micEnabled);
    els.btnMic.textContent = micEnabled ? 'Mic' : 'Mic off';
  }

  function toggleCam() {
    camEnabled = !camEnabled;
    if (room && room.localParticipant) {
      try { room.localParticipant.setCameraEnabled(camEnabled); } catch { /* ignore */ }
    }
    els.btnCam.classList.toggle('off', !camEnabled);
    els.btnCam.textContent = camEnabled ? 'Cam' : 'Cam off';
  }

  function resetIdle() {
    intentionalLeave = true;
    stopPoll();
    disconnectMedia({ silent: true });
    callId = '';
    clearCallState();
    lastServerStatus = '';
    showPane('idle');
    setStatus('Sẵn sàng');
    postParent({ type: 'state', state: 'Idle' });
  }

  async function tryResume() {
    var saved = loadCallState();
    if (!saved || !saved.callId || !saved.accessToken) return false;
    accessToken = saved.accessToken;
    sessionId = saved.sessionId || sessionId;
    callId = saved.callId;
    showWaiting({ status: 'Queued', waitingSeconds: 0 });
    startPoll();
    try {
      await refreshCall();
      return true;
    } catch {
      // Keep token; drop call only if poll proves gone (refreshCall handles 404).
      return false;
    }
  }

  function onParentMessage(event) {
    var data = event.data;
    if (!data || data.ns !== NS) return;
    if (data.type === 'init') {
      parentOrigin = event.origin || parentOrigin;
      siteKey = data.siteKey || siteKey;
      apiBase = (data.apiBase || apiBase || '').replace(/\/$/, '');
      clinicName = data.clinicName || clinicName;
      els.clinicName.textContent = clinicName;
      setAccent(data.color);
      if (data.session) applySession(data.session);
      tryResume();
      return;
    }
    if (data.type === 'session' && data.session) applySession(data.session);
  }

  els.btnCall.addEventListener('click', startCall);
  els.btnCancel.addEventListener('click', cancelCall);
  els.btnJoin.addEventListener('click', joinMedia);
  els.btnRetryMedia.addEventListener('click', joinMedia);
  els.btnReconnect.addEventListener('click', joinMedia);
  els.btnEnd.addEventListener('click', endCall);
  els.btnEndFromReady.addEventListener('click', endCall);
  els.btnEndFromPerm.addEventListener('click', endCall);
  els.btnEndFromReconnect.addEventListener('click', endCall);
  els.btnAgain.addEventListener('click', resetIdle);
  els.btnRetry.addEventListener('click', resetIdle);
  els.btnClose.addEventListener('click', function () { postParent({ type: 'close' }); });
  els.btnMic.addEventListener('click', toggleMic);
  els.btnCam.addEventListener('click', toggleCam);

  window.addEventListener('message', onParentMessage);
  try {
    var params = new URLSearchParams(window.location.search);
    siteKey = params.get('siteKey') || siteKey;
  } catch { /* ignore */ }

  postParent({ type: 'ready' });
  showPane('idle');
  setStatus('Sẵn sàng');
})();
