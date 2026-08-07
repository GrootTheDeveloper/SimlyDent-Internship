/**
 * @file public/widget/media-mode.js
 * @shared-pair with src/domain/media/media-mode.js
 * Camera request protocol only (no global session media mode sync).
 */
(function (global) {
  'use strict';

  var CAMERA_REQUEST_TYPE = 'camera_request';
  var MEDIA_MODE_TYPE = 'media_mode';

  var CameraRequestAction = {
    Request: 'request',
    Accept: 'accept',
    Reject: 'reject'
  };

  var MediaModeAction = {
    SwitchVideo: 'switch_video',
    SwitchAudio: 'switch_audio',
    RequestVideo: 'request_video',
    AcceptVideo: 'accept_video',
    RejectVideo: 'reject_video',
    ModeSync: 'mode_sync',
    CameraRequest: 'request',
    CameraAccept: 'accept',
    CameraReject: 'reject'
  };

  var CameraRequestState = {
    Idle: 'idle',
    Sent: 'sent',
    Received: 'received',
    Accepted: 'accepted',
    Rejected: 'rejected',
    Expired: 'expired'
  };

  function normalizeInitialMediaMode(mode) {
    var m = String(mode || '').toLowerCase();
    return m === 'audio' ? 'audio' : 'video';
  }

  function normalizeSessionMediaMode(mode) {
    return normalizeInitialMediaMode(mode);
  }

  function normalizeCameraRequestAction(action) {
    var a = String(action || '');
    if (a === 'request' || a === 'request_video') return 'request';
    if (a === 'accept' || a === 'accept_video') return 'accept';
    if (a === 'reject' || a === 'reject_video') return 'reject';
    return null;
  }

  function isCameraRequestMessage(msg) {
    if (!msg || typeof msg.action !== 'string') return false;
    if (msg.type === CAMERA_REQUEST_TYPE) {
      return msg.action === 'request' || msg.action === 'accept' || msg.action === 'reject';
    }
    if (msg.type === MEDIA_MODE_TYPE) {
      return (
        msg.action === 'request_video' ||
        msg.action === 'accept_video' ||
        msg.action === 'reject_video'
      );
    }
    return false;
  }

  function isMediaModeMessage(msg) {
    if (!msg || typeof msg.action !== 'string') return false;
    if (msg.type === CAMERA_REQUEST_TYPE) return isCameraRequestMessage(msg);
    return msg.type === MEDIA_MODE_TYPE;
  }

  function isObsoleteModeSyncMessage(msg) {
    if (!msg || msg.type !== MEDIA_MODE_TYPE) return false;
    return (
      msg.action === 'switch_video' ||
      msg.action === 'switch_audio' ||
      msg.action === 'mode_sync'
    );
  }

  function buildCameraRequestMessage(action, extra) {
    extra = extra || {};
    var normalized = normalizeCameraRequestAction(action) || 'request';
    return {
      type: CAMERA_REQUEST_TYPE,
      action: normalized,
      from: extra.from || undefined,
      requestId: extra.requestId || undefined,
      ts: Date.now()
    };
  }

  function buildMediaModeMessage(action, extra) {
    var cam = normalizeCameraRequestAction(action);
    if (cam) return buildCameraRequestMessage(cam, extra);
    return null;
  }

  function reduceCameraRequestState(state, event) {
    var cur = state || 'idle';
    if (event === 'send') return 'sent';
    if (event === 'receive') return 'received';
    if (event === 'accept') return (cur === 'received' || cur === 'sent') ? 'accepted' : cur;
    if (event === 'reject') return (cur === 'received' || cur === 'sent') ? 'rejected' : cur;
    if (event === 'expire') return cur === 'sent' ? 'expired' : cur;
    if (event === 'clear') return 'idle';
    return cur;
  }

  function desiredCameraFromInitialMode(initialMediaMode) {
    return normalizeInitialMediaMode(initialMediaMode) !== 'audio';
  }

  function shouldJoinAudioOnly(opts) {
    opts = opts || {};
    if (opts.mediaSessionStarted) return !opts.desiredCameraEnabled;
    if (typeof opts.desiredCameraEnabled === 'boolean') return !opts.desiredCameraEnabled;
    return !desiredCameraFromInitialMode(opts.initialMediaMode);
  }

  async function publishMediaModeMessage(room, message) {
    if (!room || !room.localParticipant || !message) return false;
    try {
      var bytes = new TextEncoder().encode(JSON.stringify(message));
      await room.localParticipant.publishData(bytes, { reliable: true });
      return true;
    } catch (e) {
      console.warn('[camera-request] publish failed', e);
      return false;
    }
  }

  async function publishCameraRequest(room, action, extra) {
    return publishMediaModeMessage(room, buildCameraRequestMessage(action, extra));
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
    CAMERA_REQUEST_TYPE: CAMERA_REQUEST_TYPE,
    MEDIA_MODE_TYPE: MEDIA_MODE_TYPE,
    CameraRequestAction: CameraRequestAction,
    CameraRequestState: CameraRequestState,
    MediaModeAction: MediaModeAction,
    normalizeInitialMediaMode: normalizeInitialMediaMode,
    normalizeSessionMediaMode: normalizeSessionMediaMode,
    normalizeCameraRequestAction: normalizeCameraRequestAction,
    isCameraRequestMessage: isCameraRequestMessage,
    isMediaModeMessage: isMediaModeMessage,
    isObsoleteModeSyncMessage: isObsoleteModeSyncMessage,
    buildCameraRequestMessage: buildCameraRequestMessage,
    buildMediaModeMessage: buildMediaModeMessage,
    reduceCameraRequestState: reduceCameraRequestState,
    desiredCameraFromInitialMode: desiredCameraFromInitialMode,
    shouldJoinAudioOnly: shouldJoinAudioOnly,
    publishMediaModeMessage: publishMediaModeMessage,
    publishCameraRequest: publishCameraRequest,
    parseDataPayload: parseDataPayload
  };
})(typeof window !== 'undefined' ? window : this);
