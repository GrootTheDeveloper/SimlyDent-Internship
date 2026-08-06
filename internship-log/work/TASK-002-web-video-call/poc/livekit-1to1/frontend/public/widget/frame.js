/**
 * Visitor call UI inside iframe (Phase 2 PR-C).
 * Parent creates session (clinic Origin); this frame owns call poll + media after Accept.
 */
(function () {
  'use strict';

  var NS = 'simlydent-embed';
  var parentOrigin = '*';
  var apiBase = '';
  var siteKey = '';
  var clinicName = 'Tư vấn video';
  var accent = '#0d9488';
  var accessToken = '';
  var sessionId = '';
  var callId = '';
  var pollTimer = null;
  var room = null;
  var localTracks = [];
  var micEnabled = true;
  var camEnabled = true;
  var joining = false;
  var uiState = 'idle'; // idle | waiting | media | ended | error

  var $ = function (id) { return document.getElementById(id); };

  var els = {
    clinicName: $('clinicName'),
    statusLine: $('statusLine'),
    idlePane: $('idlePane'),
    waitPane: $('waitPane'),
    mediaPane: $('mediaPane'),
    endedPane: $('endedPane'),
    errorPane: $('errorPane'),
    waitText: $('waitText'),
    waitMeta: $('waitMeta'),
    endedText: $('endedText'),
    errorText: $('errorText'),
    mediaHint: $('mediaHint'),
    remoteVideo: $('remoteVideo'),
    localVideo: $('localVideo'),
    btnCall: $('btnCall'),
    btnCancel: $('btnCancel'),
    btnEnd: $('btnEnd'),
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
    if (!siteKey) return;
    try {
      sessionStorage.setItem(storageKey('call'), JSON.stringify({
        accessToken: accessToken,
        sessionId: sessionId,
        callId: callId,
        expiresHint: Date.now() + 120 * 60 * 1000
      }));
    } catch { /* ignore */ }
  }

  function clearCallState() {
    try { sessionStorage.removeItem(storageKey('call')); } catch { /* ignore */ }
  }

  function loadCallState() {
    try {
      var raw = sessionStorage.getItem(storageKey('call'));
      if (!raw) return null;
      return JSON.parse(raw);
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
    els.idlePane.classList.toggle('hidden', name !== 'idle');
    els.waitPane.classList.toggle('hidden', name !== 'waiting');
    els.mediaPane.classList.toggle('hidden', name !== 'media');
    els.endedPane.classList.toggle('hidden', name !== 'ended');
    els.errorPane.classList.toggle('hidden', name !== 'error');
  }

  function setStatus(text) {
    els.statusLine.textContent = text || '';
  }

  function setError(message) {
    stopPoll();
    disconnectMedia();
    els.errorText.textContent = message || 'Có lỗi xảy ra.';
    showPane('error');
    setStatus('Lỗi');
    postParent({ type: 'state', state: 'Error' });
  }

  function setAccent(color) {
    if (!color) return;
    accent = color;
    document.documentElement.style.setProperty('--accent', color);
  }

  async function api(path, options) {
    options = options || {};
    var headers = Object.assign({
      Accept: 'application/json'
    }, options.headers || {});
    if (accessToken) headers.Authorization = 'Bearer ' + accessToken;
    if (options.body && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
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

  async function startCall() {
    els.btnCall.disabled = true;
    try {
      await ensureSessionFromParent();
      var res = await api('/embed/calls', { method: 'POST', body: '{}' });
      if (!res.ok) {
        throw new Error((res.body && res.body.error) || ('Create call failed (' + res.status + ')'));
      }
      callId = res.body.id;
      saveCallState();
      showWaiting(res.body);
      startPoll();
      postParent({ type: 'state', state: res.body.status || 'Queued' });
    } catch (err) {
      setError(err.message || String(err));
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

  async function refreshCall() {
    if (!callId || !accessToken) return;
    var res = await api('/embed/calls/' + callId);
    if (res.status === 401) {
      accessToken = '';
      await ensureSessionFromParent();
      res = await api('/embed/calls/' + callId);
    }
    if (res.status === 404) {
      clearCallState();
      callId = '';
      stopPoll();
      setError('Cuộc gọi không còn tồn tại (hết hạn hoặc đã dọn).');
      return;
    }
    if (!res.ok) return;

    var status = res.body.status;
    postParent({ type: 'state', state: status });

    if (status === 'Queued' || status === 'Ringing') {
      showWaiting(res.body);
      return;
    }
    if (status === 'Accepted') {
      if (uiState !== 'media' && !joining && !room) {
        await joinMedia();
      } else if (uiState === 'media') {
        // Heartbeat only while connected.
        setStatus('Đang tư vấn');
      }
      return;
    }
    if (status === 'Cancelled' || status === 'Rejected' || status === 'Timeout' ||
        status === 'NoAgent' || status === 'Closed' || status === 'Ended') {
      stopPoll();
      disconnectMedia();
      clearCallState();
      callId = '';
      els.endedText.textContent = endedMessage(status);
      showPane('ended');
      setStatus('Kết thúc');
      postParent({ type: 'state', state: status });
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

  async function joinMedia() {
    if (joining || room) return;
    joining = true;
    showPane('media');
    setStatus('Đang kết nối');
    els.mediaHint.classList.remove('hidden');
    els.mediaHint.textContent = 'Đang xin quyền camera / micro…';

    try {
      // getUserMedia only after Accept (via createLocalTracks).
      var LivekitClient = window.LivekitClient || window.LiveKit || window.livekit;
      if (!LivekitClient || !LivekitClient.Room) {
        throw new Error('LiveKit client failed to load. Check CDN / network.');
      }

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
      if (localVideoTrack) {
        localVideoTrack.attach(els.localVideo);
      }

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
        finishEnded('Ended');
      });

      await room.connect(tok.body.url, tok.body.token);
      for (var i = 0; i < localTracks.length; i++) {
        await room.localParticipant.publishTrack(localTracks[i]);
      }

      setStatus('Đang tư vấn');
      els.mediaHint.classList.add('hidden');
      postParent({ type: 'state', state: 'Connected' });
      // Keep polling as in-call heartbeat (VisitorLastSeenAt).
      if (!pollTimer) startPoll();
    } catch (err) {
      console.error(err);
      setError(err.message || String(err));
    } finally {
      joining = false;
    }
  }

  function disconnectMedia() {
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

  async function cancelCall() {
    stopPoll();
    if (callId && accessToken) {
      try {
        await api('/embed/calls/' + callId + '/cancel', { method: 'POST', body: '{}' });
      } catch { /* ignore */ }
    }
    clearCallState();
    callId = '';
    disconnectMedia();
    els.endedText.textContent = 'Bạn đã hủy cuộc gọi.';
    showPane('ended');
    setStatus('Đã hủy');
    postParent({ type: 'state', state: 'Cancelled' });
  }

  async function endCall() {
    stopPoll();
    disconnectMedia();
    if (callId && accessToken) {
      try {
        await api('/embed/calls/' + callId + '/end', { method: 'POST', body: '{}' });
      } catch { /* ignore */ }
    }
    finishEnded('Ended');
  }

  function finishEnded(status) {
    stopPoll();
    disconnectMedia();
    clearCallState();
    callId = '';
    els.endedText.textContent = endedMessage(status);
    showPane('ended');
    setStatus('Kết thúc');
    postParent({ type: 'state', state: status });
  }

  function toggleMic() {
    micEnabled = !micEnabled;
    localTracks.forEach(function (t) {
      if (t.kind === 'audio') {
        try { t.mute = !micEnabled ? true : false; } catch { /* ignore */ }
        try { if (typeof t.setEnabled === 'function') t.setEnabled(micEnabled); } catch { /* ignore */ }
      }
    });
    if (room && room.localParticipant) {
      try {
        room.localParticipant.setMicrophoneEnabled(micEnabled);
      } catch { /* ignore */ }
    }
    els.btnMic.classList.toggle('off', !micEnabled);
    els.btnMic.textContent = micEnabled ? 'Mic' : 'Mic off';
  }

  function toggleCam() {
    camEnabled = !camEnabled;
    if (room && room.localParticipant) {
      try {
        room.localParticipant.setCameraEnabled(camEnabled);
      } catch { /* ignore */ }
    }
    localTracks.forEach(function (t) {
      if (t.kind === 'video' && typeof t.setEnabled === 'function') {
        try { t.setEnabled(camEnabled); } catch { /* ignore */ }
      }
    });
    els.btnCam.classList.toggle('off', !camEnabled);
    els.btnCam.textContent = camEnabled ? 'Cam' : 'Cam off';
  }

  function resetIdle() {
    stopPoll();
    disconnectMedia();
    callId = '';
    clearCallState();
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
      clearCallState();
      callId = '';
      accessToken = saved.accessToken; // keep token if still good
      showPane('idle');
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
      // Resume after reload if we still own an active call.
      tryResume();
      return;
    }
    if (data.type === 'session' && data.session) {
      applySession(data.session);
    }
  }

  // Wire UI
  els.btnCall.addEventListener('click', startCall);
  els.btnCancel.addEventListener('click', cancelCall);
  els.btnEnd.addEventListener('click', endCall);
  els.btnAgain.addEventListener('click', resetIdle);
  els.btnRetry.addEventListener('click', resetIdle);
  els.btnClose.addEventListener('click', function () {
    postParent({ type: 'close' });
  });
  els.btnMic.addEventListener('click', toggleMic);
  els.btnCam.addEventListener('click', toggleCam);

  window.addEventListener('message', onParentMessage);

  // Parse siteKey from query for early storage keying.
  try {
    var params = new URLSearchParams(window.location.search);
    siteKey = params.get('siteKey') || siteKey;
  } catch { /* ignore */ }

  // Tell parent we are ready (and compute expected parent origin later from init).
  postParent({ type: 'ready' });
  showPane('idle');
  setStatus('Sẵn sàng');
})();
