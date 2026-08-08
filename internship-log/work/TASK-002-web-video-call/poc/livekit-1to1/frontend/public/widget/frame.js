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
  var camEnabled = false;
  var joining = false;
  var retryingDevices = false;
  var intentionalLeave = false;
  var livekitLoadPromise = null;
  var hasLocalVideo = false;
  var hasLocalAudio = false;
  /** Remote staff currently has an unmuted video track attached */
  var remoteHasVideo = false;
  /** Join preference only: 'video' | 'audio' — not a runtime session mode */
  var preferredMedia = 'video';
  /** Local desired camera after connect / reconnect (independent of peer). */
  var desiredCameraEnabled = true;
  /** After first successful LiveKit connect — reconnect must not reset from preferredMedia. */
  var mediaSessionStarted = false;
  /** Camera request FSM: idle | sent | received | accepted | rejected | expired */
  var cameraRequestState = 'idle';
  var cameraRequestBusy = false;
  var callSeconds = 0;
  var callTimer = null;
  /** Visitor graceful End: keep LiveKit camera until backend Status=Ended */
  var gracefulEnding = false;
  var endingBusy = false;

  /** @shared-pair src/domain/media/media-primitives.js via window.SimlyDentMediaPrimitives */
  function mediaP() {
    return (typeof window !== 'undefined' && window.SimlyDentMediaPrimitives) || null;
  }
  function mediaModeApi() {
    return (typeof window !== 'undefined' && window.SimlyDentMediaMode) || null;
  }

  /** idle | waiting | media | reconnect | perm | ended | error */
  var uiState = 'idle';
  var lastServerStatus = '';

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    clinicName: $('clinicName'),
    statusLine: $('statusLine'),
    idlePane: $('idlePane'),
    waitPane: $('waitPane'),
    mediaPane: $('mediaPane'),
    permPane: $('permPane'),
    reconnectPane: $('reconnectPane'),
    endedPane: $('endedPane'),
    errorPane: $('errorPane'),
    waitText: $('waitText'),
    waitMeta: $('waitMeta'),
    reconnectMeta: $('reconnectMeta'),
    endedText: $('endedText'),
    errorText: $('errorText'),
    permText: $('permText'),
    mediaHint: $('mediaHint'),
    deviceBanner: $('deviceBanner'),
    remoteVideo: $('remoteVideo'),
    localVideo: $('localVideo'),
    localSample: $('localSample'),
    btnCall: $('btnCall'),
    btnCallVideo: $('btnCallVideo'),
    btnCallAudio: $('btnCallAudio'),
    btnCancel: $('btnCancel'),
    btnEnd: $('btnEnd'),
    btnEndFromPerm: $('btnEndFromPerm'),
    btnEndFromReconnect: $('btnEndFromReconnect'),
    btnRetryMedia: $('btnRetryMedia'),
    btnRetryDevices: $('btnRetryDevices'),
    btnReconnect: $('btnReconnect'),
    btnAgain: $('btnAgain'),
    btnRetry: $('btnRetry'),
    btnClose: $('btnClose'),
    btnMic: $('btnMic'),
    btnCam: $('btnCam'),
    videoStage: $('videoStage'),
    voiceStage: $('voiceStage'),
    voiceKindLabel: $('voiceKindLabel'),
    voiceDuration: $('voiceDuration'),
    voiceConnHint: $('voiceConnHint'),
    voiceHint: $('voiceHint'),
    voicePeerName: $('voicePeerName'),
    remotePlaceholder: $('remotePlaceholder'),
    remotePlaceholderText: $('remotePlaceholderText'),
    audioSessionPanel: $('audioSessionPanel'),
    mediaModeBanner: $('mediaModeBanner'),
    mediaModeBannerText: $('mediaModeBannerText'),
    btnAcceptVideo: $('btnAcceptVideo'),
    btnRejectVideo: $('btnRejectVideo'),
    btnToVideo: $('btnToVideo'),
    btnToAudio: $('btnToAudio')
  };

  function formatDuration(sec) {
    var s = Math.max(0, sec | 0);
    var m = Math.floor(s / 60);
    var r = s % 60;
    return m + ':' + (r < 10 ? '0' : '') + r;
  }

  function startCallTimer() {
    stopCallTimer();
    callSeconds = 0;
    if (els.voiceDuration) els.voiceDuration.textContent = '0:00';
    callTimer = setInterval(function () {
      callSeconds += 1;
      if (els.voiceDuration) els.voiceDuration.textContent = formatDuration(callSeconds);
    }, 1000);
  }

  function stopCallTimer() {
    if (callTimer) {
      clearInterval(callTimer);
      callTimer = null;
    }
  }

  /**
   * Local camera track from LiveKit publications (authoritative after setCameraEnabled)
   * or from initial localTracks acquire.
   */
  function getLocalCameraTrack() {
    if (room && room.localParticipant) {
      var pubs = room.localParticipant.videoTrackPublications;
      if (pubs && typeof pubs.values === 'function') {
        var it = pubs.values();
        var n = it.next();
        while (!n.done) {
          var pub = n.value;
          if (pub && pub.track && !pub.isMuted) return pub.track;
          n = it.next();
        }
        // unmuted check failed — still try any published track
        it = pubs.values();
        n = it.next();
        while (!n.done) {
          var pub2 = n.value;
          if (pub2 && pub2.track) return pub2.track;
          n = it.next();
        }
      }
    }
    for (var i = 0; i < localTracks.length; i++) {
      var t = localTracks[i];
      if (t && (t.kind === 'video' || (t.kind && String(t.kind).toLowerCase() === 'video'))) {
        return t;
      }
    }
    return null;
  }

  function isVideoTrack(track, LivekitClient) {
    if (!track) return false;
    var kind = track.kind;
    if (kind === 'video') return true;
    if (LivekitClient && LivekitClient.Track && kind === LivekitClient.Track.Kind.Video) return true;
    return String(kind || '').toLowerCase() === 'video';
  }

  /**
   * Presentation:
   * - No remote video → phone-style voice stage ("Cuộc gọi thoại") — not a black box
   * - Remote video on → video stage primary
   * - Local camera on → PiP preview (from LiveKit publication, not stale localTracks)
   */
  function refreshStagePresentation() {
    var localTrack = getLocalCameraTrack();
    hasLocalVideo = !!(localTrack && camEnabled && desiredCameraEnabled);
    var showVoice = !remoteHasVideo;

    if (els.mediaPane) {
      els.mediaPane.classList.toggle('is-voice-mode', showVoice);
      els.mediaPane.classList.toggle('has-local-cam', hasLocalVideo);
    }
    if (els.voiceStage) {
      els.voiceStage.classList.toggle('hidden', !showVoice);
    }
    if (els.videoStage) {
      els.videoStage.classList.toggle('is-voice-underlay', showVoice);
      if (showVoice) {
        // keep element for attach, but hide black surface
      }
    }
    if (els.remotePlaceholder) {
      // On video layout only, when remote cam off
      els.remotePlaceholder.classList.toggle('hidden', showVoice || remoteHasVideo);
    }
    if (els.remotePlaceholderText && !remoteHasVideo) {
      els.remotePlaceholderText.textContent = 'Tư vấn viên đang tắt camera';
    }
    if (els.voiceKindLabel) {
      els.voiceKindLabel.textContent = preferredMedia === 'audio' && !hasLocalVideo
        ? 'Cuộc gọi thoại'
        : (hasLocalVideo ? 'Bạn đã bật camera' : 'Chờ hình từ tư vấn viên');
    }
    if (els.voiceHint) {
      if (hasLocalVideo) {
        els.voiceHint.textContent = 'Hình của bạn đang gửi — tư vấn viên chưa bật camera';
      } else if (preferredMedia === 'audio') {
        els.voiceHint.textContent = 'Chỉ micro — bấm Camera nếu muốn bật hình của bạn';
      } else {
        els.voiceHint.textContent = 'Tư vấn viên đang tắt camera — bạn vẫn nghe được tiếng';
      }
    }
    if (els.voiceConnHint) {
      els.voiceConnHint.textContent = mediaSessionStarted ? ' · Đang tư vấn' : ' · Đang kết nối';
    }
    if (els.mediaHint && mediaSessionStarted) {
      els.mediaHint.classList.add('hidden');
    }
    // Header subtitle reflects call kind
    if (uiState === 'media' && els.statusLine) {
      // keep status from setStatus; kind is on voice stage
    }
    // Local PiP — size from stream aspect (landscape vs portrait), not fixed 3:4
    if (els.localVideo) {
      if (hasLocalVideo && localTrack) {
        try {
          localTrack.attach(els.localVideo);
          els.localVideo.muted = true;
          els.localVideo.playsInline = true;
          els.localVideo.autoplay = true;
          els.localVideo.setAttribute('playsinline', '');
          els.localVideo.classList.remove('hidden');
          els.localVideo.play().catch(function () { /* ignore */ });
          fitLocalPipPreview(els.localVideo);
        } catch (eAtt) {
          console.warn('[embed] attach local preview failed', eAtt);
        }
      } else {
        try { els.localVideo.srcObject = null; } catch (eC) { /* ignore */ }
        els.localVideo.classList.add('hidden');
        els.localVideo.classList.remove('is-portrait', 'is-landscape');
      }
    }
    if (els.localSample) els.localSample.classList.add('hidden');
    if (els.btnToVideo) els.btnToVideo.classList.add('hidden');
    if (els.btnToAudio) els.btnToAudio.classList.add('hidden');
    if (els.btnCam) els.btnCam.classList.remove('hidden');
    syncCamButton();
  }

  /**
   * Fit visitor local PiP to actual camera aspect (same behavior as staff call-window).
   */
  function fitLocalPipPreview(videoEl) {
    if (!videoEl) return;
    var mp = mediaP();
    if (mp && mp.applyLocalPipFit) {
      mp.applyLocalPipFit(videoEl);
      return;
    }
    // Minimal fallback if media-primitives not loaded
    var layout = function () {
      var vw = videoEl.videoWidth || 0;
      var vh = videoEl.videoHeight || 0;
      videoEl.classList.remove('is-portrait', 'is-landscape');
      if (vw > 0 && vh > 0) {
        videoEl.classList.add(vh > vw ? 'is-portrait' : 'is-landscape');
        var maxW = vh > vw ? 110 : 168;
        var maxH = vh > vw ? 168 : 100;
        var scale = Math.min(maxW / vw, maxH / vh);
        videoEl.style.width = Math.round(vw * scale) + 'px';
        videoEl.style.height = Math.round(vh * scale) + 'px';
        videoEl.style.objectFit = 'contain';
        videoEl.style.aspectRatio = 'auto';
      }
    };
    layout();
    videoEl.addEventListener('loadedmetadata', layout);
    videoEl.addEventListener('playing', layout);
  }

  function applyMediaUi() {
    refreshStagePresentation();
    updateLocalPreview();
  }

  function syncCamButton() {
    if (!els.btnCam) return;
    if (camEnabled && hasLocalVideo) {
      els.btnCam.classList.remove('off');
      els.btnCam.textContent = 'Camera';
      els.btnCam.title = 'Tắt camera của tôi';
    } else if (camEnabled && !hasLocalVideo) {
      els.btnCam.classList.remove('off');
      els.btnCam.textContent = 'Camera…';
      els.btnCam.title = 'Đang bật camera';
    } else {
      els.btnCam.classList.add('off');
      els.btnCam.textContent = 'Camera tắt';
      els.btnCam.title = 'Bật camera của tôi';
    }
  }

  function hideCameraRequestBanner() {
    if (els.mediaModeBanner) els.mediaModeBanner.classList.add('hidden');
  }

  function showIncomingCameraRequest() {
    if (!els.mediaModeBanner) return;
    cameraRequestState = 'received';
    if (els.mediaModeBannerText) {
      els.mediaModeBannerText.textContent = 'Tư vấn viên muốn bạn bật camera để hỗ trợ tư vấn.';
    }
    if (els.btnAcceptVideo) els.btnAcceptVideo.textContent = 'Bật camera';
    if (els.btnRejectVideo) els.btnRejectVideo.textContent = 'Để sau';
    els.mediaModeBanner.classList.remove('hidden');
  }

  async function publishCameraAction(action) {
    var mm = mediaModeApi();
    if (!mm || !room) return;
    if (mm.publishCameraRequest) {
      await mm.publishCameraRequest(room, action, { from: 'visitor' });
      return;
    }
    var msg = mm.buildCameraRequestMessage
      ? mm.buildCameraRequestMessage(action, { from: 'visitor' })
      : mm.buildMediaModeMessage(action, { from: 'visitor' });
    if (msg) await mm.publishMediaModeMessage(room, msg);
  }

  /** Local camera only — never a global session mode, never forces peer camera. */
  async function setLocalCameraEnabled(want, opts) {
    opts = opts || {};
    if (!room || !room.localParticipant) return false;
    try {
      desiredCameraEnabled = !!want;
      await room.localParticipant.setCameraEnabled(!!want);
      camEnabled = !!want;

      // LiveKit creates the track on enable — it is NOT in localTracks from audio-only join.
      // Sync localTracks for ownership + attach preview from publications.
      if (want) {
        var camTrack = getLocalCameraTrack();
        if (camTrack) {
          var already = localTracks.some(function (t) { return t === camTrack; });
          if (!already) localTracks.push(camTrack);
        } else {
          // Brief wait: publication can lag setCameraEnabled by a tick
          await new Promise(function (r) { setTimeout(r, 120); });
          camTrack = getLocalCameraTrack();
          if (camTrack && localTracks.indexOf(camTrack) < 0) localTracks.push(camTrack);
        }
        if (!getLocalCameraTrack()) {
          // Fallback: create + publish if SDK did not enable
          var LivekitClient = window.LivekitClient || window.LiveKit || window.livekit;
          if (LivekitClient && LivekitClient.createLocalTracks) {
            try {
              var created = await LivekitClient.createLocalTracks({
                audio: false,
                video: { facingMode: 'user' }
              });
              for (var ci = 0; ci < created.length; ci++) {
                try {
                  await room.localParticipant.publishTrack(created[ci]);
                  localTracks.push(created[ci]);
                } catch (pe) {
                  try { created[ci].stop(); } catch (se) { /* ignore */ }
                }
              }
            } catch (ce) {
              console.warn('[embed] fallback create camera failed', ce);
            }
          }
        }
      } else {
        // Remove video tracks from localTracks ownership list; stop if we own them
        var kept = [];
        for (var li = 0; li < localTracks.length; li++) {
          var lt = localTracks[li];
          var isV = lt && (lt.kind === 'video' || String(lt.kind || '').toLowerCase() === 'video');
          if (isV) {
            // setCameraEnabled(false) should stop publication; do not double-stop SDK-owned tracks aggressively
          } else {
            kept.push(lt);
          }
        }
        localTracks = kept;
      }

      updateLocalPreview();
      refreshStagePresentation();
      // Confirm actual publication state
      var actuallyOn = !!getLocalCameraTrack() && !!want;
      camEnabled = actuallyOn || (!want ? false : camEnabled);
      if (want && !getLocalCameraTrack()) {
        camEnabled = false;
        desiredCameraEnabled = false;
        if (opts.showBanner !== false) {
          setDeviceBanner('Không bật được camera. Cho phép Camera trong trình duyệt rồi thử lại.');
        }
        syncCamButton();
        return false;
      }
      if (!want) {
        camEnabled = false;
        desiredCameraEnabled = false;
      }
      syncCamButton();
      return camEnabled === !!want || !want;
    } catch (eCam) {
      console.warn('[embed] setCameraEnabled failed', eCam);
      camEnabled = false;
      desiredCameraEnabled = false;
      updateLocalPreview();
      refreshStagePresentation();
      if (opts.showBanner !== false) {
        setDeviceBanner(want
          ? 'Không bật được camera. Kiểm tra quyền trình duyệt.'
          : 'Không tắt được camera.');
      }
      syncCamButton();
      return false;
    }
  }

  async function toggleLocalCamera() {
    if (cameraRequestBusy || !room) return;
    cameraRequestBusy = true;
    try {
      await setLocalCameraEnabled(!camEnabled);
    } finally {
      cameraRequestBusy = false;
    }
  }

  async function acceptCameraRequest() {
    if (cameraRequestBusy || !room) return;
    cameraRequestBusy = true;
    try {
      var ok = await setLocalCameraEnabled(true);
      if (!ok) return;
      hideCameraRequestBanner();
      cameraRequestState = 'idle';
      await publishCameraAction('accept');
    } finally {
      cameraRequestBusy = false;
    }
  }

  async function rejectCameraRequest() {
    hideCameraRequestBanner();
    cameraRequestState = 'idle';
    // No local camera change on reject
    await publishCameraAction('reject');
  }

  function handleCameraRequestMessage(msg) {
    var mm = mediaModeApi();
    if (!mm || !mm.isMediaModeMessage(msg)) return;

    if (mm.isObsoleteModeSyncMessage && mm.isObsoleteModeSyncMessage(msg)) {
      // Legacy switch_audio / switch_video / mode_sync — do NOT mutate local camera or preferredMedia.
      console.info('[embed] ignored legacy mode sync', msg.action);
      return;
    }

    var action = mm.normalizeCameraRequestAction
      ? mm.normalizeCameraRequestAction(msg.action)
      : null;
    if (!action) {
      // Fallback for older shared module
      if (msg.action === 'request_video' || msg.action === 'request') action = 'request';
      else if (msg.action === 'accept_video' || msg.action === 'accept') action = 'accept';
      else if (msg.action === 'reject_video' || msg.action === 'reject') action = 'reject';
      else return;
    }

    if (action === 'request') {
      showIncomingCameraRequest();
      return;
    }
    if (action === 'accept') {
      // Peer accepted our request — their track appears via LiveKit. Never force local cam.
      hideCameraRequestBanner();
      cameraRequestState = 'idle';
      return;
    }
    if (action === 'reject') {
      hideCameraRequestBanner();
      cameraRequestState = 'idle';
      setDeviceBanner('Đối phương từ chối bật camera.');
    }
  }

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

  function setCallButtonsDisabled(disabled) {
    if (els.btnCall) els.btnCall.disabled = disabled;
    if (els.btnCallVideo) els.btnCallVideo.disabled = disabled;
    if (els.btnCallAudio) els.btnCallAudio.disabled = disabled;
  }

  /**
   * Align local join preference with server EmbedCallView.initialMediaMode.
   * Only before media session starts — never resets desired camera mid-call.
   */
  function applyServerInitialMedia(callOrBody) {
    if (mediaSessionStarted || !callOrBody) return;
    var mode = callOrBody.initialMediaMode || callOrBody.InitialMediaMode;
    if (!mode) return;
    var normalized = (mediaP() && mediaP().normalizeMediaModeValue)
      ? mediaP().normalizeMediaModeValue(mode)
      : (String(mode).toLowerCase() === 'audio' ? 'audio' : 'video');
    preferredMedia = normalized;
    desiredCameraEnabled = preferredMedia !== 'audio';
    camEnabled = desiredCameraEnabled;
    try { sessionStorage.setItem(storageKey('preferredMedia'), preferredMedia); } catch (e) { /* ignore */ }
  }

  async function startCall(mediaMode) {
    preferredMedia = (mediaP() && mediaP().normalizeMediaModeValue)
      ? mediaP().normalizeMediaModeValue(mediaMode)
      : (mediaMode === 'audio' ? 'audio' : 'video');
    desiredCameraEnabled = preferredMedia !== 'audio';
    mediaSessionStarted = false;
    cameraRequestState = 'idle';
    try {
      sessionStorage.setItem(storageKey('preferredMedia'), preferredMedia);
    } catch { /* ignore */ }
    setCallButtonsDisabled(true);
    try {
      await ensureSessionFromParent();
      var res = await api('/embed/calls', {
        method: 'POST',
        body: JSON.stringify({ initialMediaMode: preferredMedia === 'audio' ? 'Audio' : 'Video' })
      });
      if (!res.ok) {
        throw new Error((res.body && res.body.error) || ('Create call failed (' + res.status + ')'));
      }
      callId = res.body.id;
      lastServerStatus = res.body.status;
      // Server is authoritative for join preference (must match staff CallView.initialMediaMode)
      applyServerInitialMedia(res.body);
      saveCallState();
      showWaiting(res.body);
      startPoll();
      postParent({ type: 'state', state: res.body.status || 'Queued' });
    } catch (err) {
      setHardError(err.message || String(err));
    } finally {
      setCallButtonsDisabled(false);
    }
  }

  function showWaiting(call) {
    showPane('waiting');
    var status = (call && call.status) || 'Queued';
    var kind = preferredMedia === 'audio' ? 'thoại' : 'video';
    if (status === 'Ringing') {
      els.waitText.textContent = 'Đang gọi nhân viên (' + kind + ')…';
      setStatus(preferredMedia === 'audio' ? 'Đổ chuông · thoại' : 'Đổ chuông · video');
    } else {
      els.waitText.textContent = 'Đang chờ nhân viên (' + kind + ')…';
      setStatus(preferredMedia === 'audio' ? 'Chờ · cuộc gọi thoại' : 'Chờ · cuộc gọi video');
    }
    var wait = call && typeof call.waitingSeconds === 'number' ? call.waitingSeconds : 0;
    els.waitMeta.textContent = wait > 0
      ? ('Đã chờ khoảng ' + wait + ' giây')
      : 'Vui lòng giữ cửa sổ này mở';
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
      els.endedText.textContent = 'Cuộc gọi đã hết hạn hoặc đã kết thúc.';
      return;
    }
    if (!res.ok) return;

    var status = res.body.status;
    lastServerStatus = status;
    applyServerInitialMedia(res.body);
    postParent({ type: 'state', state: status });

    if (status === 'Queued' || status === 'Ringing') {
      if (uiState !== 'waiting') showWaiting(res.body);
      else showWaiting(res.body);
      return;
    }

    if (status === 'Accepted') {
      // Graceful end: staff/backend saving clip — keep room + camera source alive
      if (res.body.gracefulEndPending || res.body.GracefulEndPending) {
        enterVisitorGracefulEnding(res.body);
        return;
      }
      if (gracefulEnding) {
        // Still accepted without pending — recovery path
        gracefulEnding = false;
      }
      // Product: visitor auto-enters call after staff Accept — no "Tham gia" confirm.
      if (uiState === 'media' && room) {
        setStatus('Đang tư vấn');
        return;
      }
      if (uiState === 'reconnect') {
        els.reconnectMeta.textContent = 'Cuộc gọi vẫn đang mở — thử nối lại hình ảnh / âm thanh.';
        return;
      }
      // Stay on perm manual retry UI; otherwise auto-join once.
      if (uiState === 'perm') return;
      if (uiState === 'media') return;
      if (joining) return;
      postParent({ type: 'state', state: 'Accepted' });
      // Keep wait spinner until joinMedia swaps to media pane.
      if (uiState === 'waiting') {
        els.waitText.textContent = 'Nhân viên đã nhận — đang vào cuộc gọi…';
        setStatus('Đang vào cuộc gọi');
      }
      joinMedia();
      return;
    }

    if (isTerminal(status)) {
      applyTerminal(status);
    }
  }

  function endedMessage(status) {
    switch (status) {
      case 'Cancelled': return 'Bạn đã hủy cuộc gọi.';
      case 'Rejected': return 'Nhân viên không thể nhận lúc này. Vui lòng gọi lại sau.';
      case 'Timeout': return 'Hết thời gian chờ. Vui lòng gọi lại sau.';
      case 'NoAgent': return 'Hiện chưa có nhân viên sẵn sàng. Vui lòng gọi lại sau.';
      case 'Closed': return 'Phòng khám đang ngoài giờ. Vui lòng gọi lại sau.';
      case 'Ended': return 'Cuộc gọi đã kết thúc. Cảm ơn bạn.';
      default: return 'Cuộc gọi đã kết thúc.';
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
        else reject(new Error('Không khởi tạo được kết nối video.'));
      };
      s.onerror = function () {
        livekitLoadPromise = null;
        reject(new Error('Không tải được thành phần video. Kiểm tra mạng và thử lại.'));
      };
      document.head.appendChild(s);
    });
    return livekitLoadPromise;
  }

  function setDeviceBanner(text) {
    if (!els.deviceBanner) return;
    if (!text) {
      els.deviceBanner.classList.add('hidden');
      els.deviceBanner.textContent = '';
      return;
    }
    els.deviceBanner.textContent = text;
    els.deviceBanner.classList.remove('hidden');
  }

  function updateLocalPreview() {
    var videoTrack = getLocalCameraTrack();
    hasLocalVideo = !!(videoTrack && camEnabled);
    hasLocalAudio = localTracks.some(function (t) {
      return t && (t.kind === 'audio' || String(t.kind || '').toLowerCase() === 'audio');
    }) || !!(room && room.localParticipant && room.localParticipant.isMicrophoneEnabled);

    // Attach / hide handled in refreshStagePresentation
    refreshStagePresentation();

    if (!desiredCameraEnabled) {
      if (els.btnRetryDevices) {
        els.btnRetryDevices.classList.toggle('hidden', hasLocalAudio);
        els.btnRetryDevices.textContent = 'Thử lại micro';
      }
      if (!hasLocalAudio) {
        setDeviceBanner('Chưa bật micro. Bấm «Thử lại micro» khi sẵn sàng.');
      } else {
        // Clear banner once mic is fine on audio call — no avatar-pip noise
        setDeviceBanner('');
      }
      return;
    }
    if (els.btnRetryDevices) {
      els.btnRetryDevices.classList.toggle('hidden', hasLocalVideo && hasLocalAudio);
      els.btnRetryDevices.textContent = 'Thử lại micro/camera';
    }
    if (!hasLocalVideo && !hasLocalAudio) {
      setDeviceBanner('Chưa bật micro/camera — bạn vẫn nghe được. Bấm «Thử lại micro/camera» khi sẵn sàng.');
    } else if (!hasLocalVideo && camEnabled) {
      setDeviceBanner('Đang bật camera…');
    } else if (!hasLocalAudio) {
      setDeviceBanner('Chưa bật micro — chỉ gửi hình. Bấm «Thử lại micro/camera» để xin lại quyền.');
    } else {
      setDeviceBanner('');
    }
  }

  /**
   * Attach remote staff video/audio. Always try play() for audio (Safari autoplay).
   */
  function attachRemoteTrackEmbed(LivekitClient, track) {
    var isVideo = isVideoTrack(track, LivekitClient);
    var mp = mediaP();
    if (mp && mp.attachRemoteTrack) {
      mp.attachRemoteTrack(LivekitClient, track, {
        remoteVideoEl: els.remoteVideo,
        onAudioBlocked: function () {
          setDeviceBanner('Chạm vào màn hình để nghe tiếng nhân viên (trình duyệt chặn autoplay).');
        }
      });
      if (isVideo) {
        remoteHasVideo = true;
        if (els.mediaHint) els.mediaHint.classList.add('hidden');
        if (els.remoteVideo) {
          try { els.remoteVideo.play().catch(function () {}); } catch (eP) { /* ignore */ }
        }
        refreshStagePresentation();
      }
      return;
    }
    if (!track) return;
    if (isVideo) {
      try {
        track.attach(els.remoteVideo);
        remoteHasVideo = true;
        if (els.mediaHint) els.mediaHint.classList.add('hidden');
        if (els.remoteVideo) els.remoteVideo.play().catch(function () {});
        refreshStagePresentation();
      } catch (eVid) {
        console.warn('[embed] attach remote video', eVid);
      }
      return;
    }
    try {
      var audioEl = track.attach();
      audioEl.autoplay = true;
      audioEl.muted = false;
      audioEl.volume = 1;
      audioEl.setAttribute('playsinline', '');
      audioEl.style.display = 'none';
      audioEl.setAttribute('data-lk-remote', '1');
      document.body.appendChild(audioEl);
      audioEl.play().catch(function () {
        setDeviceBanner('Chạm vào màn hình để nghe tiếng nhân viên (trình duyệt chặn autoplay).');
      });
    } catch (eAud) {
      console.warn('[embed] attach remote audio', eAud);
    }
  }

  function onRemoteVideoGone() {
    remoteHasVideo = false;
    if (els.remoteVideo) {
      try { els.remoteVideo.srcObject = null; } catch (e) { /* ignore */ }
    }
    refreshStagePresentation();
  }

  async function acquireLocalTracks(LivekitClient) {
    var mp = mediaP();
    // Join preference: use desiredCamera after session started; else preferredMedia / storage
    var wantCam = mediaSessionStarted ? !!desiredCameraEnabled : (preferredMedia !== 'audio');
    if (!mediaSessionStarted) {
      try {
        var stored = sessionStorage.getItem(storageKey('preferredMedia'));
        if (stored === 'audio' || stored === 'video') {
          preferredMedia = stored;
          wantCam = stored !== 'audio';
          desiredCameraEnabled = wantCam;
        }
      } catch (ePref) { /* ignore */ }
    }
    var pref = wantCam ? 'video' : 'audio';

    if (mp && mp.acquireLocalTracks) {
      var res = await mp.acquireLocalTracks(LivekitClient, { preferredMedia: pref });
      if (res.note === 'audio-only' || !res.cameraAvailable) camEnabled = false;
      else if (res.cameraAvailable) camEnabled = true;
      return { tracks: res.tracks || [], note: res.note || '' };
    }

    // Fallback minimal path
    try {
      var tracks = await LivekitClient.createLocalTracks({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: wantCam ? { facingMode: 'user' } : false
      });
      camEnabled = wantCam;
      return { tracks: tracks, note: wantCam ? 'av' : 'audio-only' };
    } catch (e) {
      console.warn('[embed] acquire fallback failed', e);
      return { tracks: [], note: 'receive-only' };
    }
  }

  /**
   * After room connected: re-request devices and publish new tracks (no rejoin).
   * Respects desiredCameraEnabled — never re-seeds from initial preferredMedia alone.
   */
  async function retryDevices() {
    if (!room || !callId || retryingDevices) return;
    if (joining) return;
    retryingDevices = true;
    if (els.btnRetryDevices) els.btnRetryDevices.disabled = true;
    try {
      var LivekitClient = await loadLivekit();
      var acquired = await acquireLocalTracks(LivekitClient);
      var next = acquired.tracks || [];
      if (!desiredCameraEnabled) {
        // Drop any video tracks acquired accidentally; stop them to release camera
        var kept = [];
        for (var fi = 0; fi < next.length; fi++) {
          var tr = next[fi];
          var isVid = tr && (tr.kind === 'video' || (tr.kind && String(tr.kind).toLowerCase() === 'video'));
          if (isVid) {
            try { tr.stop(); } catch (eStop) { /* ignore */ }
          } else {
            kept.push(tr);
          }
        }
        next = kept;
      }
      if (!next.length) {
        setDeviceBanner(!desiredCameraEnabled
          ? 'Vẫn chưa bật được micro. Kiểm tra quyền trình duyệt rồi thử lại.'
          : 'Vẫn chưa bật được micro/camera. Kiểm tra quyền trình duyệt rồi thử lại.');
        return;
      }

      // Stop & unpublish previous local tracks we own.
      for (var i = 0; i < localTracks.length; i++) {
        try {
          if (room.localParticipant) {
            await room.localParticipant.unpublishTrack(localTracks[i]);
          }
        } catch (e) { /* ignore */ }
        try { localTracks[i].stop(); } catch (e2) { /* ignore */ }
      }
      localTracks = next;

      for (var j = 0; j < localTracks.length; j++) {
        try {
          await room.localParticipant.publishTrack(localTracks[j]);
        } catch (pubErr) {
          console.warn('[embed] publish after retry failed', pubErr);
        }
      }
      // Enforce desired camera after republish
      if (room.localParticipant) {
        try {
          await room.localParticipant.setCameraEnabled(!!desiredCameraEnabled);
          camEnabled = !!desiredCameraEnabled;
        } catch (eOff) { /* ignore */ }
      }
      updateLocalPreview();
      syncCamButton();
      setStatus('Đang tư vấn');
    } catch (err) {
      console.warn(err);
      setDeviceBanner(err.message || (!desiredCameraEnabled
        ? 'Không bật lại được micro. Vui lòng thử lại.'
        : 'Không bật lại được micro/camera. Vui lòng thử lại.'));
    } finally {
      retryingDevices = false;
      if (els.btnRetryDevices) els.btnRetryDevices.disabled = false;
    }
  }

  async function joinMedia() {
    // If already in room, device retry is a separate path.
    if (room) {
      await retryDevices();
      return;
    }
    if (joining || !callId) return;
    joining = true;
    intentionalLeave = false;
    showPane('media');
    setStatus('Đang kết nối');
    els.mediaHint.classList.remove('hidden');
    els.mediaHint.textContent = 'Đang chuẩn bị…';
    setDeviceBanner('');

    try {
      var LivekitClient = await loadLivekit();
      if (!mediaSessionStarted) {
        desiredCameraEnabled = preferredMedia !== 'audio';
      }
      els.mediaHint.textContent = desiredCameraEnabled
        ? 'Đang xin quyền micro / camera (camera không bắt buộc)…'
        : 'Đang xin quyền micro…';

      var tok = await api('/embed/calls/' + callId + '/token', { method: 'POST', body: '{}' });
      if (!tok.ok) {
        throw new Error((tok.body && tok.body.error) || ('Không lấy được quyền vào cuộc gọi (' + tok.status + ')'));
      }

      var acquired = await acquireLocalTracks(LivekitClient);
      localTracks = acquired.tracks || [];
      if (!desiredCameraEnabled) {
        // Filter video tracks and stop them so camera capture does not continue
        var audioOnlyTracks = [];
        for (var ti = 0; ti < localTracks.length; ti++) {
          var t0 = localTracks[ti];
          var isV = t0 && (t0.kind === 'video' || (t0.kind && String(t0.kind).toLowerCase() === 'video'));
          if (isV) {
            try { t0.stop(); } catch (eStop0) { /* ignore */ }
          } else {
            audioOnlyTracks.push(t0);
          }
        }
        localTracks = audioOnlyTracks;
        camEnabled = false;
      }
      updateLocalPreview();

      els.mediaHint.textContent = 'Đang vào cuộc gọi…';
      remoteHasVideo = false;
      room = new LivekitClient.Room({ adaptiveStream: true, dynacast: true });
      room.on(LivekitClient.RoomEvent.TrackSubscribed, function (track) {
        attachRemoteTrackEmbed(LivekitClient, track);
      });
      room.on(LivekitClient.RoomEvent.TrackUnsubscribed, function (track) {
        if (isVideoTrack(track, LivekitClient)) onRemoteVideoGone();
      });
      room.on(LivekitClient.RoomEvent.TrackMuted, function (publication, participant) {
        if (participant && participant.isLocal) {
          updateLocalPreview();
          return;
        }
        if (publication && (publication.kind === 'video' ||
            (publication.track && isVideoTrack(publication.track, LivekitClient)))) {
          onRemoteVideoGone();
        }
      });
      room.on(LivekitClient.RoomEvent.TrackUnmuted, function (publication, participant) {
        if (participant && participant.isLocal) {
          updateLocalPreview();
          return;
        }
        if (publication && publication.track && isVideoTrack(publication.track, LivekitClient)) {
          attachRemoteTrackEmbed(LivekitClient, publication.track);
        }
      });
      room.on(LivekitClient.RoomEvent.LocalTrackPublished, function (publication) {
        if (publication && (publication.kind === 'video' ||
            (publication.track && isVideoTrack(publication.track, LivekitClient)))) {
          camEnabled = true;
          desiredCameraEnabled = true;
          updateLocalPreview();
        }
      });
      room.on(LivekitClient.RoomEvent.LocalTrackUnpublished, function (publication) {
        if (publication && (publication.kind === 'video' ||
            (publication.track && isVideoTrack(publication.track, LivekitClient)))) {
          updateLocalPreview();
        }
      });
      room.on(LivekitClient.RoomEvent.AudioPlaybackStatusChanged, function () {
        if (room && !room.canPlaybackAudio) {
          setDeviceBanner('Trình duyệt chặn tiếng staff. Chạm vào màn hình cuộc gọi để bật tiếng.');
        }
      });
      room.on(LivekitClient.RoomEvent.Disconnected, function () {
        onMediaDisconnected();
      });
      // Staff camera request + photo capture (no global mode sync)
      room.on(LivekitClient.RoomEvent.DataReceived, function (payload) {
        var mm = mediaModeApi();
        var msg = mm ? mm.parseDataPayload(payload) : null;
        if (msg && mm && mm.isMediaModeMessage(msg)) {
          handleCameraRequestMessage(msg);
          return;
        }
        handleCapturePhotoData(payload).catch(function (e) {
          console.warn('[embed] capture_photo failed', e);
        });
      });

      await room.connect(tok.body.url, tok.body.token);
      mediaSessionStarted = true;
      applyMediaUi();
      startCallTimer();
      // No mode_sync — remote UI derives from LiveKit publications

      // Attach any tracks already published by staff before we joined.
      try {
        var mpAttach = mediaP();
        if (mpAttach && mpAttach.attachExistingRemoteTracks) {
          mpAttach.attachExistingRemoteTracks(room, LivekitClient, {
            remoteVideoEl: els.remoteVideo,
            onAudioBlocked: function () {
              setDeviceBanner('Chạm vào màn hình để nghe tiếng nhân viên (trình duyệt chặn autoplay).');
            }
          });
          // Detect if staff already has video
          room.remoteParticipants.forEach(function (p) {
            p.trackPublications.forEach(function (pub) {
              if (pub.track && isVideoTrack(pub.track, LivekitClient) && !pub.isMuted) {
                remoteHasVideo = true;
              }
            });
          });
          refreshStagePresentation();
        } else {
          room.remoteParticipants.forEach(function (p) {
            p.trackPublications.forEach(function (pub) {
              try { pub.setSubscribed(true); } catch (eSub) { /* ignore */ }
              if (pub.track) attachRemoteTrackEmbed(LivekitClient, pub.track);
            });
          });
        }
      } catch (eAttach) {
        console.warn('[embed] attach existing remote failed', eAttach);
      }

      var mpPub = mediaP();
      if (mpPub && mpPub.publishLocalTracksWithSources) {
        await mpPub.publishLocalTracksWithSources(room, localTracks, LivekitClient);
      } else {
        for (var i = 0; i < localTracks.length; i++) {
          try { await room.localParticipant.publishTrack(localTracks[i]); }
          catch (pubErr) { console.warn('[embed] publish failed', pubErr); }
        }
      }

      try {
        var canPlay = true;
        if (mpPub && mpPub.unlockRemoteAudio) {
          canPlay = await mpPub.unlockRemoteAudio(room);
        } else {
          await room.startAudio();
          canPlay = !!room.canPlaybackAudio;
        }
        if (!canPlay) {
          setDeviceBanner('Ch?m v?o m?n h?nh ?? nghe ti?ng nh?n vi?n (tr?nh duy?t ch?n autoplay).');
        }
      } catch (eStart) {
        console.warn('[embed] startAudio failed', eStart);
        setDeviceBanner('Ch?m v?o m?n h?nh ?? nghe ti?ng nh?n vi?n.');
      }

      if (mpPub && mpPub.bindTapToUnlockAudio) {
        mpPub.bindTapToUnlockAudio(els.mediaPane, room, function () { setDeviceBanner(''); });
      } else if (els.mediaPane && !els.mediaPane._audioUnlockBound) {
        els.mediaPane._audioUnlockBound = true;
        els.mediaPane.addEventListener('click', function () {
          if (!room) return;
          room.startAudio().then(function () {
            if (room.canPlaybackAudio) setDeviceBanner('');
          }).catch(function () {});
        }, { passive: true });
      }

      setStatus(preferredMedia === 'audio' ? 'Cuộc gọi thoại' : 'Đang tư vấn');
      if (els.mediaHint) els.mediaHint.classList.add('hidden');
      updateLocalPreview();
      refreshStagePresentation();
      postParent({ type: 'state', state: 'Connected' });
      if (!pollTimer) startPoll();
      saveCallState();
    } catch (err) {
      // Token / LiveKit / network only — not device permission (devices already soft-failed).
      console.error(err);
      disconnectMedia({ silent: true });
      els.permText.textContent = err.message || String(err);
      showPane('perm');
      setStatus('Lỗi media');
      if (!pollTimer) startPoll();
    } finally {
      joining = false;
    }
  }

  function onMediaDisconnected() {
    if (intentionalLeave) return;
    stopCallTimer();
    room = null;
    remoteHasVideo = false;
    // Do not clear callId — 90s in-call stale / reconnect policy.
    showPane('reconnect');
    setStatus('Mất media');
    els.reconnectMeta.textContent = 'Cuộc gọi vẫn được giữ. Bấm nối lại khi mạng ổn định.';
    postParent({ type: 'state', state: 'Reconnect' });
    if (!pollTimer) startPoll();
  }

  /**
   * Backend SendData { type: capture_photo, assetId, uploadUrl }
   * Capture local camera → PUT to Object Storage → upload-complete.
   */
  async function handleCapturePhotoData(payload) {
    var msg;
    try {
      var text = typeof payload === 'string'
        ? payload
        : new TextDecoder().decode(payload);
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!msg || msg.type !== 'capture_photo' || !msg.assetId) return;
    if (!room || !room.localParticipant) {
      console.warn('[embed] capture_photo: no room');
      return;
    }

    var Track = (window.LivekitClient && window.LivekitClient.Track) || {};
    var camSource = Track.Source && Track.Source.Camera;
    var pub = camSource
      ? room.localParticipant.getTrackPublication(camSource)
      : null;
    var track = pub && (pub.track || pub.videoTrack);
    var mst = track && track.mediaStreamTrack;
    if (!mst) {
      console.warn('[embed] capture_photo: no local camera track');
      return;
    }

    var settings = (mst.getSettings && mst.getSettings()) || {};
    var blob = null;
    var actualWidth = settings.width || null;
    var actualHeight = settings.height || null;

    if (typeof ImageCapture !== 'undefined') {
      try {
        var cap = new ImageCapture(mst);
        var photo = await cap.takePhoto();
        if (photo instanceof Blob) blob = photo;
      } catch (e) {
        console.warn('[embed] ImageCapture failed, canvas fallback', e);
      }
    }

    if (!blob) {
      var canvas = document.createElement('canvas');
      canvas.width = settings.width || 1280;
      canvas.height = settings.height || 720;
      actualWidth = canvas.width;
      actualHeight = canvas.height;
      var videoEl = document.createElement('video');
      videoEl.muted = true;
      videoEl.playsInline = true;
      videoEl.srcObject = new MediaStream([mst]);
      await videoEl.play();
      await new Promise(function (r) { setTimeout(r, 50); });
      canvas.getContext('2d').drawImage(videoEl, 0, 0, canvas.width, canvas.height);
      try { videoEl.pause(); videoEl.srcObject = null; } catch { /* ignore */ }
      blob = await new Promise(function (res) {
        canvas.toBlob(function (b) { res(b); }, 'image/jpeg', 0.95);
      });
    }

    if (!blob) throw new Error('Không chụp được ảnh');

    var mode = msg.uploadMode || (msg.uploadUrl ? 'presign' : 'api');
    if (mode === 'presign' && msg.uploadUrl) {
      var putRes = await fetch(msg.uploadUrl, {
        method: 'PUT',
        body: blob,
        headers: { 'Content-Type': 'image/jpeg' }
      });
      if (!putRes.ok) throw new Error('Upload ảnh HTTP ' + putRes.status);

      var lastErr = null;
      for (var attempt = 0; attempt < 3; attempt++) {
        try {
          var complete = await api('/api/media/' + msg.assetId + '/upload-complete', {
            method: 'POST',
            body: JSON.stringify({
              actualWidth: actualWidth,
              actualHeight: actualHeight,
              bytes: blob.size
            })
          });
          if (complete.ok || complete.status === 202) {
            console.info('[embed] photo ready', msg.assetId);
            return;
          }
          lastErr = new Error((complete.body && complete.body.error) || ('upload-complete ' + complete.status));
        } catch (e) {
          lastErr = e;
        }
        await new Promise(function (r) { setTimeout(r, 800 * (attempt + 1)); });
      }
      if (lastErr) throw lastErr;
      return;
    }

    // API upload (local storage) — Bearer embed token via api()
    var path = msg.uploadPath || ('/api/media/' + msg.assetId + '/upload');
    var qs = [];
    if (actualWidth) qs.push('w=' + encodeURIComponent(actualWidth));
    if (actualHeight) qs.push('h=' + encodeURIComponent(actualHeight));
    if (qs.length) path += '?' + qs.join('&');
    var up = await api(path, {
      method: 'POST',
      headers: { 'Content-Type': 'image/jpeg' },
      body: blob
    });
    // api() helper may not accept raw body — fallback fetch
    if (!up || up.status === undefined) {
      var res = await fetch(apiBase + path, {
        method: 'POST',
        headers: {
          Authorization: accessToken ? ('Bearer ' + accessToken) : '',
          'Content-Type': 'image/jpeg',
          Accept: 'application/json'
        },
        body: blob,
        credentials: 'omit'
      });
      if (!res.ok) throw new Error('API upload HTTP ' + res.status);
      console.info('[embed] photo ready (api)', msg.assetId);
      return;
    }
    if (!up.ok) throw new Error((up.body && up.body.error) || ('API upload ' + up.status));
    console.info('[embed] photo ready (api)', msg.assetId);
  }

  function disconnectMedia(opts) {
    opts = opts || {};
    if (!opts.silent) intentionalLeave = true;
    stopCallTimer();
    remoteHasVideo = false;
    hasLocalVideo = false;
    try {
      if (room) room.disconnect();
    } catch { /* ignore */ }
    room = null;
    localTracks.forEach(function (t) {
      try { t.stop(); } catch { /* ignore */ }
    });
    localTracks = [];
    try {
      if (els.localVideo) {
        els.localVideo.srcObject = null;
        els.localVideo.classList.add('hidden');
      }
      if (els.remoteVideo) els.remoteVideo.srcObject = null;
    } catch { /* ignore */ }
    if (els.voiceStage) els.voiceStage.classList.add('hidden');
    if (els.mediaPane) {
      els.mediaPane.classList.remove('is-voice-mode', 'has-local-cam');
    }
  }

  /**
   * Cancel only clears local state when backend confirms terminal (Cancelled)
   * or when still Queued/Ringing response. 409 Accepted → auto-join.
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
        // Staff may have Accepted concurrently — auto-join, no confirm step.
        lastServerStatus = (res.body && res.body.status) || lastServerStatus;
        if (lastServerStatus === 'Accepted' || (res.body && res.body.status === 'Accepted')) {
          if (!pollTimer) startPoll();
          if (!room && !joining) {
            if (uiState === 'waiting') {
              els.waitText.textContent = 'Nhân viên đã nhận — đang vào cuộc gọi…';
              setStatus('Đang vào cuộc gọi');
            }
            joinMedia();
          }
          return;
        }
        // Re-poll truth
        await refreshCall();
        return;
      }
      if (!res.ok) {
        els.waitMeta.textContent = (res.body && res.body.error) || 'Không hủy được. Vui lòng thử lại.';
        return;
      }
    } catch (err) {
      els.waitMeta.textContent = err.message || String(err);
    } finally {
      els.btnCancel.disabled = false;
    }
  }

  function enterVisitorGracefulEnding(body) {
    gracefulEnding = true;
    intentionalLeave = false;
    // Keep LiveKit room + camera tracks alive for TrackComposite Egress
    setStatus('Đang lưu video…');
    if (els.mediaHint) {
      els.mediaHint.classList.remove('hidden');
      els.mediaHint.textContent = 'Đang lưu clip và kết thúc cuộc gọi…';
    }
    if (els.btnEnd) els.btnEnd.disabled = true;
    if (els.btnMic) els.btnMic.disabled = true;
    if (els.btnCam) els.btnCam.disabled = true;
    if (els.btnRetryDevices) els.btnRetryDevices.disabled = true;
    // Soft text after grace elapsed (poll-based)
    var requestedAt = body && (body.gracefulEndRequestedAt || body.GracefulEndRequestedAt);
    var graceSec = Number((body && (body.gracefulEndGraceSeconds || body.GracefulEndGraceSeconds)) || 12);
    if (requestedAt) {
      try {
        var elapsed = (Date.now() - new Date(requestedAt).getTime()) / 1000;
        if (elapsed >= graceSec && els.mediaHint) {
          els.mediaHint.textContent = 'Video đang mất nhiều thời gian để xử lý…';
        }
      } catch (eG) { /* ignore */ }
    }
    if (!pollTimer) startPoll();
  }

  /**
   * End: POST first, disconnect LiveKit only after backend terminal.
   * Patient camera is dental TrackComposite source — never kill before barrier.
   */
  async function endCall() {
    if (!callId) {
      applyTerminal('Ended');
      return;
    }
    if (endingBusy || gracefulEnding) return;
    endingBusy = true;

    // Not yet connected media — cancel if possible
    if (!room && lastServerStatus !== 'Accepted') {
      try {
        intentionalLeave = true;
        var c0 = await api('/embed/calls/' + callId + '/cancel', { method: 'POST', body: '{}' });
        if (c0.ok && c0.body && isTerminal(c0.body.status)) {
          applyTerminal(c0.body.status);
          return;
        }
        var e0 = await api('/embed/calls/' + callId + '/end', { method: 'POST', body: '{}' });
        if (e0.ok && e0.body && isTerminal(e0.body.status)) {
          applyTerminal(e0.body.status);
          return;
        }
      } catch (e) { console.warn(e); }
      intentionalLeave = true;
      applyTerminal('Ended');
      endingBusy = false;
      return;
    }

    try {
      setStatus('Đang kết thúc…');
      if (els.btnEnd) els.btnEnd.disabled = true;
      var res = await api('/embed/calls/' + callId + '/end', { method: 'POST', body: '{}' });

      if (res.ok && res.body) {
        applyServerInitialMedia(res.body);
        lastServerStatus = res.body.status || lastServerStatus;

        if (isTerminal(res.body.status)) {
          intentionalLeave = true;
          gracefulEnding = false;
          disconnectMedia({ silent: true });
          applyTerminal(res.body.status);
          return;
        }

        if (res.body.status === 'Accepted'
            && (res.body.gracefulEndPending || res.body.GracefulEndPending)) {
          enterVisitorGracefulEnding(res.body);
          return;
        }
      }

      if (res.status === 409) {
        var c = await api('/embed/calls/' + callId + '/cancel', { method: 'POST', body: '{}' });
        if (c.ok && c.body && isTerminal(c.body.status)) {
          intentionalLeave = true;
          disconnectMedia({ silent: true });
          applyTerminal(c.body.status);
          return;
        }
      }

      // Transport / unexpected — re-poll without killing media
      if (!pollTimer) startPoll();
      await refreshCall();
    } catch (err) {
      console.warn('[embed] endCall failed', err);
      if (!pollTimer) startPoll();
      try { await refreshCall(); } catch (e2) { /* ignore */ }
      // Allow retry if not graceful-pending
      if (!gracefulEnding && els.btnEnd) els.btnEnd.disabled = false;
    } finally {
      endingBusy = false;
    }
  }

  function toggleMic() {
    micEnabled = !micEnabled;
    if (room && room.localParticipant) {
      try { room.localParticipant.setMicrophoneEnabled(micEnabled); } catch { /* ignore */ }
    }
    els.btnMic.classList.toggle('off', !micEnabled);
    els.btnMic.textContent = micEnabled ? 'Micro' : 'Tắt micro';
  }

  function toggleCam() {
    toggleLocalCamera();
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

  if (els.btnCallVideo) {
    els.btnCallVideo.addEventListener('click', function () { startCall('video'); });
  }
  if (els.btnCallAudio) {
    els.btnCallAudio.addEventListener('click', function () { startCall('audio'); });
  }
  // Legacy single button still maps to video
  if (els.btnCall) {
    els.btnCall.addEventListener('click', function () { startCall('video'); });
  }
  els.btnCancel.addEventListener('click', cancelCall);
  els.btnRetryMedia.addEventListener('click', joinMedia);
  if (els.btnRetryDevices) els.btnRetryDevices.addEventListener('click', retryDevices);
  els.btnReconnect.addEventListener('click', function () {
    // Full reconnect path when room was lost.
    if (room) retryDevices();
    else joinMedia();
  });
  els.btnEnd.addEventListener('click', endCall);
  els.btnEndFromPerm.addEventListener('click', endCall);
  els.btnEndFromReconnect.addEventListener('click', endCall);
  els.btnAgain.addEventListener('click', resetIdle);
  els.btnRetry.addEventListener('click', resetIdle);
  els.btnClose.addEventListener('click', function () { postParent({ type: 'close' }); });
  els.btnMic.addEventListener('click', toggleMic);
  els.btnCam.addEventListener('click', toggleCam);
  // Legacy session-mode buttons — map to local camera only if still present in DOM
  if (els.btnToVideo) {
    els.btnToVideo.addEventListener('click', function () { setLocalCameraEnabled(true); });
  }
  if (els.btnToAudio) {
    els.btnToAudio.addEventListener('click', function () { setLocalCameraEnabled(false); });
  }
  if (els.btnAcceptVideo) {
    els.btnAcceptVideo.addEventListener('click', function () { acceptCameraRequest(); });
  }
  if (els.btnRejectVideo) {
    els.btnRejectVideo.addEventListener('click', function () { rejectCameraRequest(); });
  }

  window.addEventListener('message', onParentMessage);
  try {
    var params = new URLSearchParams(window.location.search);
    siteKey = params.get('siteKey') || siteKey;
  } catch { /* ignore */ }

  postParent({ type: 'ready' });
  showPane('idle');
  setStatus('Sẵn sàng');
})();
