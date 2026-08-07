/**
 * @file domain/media/media-mode.js
 * Camera *request* protocol over LiveKit Data channel.
 *
 * Per-participant mic/camera state is NOT synchronized here.
 * LiveKit track publications are authoritative for remote video/audio.
 * This module only carries a business request: "please turn on your camera".
 *
 * Envelope:
 *   { type: 'camera_request', action, from?, ts, requestId? }
 *
 * Actions:
 *   - request  — staff (or peer) asks remote to enable *their* camera
 *   - accept   — remote accepted; only remote enables local camera
 *   - reject   — remote declined; no media side effects
 *
 * Legacy envelope (still parsed, never auto-mutates local camera):
 *   { type: 'media_mode', action: switch_*|mode_sync|... }
 */

export const CAMERA_REQUEST_TYPE = 'camera_request'
/** @deprecated Use CAMERA_REQUEST_TYPE. Kept for reading old peer messages. */
export const MEDIA_MODE_TYPE = 'media_mode'

export const CameraRequestAction = Object.freeze({
  Request: 'request',
  Accept: 'accept',
  Reject: 'reject'
})

/** @deprecated Prefer CameraRequestAction — legacy media_mode action names. */
export const MediaModeAction = Object.freeze({
  SwitchVideo: 'switch_video',
  SwitchAudio: 'switch_audio',
  RequestVideo: 'request_video',
  AcceptVideo: 'accept_video',
  RejectVideo: 'reject_video',
  ModeSync: 'mode_sync',
  // New protocol aliases (same strings as CameraRequestAction for publish helpers)
  CameraRequest: CameraRequestAction.Request,
  CameraAccept: CameraRequestAction.Accept,
  CameraReject: CameraRequestAction.Reject
})

/** Application-level camera request FSM (not LiveKit). */
export const CameraRequestState = Object.freeze({
  Idle: 'idle',
  Sent: 'sent',
  Received: 'received',
  Accepted: 'accepted',
  Rejected: 'rejected',
  Expired: 'expired'
})

/**
 * Normalize join preference only (never a runtime session mode).
 * @param {string|null|undefined} mode
 * @returns {'audio'|'video'}
 */
export function normalizeInitialMediaMode(mode) {
  const m = String(mode || '').toLowerCase()
  return m === 'audio' ? 'audio' : 'video'
}

/** @deprecated Use normalizeInitialMediaMode */
export function normalizeSessionMediaMode(mode) {
  return normalizeInitialMediaMode(mode)
}

/**
 * @param {object|null|undefined} msg
 * @returns {boolean}
 */
export function isCameraRequestMessage(msg) {
  if (!msg || typeof msg.action !== 'string') return false
  if (msg.type === CAMERA_REQUEST_TYPE) {
    return (
      msg.action === CameraRequestAction.Request ||
      msg.action === CameraRequestAction.Accept ||
      msg.action === CameraRequestAction.Reject
    )
  }
  // Legacy request/accept/reject under media_mode type
  if (msg.type === MEDIA_MODE_TYPE) {
    return (
      msg.action === MediaModeAction.RequestVideo ||
      msg.action === MediaModeAction.AcceptVideo ||
      msg.action === MediaModeAction.RejectVideo
    )
  }
  return false
}

/**
 * True for any known data-channel media control message (including obsolete ones).
 * Handlers must not treat switch_audio/switch_video/mode_sync as authority for local camera.
 * @param {object|null|undefined} msg
 */
export function isMediaModeMessage(msg) {
  if (!msg || typeof msg.action !== 'string') return false
  if (msg.type === CAMERA_REQUEST_TYPE) return isCameraRequestMessage(msg)
  return msg.type === MEDIA_MODE_TYPE
}

/**
 * Map legacy action → modern camera request action, or null if obsolete.
 * @param {string} action
 * @returns {'request'|'accept'|'reject'|null}
 */
export function normalizeCameraRequestAction(action) {
  const a = String(action || '')
  if (
    a === CameraRequestAction.Request ||
    a === MediaModeAction.RequestVideo
  ) {
    return CameraRequestAction.Request
  }
  if (
    a === CameraRequestAction.Accept ||
    a === MediaModeAction.AcceptVideo
  ) {
    return CameraRequestAction.Accept
  }
  if (
    a === CameraRequestAction.Reject ||
    a === MediaModeAction.RejectVideo
  ) {
    return CameraRequestAction.Reject
  }
  return null
}

/**
 * Whether this message is a legacy "sync session mode" that must be ignored
 * for local mic/camera mutation.
 * @param {object|null|undefined} msg
 */
export function isObsoleteModeSyncMessage(msg) {
  if (!msg || msg.type !== MEDIA_MODE_TYPE) return false
  return (
    msg.action === MediaModeAction.SwitchVideo ||
    msg.action === MediaModeAction.SwitchAudio ||
    msg.action === MediaModeAction.ModeSync
  )
}

/**
 * Build a camera-request data message (modern protocol only).
 * @param {'request'|'accept'|'reject'} action
 * @param {{ from?: string, requestId?: string }} [extra]
 */
export function buildCameraRequestMessage(action, extra = {}) {
  const normalized = normalizeCameraRequestAction(action) || CameraRequestAction.Request
  return {
    type: CAMERA_REQUEST_TYPE,
    action: normalized,
    from: extra.from || undefined,
    requestId: extra.requestId || undefined,
    ts: Date.now()
  }
}

/**
 * @deprecated Use buildCameraRequestMessage. Still builds modern envelope
 * when action is request/accept/reject; otherwise returns null (no publish).
 */
export function buildMediaModeMessage(action, extra = {}) {
  const cam = normalizeCameraRequestAction(action)
  if (cam) return buildCameraRequestMessage(cam, extra)
  // Do not emit switch_audio / switch_video / mode_sync anymore
  return null
}

/**
 * Pure FSM transition for camera request UI state.
 * Local camera enable is never implied by transitions alone.
 *
 * @param {string} state  CameraRequestState value
 * @param {string} event  'send'|'receive'|'accept'|'reject'|'expire'|'clear'
 * @returns {string}
 */
export function reduceCameraRequestState(state, event) {
  const S = CameraRequestState
  const cur = state || S.Idle
  switch (event) {
    case 'send':
      return S.Sent
    case 'receive':
      return S.Received
    case 'accept':
      return cur === S.Received || cur === S.Sent ? S.Accepted : cur
    case 'reject':
      return cur === S.Received || cur === S.Sent ? S.Rejected : cur
    case 'expire':
      return cur === S.Sent ? S.Expired : cur
    case 'clear':
      return S.Idle
    default:
      return cur
  }
}

/**
 * Join-time preference → desired local camera (not a session mode).
 * @param {'audio'|'video'|string} initialMediaMode
 * @returns {boolean}
 */
export function desiredCameraFromInitialMode(initialMediaMode) {
  return normalizeInitialMediaMode(initialMediaMode) !== 'audio'
}

/**
 * Decide audioOnly for MediaEngine.connect / acquireLocalTracks.
 * After the user has changed camera intent, prefer desiredCameraEnabled.
 *
 * @param {{
 *   mediaSessionStarted?: boolean,
 *   desiredCameraEnabled?: boolean,
 *   initialMediaMode?: string
 * }} opts
 * @returns {boolean} true → acquire mic only (no camera permission request)
 */
export function shouldJoinAudioOnly(opts = {}) {
  if (opts.mediaSessionStarted) {
    return !opts.desiredCameraEnabled
  }
  if (typeof opts.desiredCameraEnabled === 'boolean') {
    return !opts.desiredCameraEnabled
  }
  return !desiredCameraFromInitialMode(opts.initialMediaMode)
}

/**
 * Publish reliable data to room peers.
 * @param {import('livekit-client').Room|null|undefined} room
 * @param {object|null} message
 */
export async function publishMediaModeMessage(room, message) {
  if (!room?.localParticipant || !message) return false
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(message))
    await room.localParticipant.publishData(bytes, { reliable: true })
    return true
  } catch (e) {
    console.warn('[camera-request] publish failed', e)
    return false
  }
}

export async function publishCameraRequest(room, action, extra = {}) {
  return publishMediaModeMessage(room, buildCameraRequestMessage(action, extra))
}

/**
 * Parse DataReceived payload (Uint8Array or ArrayBuffer).
 * @param {ArrayBuffer|Uint8Array} payload
 * @returns {object|null}
 */
export function parseDataPayload(payload) {
  try {
    const u8 = payload instanceof Uint8Array ? payload : new Uint8Array(payload)
    return JSON.parse(new TextDecoder().decode(u8))
  } catch {
    return null
  }
}
