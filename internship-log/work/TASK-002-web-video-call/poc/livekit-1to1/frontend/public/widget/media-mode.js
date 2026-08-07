/**
 * @file public/widget/media-mode.js
 * @shared-pair with src/domain/media/media-mode.js
 * IIFE for embed frame.js
 */
(function (global) {
  'use strict';

  var MEDIA_MODE_TYPE = 'media_mode';
  var MediaModeAction = {
    SwitchVideo: 'switch_video',
    SwitchAudio: 'switch_audio',
    RequestVideo: 'request_video',
    AcceptVideo: 'accept_video',
    RejectVideo: 'reject_video',
    ModeSync: 'mode_sync'
  };

  function normalizeSessionMediaMode(mode) {
    var m = String(mode || '').toLowerCase();
    return m === 'audio' ? 'audio' : 'video';
  }

  function isMediaModeMessage(msg) {
    return !!msg && msg.type === MEDIA_MODE_TYPE && typeof msg.action === 'string';
  }

  function buildMediaModeMessage(action, extra) {
    extra = extra || {};
    return {
      type: MEDIA_MODE_TYPE,
      action: action,
      mode: extra.mode ? normalizeSessionMediaMode(extra.mode) : undefined,
      from: extra.from || undefined,
      ts: Date.now()
    };
  }

  async function publishMediaModeMessage(room, message) {
    if (!room || !room.localParticipant) return false;
    try {
      var bytes = new TextEncoder().encode(JSON.stringify(message));
      await room.localParticipant.publishData(bytes, { reliable: true });
      return true;
    } catch (e) {
      console.warn('[media-mode] publish failed', e);
      return false;
    }
  }

  function parseDataPayload(payload) {
    try {
      var u8 = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
      return JSON.parse(new TextDecoder().decode(u8));
    } catch (e) {
      return null;
    }
  }

  global.SimlyDentMediaMode = {
    MEDIA_MODE_TYPE: MEDIA_MODE_TYPE,
    MediaModeAction: MediaModeAction,
    normalizeSessionMediaMode: normalizeSessionMediaMode,
    isMediaModeMessage: isMediaModeMessage,
    buildMediaModeMessage: buildMediaModeMessage,
    publishMediaModeMessage: publishMediaModeMessage,
    parseDataPayload: parseDataPayload
  };
})(typeof window !== 'undefined' ? window : this);
