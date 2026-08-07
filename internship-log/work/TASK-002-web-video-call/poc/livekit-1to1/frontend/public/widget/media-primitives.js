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
      try {
        tracks = await createLocalTracks({
          audio: audio,
          video: { facingMode: 'user', resolution: videoRes }
        });
        micAvailable = true;
        cameraAvailable = true;
        note = 'av';
        return { tracks: tracks, note: note, cameraAvailable: cameraAvailable, micAvailable: micAvailable };
      } catch (e) {
        console.warn('[media-primitives] AV failed, trying audio-only', e);
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

  global.SimlyDentMediaPrimitives = {
    normalizeMediaModeValue: normalizeMediaModeValue,
    defaultAudioConstraints: defaultAudioConstraints,
    acquireLocalTracks: acquireLocalTracks,
    attachRemoteTrack: attachRemoteTrack,
    publishLocalTracksWithSources: publishLocalTracksWithSources,
    attachExistingRemoteTracks: attachExistingRemoteTracks,
    unlockRemoteAudio: unlockRemoteAudio,
    bindTapToUnlockAudio: bindTapToUnlockAudio
  };
})(typeof window !== 'undefined' ? window : this);