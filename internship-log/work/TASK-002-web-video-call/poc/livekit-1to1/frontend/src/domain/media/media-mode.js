/**
 * @file domain/media/media-mode.js
 * Runtime audio ↔ video session mode over LiveKit Data channel.
 *
 * Message envelope:
 *   { type: 'media_mode', action, mode?, from?, ts }
 *
 * Actions:
 *   - switch_video   — local party enabled video; peer should enter video UI
 *   - switch_audio   — local party went audio-only; peer should enter audio UI
 *   - request_video  — ask peer to enable camera (staff → visitor typical)
 *   - accept_video   — peer accepted request; both go video
 *   - reject_video   — peer declined request
 *   - mode_sync      — announce current mode (after join)
 */

export const MEDIA_MODE_TYPE = 'media_mode'

export const MediaModeAction = Object.freeze({
  SwitchVideo: 'switch_video',
  SwitchAudio: 'switch_audio',
  RequestVideo: 'request_video',
  AcceptVideo: 'accept_video',
  RejectVideo: 'reject_video',
  ModeSync: 'mode_sync'
})

/**
 * @param {string|null|undefined} mode
 * @returns {'audio'|'video'}
 */
export function normalizeSessionMediaMode(mode) {
  const m = String(mode || '').toLowerCase()
  return m === 'audio' ? 'audio' : 'video'
}

/**
 * @param {object} msg
 * @returns {boolean}
 */
export function isMediaModeMessage(msg) {
  return !!msg && msg.type === MEDIA_MODE_TYPE && typeof msg.action === 'string'
}

/**
 * @param {string} action
 * @param {{ mode?: string, from?: string }} [extra]
 */
export function buildMediaModeMessage(action, extra = {}) {
  return {
    type: MEDIA_MODE_TYPE,
    action,
    mode: extra.mode ? normalizeSessionMediaMode(extra.mode) : undefined,
    from: extra.from || undefined,
    ts: Date.now()
  }
}

/**
 * Publish reliable data to room peers.
 * @param {import('livekit-client').Room|null|undefined} room
 * @param {object} message
 */
export async function publishMediaModeMessage(room, message) {
  if (!room?.localParticipant) return false
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(message))
    await room.localParticipant.publishData(bytes, { reliable: true })
    return true
  } catch (e) {
    console.warn('[media-mode] publish failed', e)
    return false
  }
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
