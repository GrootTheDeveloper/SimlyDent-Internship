/**
 * @file public/widget/media-primitives.js
 * @shared-pair with src/domain/media/media-primitives.js — keep algorithms in sync.
 * Exposes window.SimlyDentMediaPrimitives for frame.js (no bundler).
 */
(function (global) {
  'use strict';

  function normalizeMediaModeValue(value) {
    var v = String(value || '').toLowerCase();
    return v === 'audio' ? 'audio' : 'video';
  }

  function defaultAudioConstraints() {
    return {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    };
  }

  async function acquireLocalTracks(LivekitClient, opts) {
    opts = opts || {};
    var createLocalTracks = LivekitClient.createLocalTracks;
    var videoRes =
      opts.videoResolution ||
      (LivekitClient.VideoPresets
        ? LivekitClient.VideoPresets.h720.resolution
        : { width: 1280, height: 720, frameRate: 30 });
    var wantAudioOnly = normalizeMediaModeValue(opts.preferredMedia) === 'audio';
    var audio = defaultAudioConstraints();
    var tracks = [];
    var cameraAvailable = false;
    var micAvailable = false;
    var note = 'receive-only';

    if (wantAudioOnly) {
      try {
        tracks = await createLocalTracks({ audio: audio, video: false });
        micAvailable = true;
        note = 'audio-only';
        return { tracks: tracks, note: note, cameraAvailable: cameraAvailable, micAvailable: micAvailable };
      } catch (e) {
        console.warn('[media-primitives] preferred audio-only failed', e);
      }
    } else {
      // Desktop-safe first — facingMode:user + hard 720p often fails on Windows webcams
      // with "Could not start video source" when device busy or constraints too strict.
      var softIdeal = {
        width: { ideal: videoRes.width || 1280 },
        height: { ideal: videoRes.height || 720 },
        frameRate: { ideal: videoRes.frameRate || 30 }
      };
      var attempts = [softIdeal, true, { facingMode: 'user' }, { facingMode: 'user', resolution: videoRes }];
      for (var ai = 0; ai < attempts.length; ai++) {
        try {
          tracks = await createLocalTracks({ audio: audio, video: attempts[ai] });
          micAvailable = true;
          cameraAvailable = true;
          note = 'av';
          return { tracks: tracks, note: note, cameraAvailable: cameraAvailable, micAvailable: micAvailable };
        } catch (e) {
          console.warn('[media-primitives] AV attempt failed', attempts[ai], e);
        }
      }
    }

    try {
      tracks = await createLocalTracks({ audio: audio, video: false });
      micAvailable = true;
      note = 'audio-only';
      return { tracks: tracks, note: note, cameraAvailable: cameraAvailable, micAvailable: micAvailable };
    } catch (e2) {
      console.warn('[media-primitives] audio-only failed', e2);
    }

    return { tracks: [], note: 'receive-only', cameraAvailable: false, micAvailable: false };
  }

  function attachRemoteTrack(LivekitClient, track, opts) {
    opts = opts || {};
    if (!track) return null;
    var kind = track.kind;
    var Track = LivekitClient.Track;
    var isVideo = kind === 'video' || (Track && kind === Track.Kind.Video);

    if (isVideo) {
      var host = opts.remoteVideoEl;
      if (host) {
        try { track.attach(host); } catch (e) { console.warn('[media-primitives] attach video failed', e); }
      }
      return host || null;
    }

    var audioEl = track.attach();
    audioEl.autoplay = true;
    audioEl.muted = false;
    audioEl.volume = 1;
    audioEl.setAttribute('playsinline', '');
    audioEl.setAttribute('webkit-playsinline', '');
    audioEl.style.display = 'none';
    audioEl.setAttribute('data-lk-remote', '1');
    try {
      document.querySelectorAll('audio[data-lk-remote="1"]').forEach(function (n) {
        if (n !== audioEl) try { n.remove(); } catch (eR) { /* ignore */ }
      });
    } catch (eQ) { /* ignore */ }
    document.body.appendChild(audioEl);
    audioEl.play().catch(function () {
      if (typeof opts.onAudioBlocked === 'function') opts.onAudioBlocked();
    });
    return audioEl;
  }

  async function publishLocalTracksWithSources(room, tracks, LivekitClient) {
    if (!room || !room.localParticipant || !tracks || !tracks.length) return;
    var Track = LivekitClient.Track;
    var TrackSource = Track && Track.Source;
    for (var i = 0; i < tracks.length; i++) {
      var t = tracks[i];
      var pubOpts = undefined;
      if (TrackSource) {
        if (t.kind === 'audio' || (Track && t.kind === Track.Kind.Audio)) {
          pubOpts = { source: TrackSource.Microphone };
        } else if (t.kind === 'video' || (Track && t.kind === Track.Kind.Video)) {
          pubOpts = { source: TrackSource.Camera };
        }
      }
      try {
        await room.localParticipant.publishTrack(t, pubOpts);
      } catch (e) {
        console.warn('[media-primitives] publish failed', t && t.kind, e);
      }
    }
  }

  function attachExistingRemoteTracks(room, LivekitClient, attachOpts) {
    if (!room) return;
    try {
      room.remoteParticipants.forEach(function (p) {
        p.trackPublications.forEach(function (pub) {
          try { pub.setSubscribed(true); } catch (eS) { /* ignore */ }
          if (pub.track) attachRemoteTrack(LivekitClient, pub.track, attachOpts);
        });
      });
    } catch (e) {
      console.warn('[media-primitives] attach existing remotes failed', e);
    }
  }

  async function unlockRemoteAudio(room) {
    if (!room) return false;
    try { await room.startAudio(); } catch (e1) { /* ignore */ }
    try {
      document.querySelectorAll('audio').forEach(function (el) {
        try {
          el.muted = false;
          el.volume = 1;
          el.play().catch(function () {});
        } catch (e2) { /* ignore */ }
      });
    } catch (e3) { /* ignore */ }
    return !!room.canPlaybackAudio;
  }

  function bindTapToUnlockAudio(containerEl, room, onUnlocked) {
    if (!containerEl || containerEl._sdAudioUnlockBound) return;
    containerEl._sdAudioUnlockBound = true;
    containerEl.addEventListener('click', function () {
      unlockRemoteAudio(room).then(function (ok) {
        if (ok && typeof onUnlocked === 'function') onUnlocked();
      });
    }, { passive: true });
  }

  /**
   * Size local PiP <video> to actual stream aspect (portrait vs landscape).
   * Mirrors src/domain/media/media-utils.js applyLocalPipFit — no fixed 3:4 crop.
   *
   * @param {HTMLVideoElement} element
   * @param {{ maxW?: number, maxH?: number }} [opts]
   */
  function applyLocalPipFit(element, opts) {
    if (!element) return;
    opts = opts || {};

    function layout() {
      var vw = element.videoWidth || 0;
      var vh = element.videoHeight || 0;
      element.classList.remove('is-portrait', 'is-landscape');
      if (vw > 0 && vh > 0) {
        element.classList.add(vh > vw ? 'is-portrait' : 'is-landscape');
      }

      element.style.setProperty('object-fit', 'contain', 'important');
      element.style.setProperty('object-position', 'center center', 'important');
      element.style.removeProperty('aspect-ratio');

      if (vw <= 0 || vh <= 0) {
        // Metadata not ready — keep max box until loadedmetadata fires
        element.style.setProperty('width', 'auto', 'important');
        element.style.setProperty('height', 'auto', 'important');
        element.style.setProperty('max-width', 'min(120px, 28vw)', 'important');
        element.style.setProperty('max-height', 'min(160px, 32vh)', 'important');
        return;
      }

      var maxW = opts.maxW || Math.min(160, Math.floor((window.innerWidth || 360) * 0.42) || 160);
      var maxH = opts.maxH || Math.min(168, Math.floor((window.innerHeight || 640) * 0.32) || 168);
      // Portrait streams: taller box; landscape: wider box
      if (vh > vw) {
        maxW = opts.maxW || Math.min(110, Math.floor((window.innerWidth || 360) * 0.28) || 110);
        maxH = opts.maxH || Math.min(168, Math.floor((window.innerHeight || 640) * 0.34) || 168);
      } else {
        maxW = opts.maxW || Math.min(168, Math.floor((window.innerWidth || 360) * 0.46) || 168);
        maxH = opts.maxH || Math.min(100, Math.floor((window.innerHeight || 640) * 0.22) || 100);
      }

      var scale = Math.min(maxW / vw, maxH / vh);
      var drawW = Math.max(1, Math.round(vw * scale));
      var drawH = Math.max(1, Math.round(vh * scale));
      element.style.setProperty('width', drawW + 'px', 'important');
      element.style.setProperty('height', drawH + 'px', 'important');
      element.style.setProperty('max-width', 'none', 'important');
      element.style.setProperty('max-height', 'none', 'important');
    }

    // Debounce re-bind: remove previous listeners if re-applied
    if (element._sdPipLayout) {
      element.removeEventListener('loadedmetadata', element._sdPipLayout);
      element.removeEventListener('resize', element._sdPipLayout);
      element.removeEventListener('playing', element._sdPipLayout);
      if (element._sdPipWinResize) {
        window.removeEventListener('resize', element._sdPipWinResize);
      }
    }
    element._sdPipLayout = layout;
    element._sdPipWinResize = layout;
    layout();
    element.addEventListener('loadedmetadata', layout);
    element.addEventListener('resize', layout);
    element.addEventListener('playing', layout);
    window.addEventListener('resize', layout);
  }

  global.SimlyDentMediaPrimitives = {
    normalizeMediaModeValue: normalizeMediaModeValue,
    defaultAudioConstraints: defaultAudioConstraints,
    acquireLocalTracks: acquireLocalTracks,
    attachRemoteTrack: attachRemoteTrack,
    publishLocalTracksWithSources: publishLocalTracksWithSources,
    attachExistingRemoteTracks: attachExistingRemoteTracks,
    unlockRemoteAudio: unlockRemoteAudio,
    bindTapToUnlockAudio: bindTapToUnlockAudio,
    applyLocalPipFit: applyLocalPipFit
  };
})(typeof window !== 'undefined' ? window : this);