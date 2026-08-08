/**
 * Authoritative local mic/camera helpers for visitor embed.
 * Pure functions — testable with mock LocalParticipant.
 * Browser: window.SimlyDentLocalMediaControls
 * Node: module.exports
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.SimlyDentLocalMediaControls = api;
  }
})(typeof globalThis !== 'undefined'
  ? globalThis
  : (typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : null)), function () {
  'use strict';

  function isVideoKind(kind, Track) {
    if (kind === 'video') return true;
    if (Track && Track.Kind && kind === Track.Kind.Video) return true;
    return String(kind || '').toLowerCase() === 'video';
  }

  function isAudioKind(kind, Track) {
    if (kind === 'audio') return true;
    if (Track && Track.Kind && kind === Track.Kind.Audio) return true;
    return String(kind || '').toLowerCase() === 'audio';
  }

  function findPublication(participant, sourceName, kindCheck) {
    if (!participant) return null;
    var Track = (typeof window !== 'undefined' && window.LivekitClient && window.LivekitClient.Track)
      || null;
    var source = Track && Track.Source && Track.Source[sourceName];
    if (source && typeof participant.getTrackPublication === 'function') {
      try {
        var bySrc = participant.getTrackPublication(source);
        if (bySrc) return bySrc;
      } catch (e) { /* ignore */ }
    }
    var map = sourceName === 'Camera'
      ? participant.videoTrackPublications
      : participant.audioTrackPublications;
    if (map && typeof map.values === 'function') {
      var it = map.values();
      var n = it.next();
      while (!n.done) {
        var pub = n.value;
        if (pub && kindCheck(pub.kind, Track)) return pub;
        if (pub && pub.track && kindCheck(pub.track.kind, Track)) return pub;
        n = it.next();
      }
    }
    // Fallback: trackPublications map
    if (participant.trackPublications && typeof participant.trackPublications.values === 'function') {
      var it2 = participant.trackPublications.values();
      var n2 = it2.next();
      while (!n2.done) {
        var p2 = n2.value;
        if (p2 && kindCheck(p2.kind, Track)) return p2;
        if (p2 && p2.track && kindCheck(p2.track.kind, Track)) return p2;
        n2 = it2.next();
      }
    }
    return null;
  }

  /**
   * Authoritative mic on/off from LocalParticipant.
   * Prefers isMicrophoneEnabled; else microphone publication !isMuted.
   */
  function getActualMicEnabled(participant) {
    if (!participant) return false;
    if (typeof participant.isMicrophoneEnabled === 'boolean') {
      return !!participant.isMicrophoneEnabled;
    }
    // getter on LiveKit Participant prototype
    try {
      if ('isMicrophoneEnabled' in participant) {
        return !!participant.isMicrophoneEnabled;
      }
    } catch (e) { /* ignore */ }
    var pub = findPublication(participant, 'Microphone', isAudioKind);
    if (!pub) return false;
    if (pub.isMuted === true) return false;
    return !!(pub.track || pub.audioTrack);
  }

  /**
   * Authoritative camera on/off from LocalParticipant.
   * Prefers isCameraEnabled; else camera publication !isMuted.
   */
  function getActualCameraEnabled(participant) {
    if (!participant) return false;
    try {
      if ('isCameraEnabled' in participant) {
        return !!participant.isCameraEnabled;
      }
    } catch (e) { /* ignore */ }
    var pub = findPublication(participant, 'Camera', isVideoKind);
    if (!pub) return false;
    if (pub.isMuted === true) return false;
    return !!(pub.track || pub.videoTrack);
  }

  function roomIsConnected(room) {
    if (!room) return false;
    // LiveKit RoomState.Connected === 'connected' in v2
    var st = room.state;
    if (st == null) return !!(room.localParticipant);
    if (typeof st === 'string') {
      return st === 'connected' || st === 'Connected';
    }
    // enum numeric — treat known Connected values loosely
    if (typeof st === 'number') {
      // RoomState: Disconnected=0, Connecting=1, Connected=2, Reconnecting=3 (approx)
      return st === 2;
    }
    return !!(room.localParticipant);
  }

  /**
   * Poll until actual state matches want, or timeout.
   * @returns {Promise<{ok:boolean, actual:boolean}>}
   */
  function waitForMediaState(getActual, want, opts) {
    opts = opts || {};
    var timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : 2500;
    var intervalMs = opts.intervalMs != null ? opts.intervalMs : 80;
    return new Promise(function (resolve) {
      var start = Date.now();
      function tick() {
        var actual = !!getActual();
        if (actual === !!want) {
          resolve({ ok: true, actual: actual });
          return;
        }
        if (Date.now() - start >= timeoutMs) {
          resolve({ ok: false, actual: actual });
          return;
        }
        setTimeout(tick, intervalMs);
      }
      tick();
    });
  }

  /**
   * Decision for a toggle click: never silent no-op without reason.
   * @returns {{action:'disable'|'run'|'busy', message?:string, current?:boolean, want?:boolean}}
   */
  function planToggle(opts) {
    opts = opts || {};
    if (opts.busy) {
      return { action: 'busy', message: opts.busyMessage || 'Đang xử lý…' };
    }
    if (!opts.roomConnected) {
      return { action: 'disable', message: 'Media chưa sẵn sàng' };
    }
    if (!opts.participant) {
      return { action: 'disable', message: 'Media chưa sẵn sàng' };
    }
    var current = !!opts.current;
    var want = !current;
    return { action: 'run', current: current, want: want };
  }

  /**
   * UI labels for mic button from presentation state.
   */
  function micButtonUi(state) {
    state = state || {};
    if (state.busy) {
      return { text: 'Micro…', title: 'Đang xử lý micro', off: false, disabled: true };
    }
    if (!state.roomReady) {
      return { text: 'Micro', title: 'Media chưa sẵn sàng', off: true, disabled: true };
    }
    if (state.enabled) {
      return { text: 'Micro', title: 'Tắt micro', off: false, disabled: false };
    }
    return { text: 'Tắt micro', title: 'Bật micro', off: true, disabled: false };
  }

  function camButtonUi(state) {
    state = state || {};
    if (state.busy) {
      return { text: 'Camera…', title: 'Đang xử lý camera', off: false, disabled: true };
    }
    if (!state.roomReady) {
      return { text: 'Camera', title: 'Media chưa sẵn sàng', off: true, disabled: true };
    }
    if (state.enabled && state.hasVideo) {
      return { text: 'Camera', title: 'Tắt camera của tôi', off: false, disabled: false };
    }
    if (state.enabled && !state.hasVideo) {
      return { text: 'Camera…', title: 'Đang bật camera', off: false, disabled: true };
    }
    return { text: 'Camera tắt', title: 'Bật camera của tôi', off: true, disabled: false };
  }

  return {
    getActualMicEnabled: getActualMicEnabled,
    getActualCameraEnabled: getActualCameraEnabled,
    roomIsConnected: roomIsConnected,
    waitForMediaState: waitForMediaState,
    planToggle: planToggle,
    micButtonUi: micButtonUi,
    camButtonUi: camButtonUi,
    findPublication: findPublication
  };
});
