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
  var retryingDevices = false;
  var intentionalLeave = false;
  var livekitLoadPromise = null;
  var hasLocalVideo = false;
  var hasLocalAudio = false;
  /** Preferred local media when joining: 'video' | 'audio' */
  var preferredMedia = 'video';
  /** Runtime session mode (may switch mid-call) */
  var sessionMediaMode = 'video';
  var mediaModeBusy = false;

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
    audioSessionPanel: $('audioSessionPanel'),
    mediaModeBanner: $('mediaModeBanner'),
    mediaModeBannerText: $('mediaModeBannerText'),
    btnAcceptVideo: $('btnAcceptVideo'),
    btnRejectVideo: $('btnRejectVideo'),
    btnToVideo: $('btnToVideo'),
    btnToAudio: $('btnToAudio')
  };

  function applySessionMediaUi() {
    var audio = sessionMediaMode === 'audio';
    if (els.audioSessionPanel) els.audioSessionPanel.classList.toggle('hidden', !audio);
    if (els.videoStage) els.videoStage.classList.toggle('is-audio-hidden', audio);
    if (els.btnToVideo) els.btnToVideo.classList.toggle('hidden', !audio);
    if (els.btnToAudio) els.btnToAudio.classList.toggle('hidden', audio);
    // Camera button: in audio mode hide (use Bật video); in video show toggle
    if (els.btnCam) els.btnCam.classList.toggle('hidden', audio);
  }

  function hideMediaModeBanner() {
    if (els.mediaModeBanner) els.mediaModeBanner.classList.add('hidden');
  }

  function showIncomingVideoRequest() {
    if (!els.mediaModeBanner) return;
    if (els.mediaModeBannerText) {
      els.mediaModeBannerText.textContent = 'Phòng khám muốn bật camera (chuyển video call).';
    }
    els.mediaModeBanner.classList.remove('hidden');
  }

  async function publishMode(action, mode) {
    var mm = mediaModeApi();
    if (!mm || !room) return;
    var msg = mm.buildMediaModeMessage(action, { mode: mode || sessionMediaMode, from: 'visitor' });
    await mm.publishMediaModeMessage(room, msg);
  }

  async function switchToVideoSession(fromAccept) {
    if (mediaModeBusy || !room) return;
    mediaModeBusy = true;
    try {
      camEnabled = true;
      try {
        await room.localParticipant.setCameraEnabled(true);
      } catch (eCam) {
        console.warn('[embed] enable camera failed', eCam);
        setDeviceBanner('Không bật được camera. Kiểm tra quyền trình duyệt.');
        mediaModeBusy = false;
        return;
      }
      sessionMediaMode = 'video';
      preferredMedia = 'video';
      try { sessionStorage.setItem(storageKey('preferredMedia'), 'video'); } catch (eS) { /* ignore */ }
      hideMediaModeBanner();
      applySessionMediaUi();
      updateLocalPreview();
      els.btnCam.classList.remove('off');
      els.btnCam.textContent = 'Camera';
      var mm = mediaModeApi();
      var action = fromAccept
        ? (mm && mm.MediaModeAction.AcceptVideo)
        : (mm && mm.MediaModeAction.SwitchVideo);
      if (action) await publishMode(action, 'video');
    } finally {
      mediaModeBusy = false;
    }
  }

  async function switchToAudioSession(selfInitiated) {
    if (mediaModeBusy || !room) return;
    mediaModeBusy = true;
    try {
      camEnabled = false;
      try { await room.localParticipant.setCameraEnabled(false); } catch (e) { /* ignore */ }
      sessionMediaMode = 'audio';
      preferredMedia = 'audio';
      try { sessionStorage.setItem(storageKey('preferredMedia'), 'audio'); } catch (eS) { /* ignore */ }
      hideMediaModeBanner();
      applySessionMediaUi();
      updateLocalPreview();
      if (selfInitiated) {
        var mm = mediaModeApi();
        if (mm) await publishMode(mm.MediaModeAction.SwitchAudio, 'audio');
      }
    } finally {
      mediaModeBusy = false;
    }
  }

  function handleMediaModeMessage(msg) {
    var mm = mediaModeApi();
    if (!mm || !mm.isMediaModeMessage(msg)) return;
    var A = mm.MediaModeAction;
    if (msg.action === A.RequestVideo) {
      showIncomingVideoRequest();
      return;
    }
    if (msg.action === A.AcceptVideo || msg.action === A.SwitchVideo) {
      sessionMediaMode = 'video';
      preferredMedia = 'video';
      hideMediaModeBanner();
      applySessionMediaUi();
      return;
    }
    if (msg.action === A.SwitchAudio) {
      sessionMediaMode = 'audio';
      preferredMedia = 'audio';
      camEnabled = false;
      if (room && room.localParticipant) {
        try { room.localParticipant.setCameraEnabled(false); } catch (e) { /* ignore */ }
      }
      hideMediaModeBanner();
      applySessionMediaUi();
      return;
    }
    if (msg.action === A.ModeSync && msg.mode) {
      sessionMediaMode = mm.normalizeSessionMediaMode(msg.mode);
      preferredMedia = sessionMediaMode;
      applySessionMediaUi();
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

  async function startCall(mediaMode) {
    preferredMedia = (mediaP() && mediaP().normalizeMediaModeValue)
      ? mediaP().normalizeMediaModeValue(mediaMode)
      : (mediaMode === 'audio' ? 'audio' : 'video');
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
    if (status === 'Ringing') {
      els.waitText.textContent = 'Đang gọi nhân viên…';
      setStatus('Đang đổ chuông');
    } else {
      els.waitText.textContent = 'Đang chờ nhân viên…';
      setStatus('Đang chờ');
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
    postParent({ type: 'state', state: status });

    if (status === 'Queued' || status === 'Ringing') {
      if (uiState !== 'waiting') showWaiting(res.body);
      else showWaiting(res.body);
      return;
    }

    if (status === 'Accepted') {
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
    var videoTrack = localTracks.find(function (t) { return t.kind === 'video'; });
    hasLocalVideo = !!videoTrack;
    hasLocalAudio = localTracks.some(function (t) { return t.kind === 'audio'; });
    if (videoTrack && els.localVideo) {
      try { videoTrack.attach(els.localVideo); } catch (e) { /* ignore */ }
      els.localVideo.classList.remove('hidden');
      if (els.localSample) els.localSample.classList.add('hidden');
    } else {
      if (els.localVideo) {
        try { els.localVideo.srcObject = null; } catch (e) { /* ignore */ }
        els.localVideo.classList.add('hidden');
      }
      if (els.localSample) els.localSample.classList.remove('hidden');
    }
    if (els.btnRetryDevices) {
      els.btnRetryDevices.classList.toggle('hidden', hasLocalVideo && hasLocalAudio);
    }
    if (!hasLocalVideo && !hasLocalAudio) {
      setDeviceBanner('Chưa bật micro/camera — bạn vẫn nghe và xem được. Bấm «Thử lại micro/camera» khi sẵn sàng.');
    } else if (!hasLocalVideo) {
      setDeviceBanner('Chưa bật camera — đang dùng ảnh đại diện. Micro ' + (hasLocalAudio ? 'đang bật' : 'đang tắt') + '.');
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
    var mp = mediaP();
    if (mp && mp.attachRemoteTrack) {
      var kind = track && track.kind;
      var isVideo = kind === 'video' ||
        (LivekitClient.Track && kind === LivekitClient.Track.Kind.Video);
      mp.attachRemoteTrack(LivekitClient, track, {
        remoteVideoEl: els.remoteVideo,
        onAudioBlocked: function () {
          setDeviceBanner('Ch?m v?o m?n h?nh ?? nghe ti?ng nh?n vi?n (tr?nh duy?t ch?n autoplay).');
        }
      });
      if (isVideo && els.mediaHint) els.mediaHint.classList.add('hidden');
      return;
    }
    if (!track) return;
    var kind2 = track.kind;
    var isVideo2 = kind2 === 'video' ||
      (LivekitClient.Track && kind2 === LivekitClient.Track.Kind.Video);
    if (isVideo2) {
      try {
        track.attach(els.remoteVideo);
        if (els.mediaHint) els.mediaHint.classList.add('hidden');
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
        setDeviceBanner('Ch?m v?o m?n h?nh ?? nghe ti?ng nh?n vi?n (tr?nh duy?t ch?n autoplay).');
      });
    } catch (eAud) {
      console.warn('[embed] attach remote audio', eAud);
    }
  }

  async function acquireLocalTracks(LivekitClient) {
    var mp = mediaP();
    var pref = preferredMedia;
    try {
      var stored = sessionStorage.getItem(storageKey('preferredMedia'));
      if (stored === 'audio' || stored === 'video') {
        preferredMedia = stored;
        pref = stored;
      }
    } catch (ePref) { /* ignore */ }

    if (mp && mp.acquireLocalTracks) {
      var res = await mp.acquireLocalTracks(LivekitClient, { preferredMedia: pref });
      if (res.note === 'audio-only' || !res.cameraAvailable) camEnabled = false;
      if (res.cameraAvailable) camEnabled = true;
      return { tracks: res.tracks || [], note: res.note || '' };
    }

    // Fallback minimal path
    try {
      var tracks = await LivekitClient.createLocalTracks({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: pref === 'audio' ? false : { facingMode: 'user' }
      });
      camEnabled = pref !== 'audio';
      return { tracks: tracks, note: pref === 'audio' ? 'audio-only' : 'av' };
    } catch (e) {
      console.warn('[embed] acquire fallback failed', e);
      return { tracks: [], note: 'receive-only' };
    }
  }

  /**
   * After room connected: re-request devices and publish new tracks (no rejoin).
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
      if (!next.length) {
        setDeviceBanner('Vẫn chưa bật được micro/camera. Kiểm tra quyền trình duyệt rồi thử lại.');
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
      updateLocalPreview();
      setStatus('Đang tư vấn');
    } catch (err) {
      console.warn(err);
      setDeviceBanner(err.message || 'Không bật lại được micro/camera. Vui lòng thử lại.');
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
      els.mediaHint.textContent = 'Đang xin quyền micro / camera (camera không bắt buộc)…';

      var tok = await api('/embed/calls/' + callId + '/token', { method: 'POST', body: '{}' });
      if (!tok.ok) {
        throw new Error((tok.body && tok.body.error) || ('Không lấy được quyền vào cuộc gọi (' + tok.status + ')'));
      }

      var acquired = await acquireLocalTracks(LivekitClient);
      localTracks = acquired.tracks || [];
      updateLocalPreview();

      els.mediaHint.textContent = 'Đang vào cuộc gọi…';
      room = new LivekitClient.Room({ adaptiveStream: true, dynacast: true });
      room.on(LivekitClient.RoomEvent.TrackSubscribed, function (track) {
        attachRemoteTrackEmbed(LivekitClient, track);
      });
      room.on(LivekitClient.RoomEvent.AudioPlaybackStatusChanged, function () {
        if (room && !room.canPlaybackAudio) {
          setDeviceBanner('Trình duyệt chặn tiếng staff. Chạm vào màn hình cuộc gọi để bật tiếng.');
        }
      });
      room.on(LivekitClient.RoomEvent.Disconnected, function () {
        onMediaDisconnected();
      });
      // Staff-triggered photo + media mode protocol
      room.on(LivekitClient.RoomEvent.DataReceived, function (payload) {
        var mm = mediaModeApi();
        var msg = mm ? mm.parseDataPayload(payload) : null;
        if (msg && mm && mm.isMediaModeMessage(msg)) {
          handleMediaModeMessage(msg);
          return;
        }
        handleCapturePhotoData(payload).catch(function (e) {
          console.warn('[embed] capture_photo failed', e);
        });
      });

      await room.connect(tok.body.url, tok.body.token);
      sessionMediaMode = preferredMedia === 'audio' ? 'audio' : 'video';
      applySessionMediaUi();
      var mmSync = mediaModeApi();
      if (mmSync) {
        publishMode(mmSync.MediaModeAction.ModeSync, sessionMediaMode);
      }

      // Attach any tracks already published by staff before we joined.
      try {
        var mpAttach = mediaP();
        if (mpAttach && mpAttach.attachExistingRemoteTracks) {
          mpAttach.attachExistingRemoteTracks(room, LivekitClient, {
            remoteVideoEl: els.remoteVideo,
            onAudioBlocked: function () {
              setDeviceBanner('Ch?m v?o m?n h?nh ?? nghe ti?ng nh?n vi?n (tr?nh duy?t ch?n autoplay).');
            }
          });
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

      setStatus('Đang tư vấn');
      els.mediaHint.classList.add('hidden');
      updateLocalPreview();
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
    room = null;
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
    els.btnMic.textContent = micEnabled ? 'Micro' : 'Tắt micro';
  }

  function toggleCam() {
    // Mid-call: use session mode switches (Bật video / Chỉ thoại)
    if (sessionMediaMode === 'audio') {
      switchToVideoSession(false);
      return;
    }
    camEnabled = !camEnabled;
    if (room && room.localParticipant) {
      try { room.localParticipant.setCameraEnabled(camEnabled); } catch { /* ignore */ }
    }
    els.btnCam.classList.toggle('off', !camEnabled);
    els.btnCam.textContent = camEnabled ? 'Camera' : 'Tắt camera';
    if (!camEnabled) switchToAudioSession(true);
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
  if (els.btnToVideo) {
    els.btnToVideo.addEventListener('click', function () { switchToVideoSession(false); });
  }
  if (els.btnToAudio) {
    els.btnToAudio.addEventListener('click', function () { switchToAudioSession(true); });
  }
  if (els.btnAcceptVideo) {
    els.btnAcceptVideo.addEventListener('click', function () { switchToVideoSession(true); });
  }
  if (els.btnRejectVideo) {
    els.btnRejectVideo.addEventListener('click', function () {
      hideMediaModeBanner();
      var mm = mediaModeApi();
      if (mm) publishMode(mm.MediaModeAction.RejectVideo, sessionMediaMode);
    });
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
