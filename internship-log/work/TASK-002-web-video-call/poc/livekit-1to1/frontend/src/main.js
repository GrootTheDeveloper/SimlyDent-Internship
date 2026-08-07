import Vue from 'vue/dist/vue.esm.js'
import * as signalR from '@microsoft/signalr'
import {
  createLocalTracks,
  LocalVideoTrack,
  Room,
  RoomEvent,
  Track,
  VideoPreset,
  VideoPresets
} from 'livekit-client'
import './style.css'

const API_URL = typeof import.meta.env.VITE_API_URL === 'string'
  ? import.meta.env.VITE_API_URL
  : (window.location.hostname === 'localhost' ? 'http://localhost:5080' : '')

// ---- Auth (production-shaped SPA): JWT access token in localStorage ----
// Real products often put refresh token in HttpOnly cookie; access token short-lived.
const AUTH_TOKEN_KEY = 'simlydent_access_token'
const AUTH_USER_KEY = 'simlydent_auth_user'
const DEMO_PASSWORD_HINT = 'Demo@123'

function getAccessToken() {
  try {
    return localStorage.getItem(AUTH_TOKEN_KEY) || ''
  } catch {
    return ''
  }
}

function setAuthSession(accessToken, user) {
  localStorage.setItem(AUTH_TOKEN_KEY, accessToken)
  localStorage.setItem(AUTH_USER_KEY, JSON.stringify(user))
}

function clearAuthSession() {
  localStorage.removeItem(AUTH_TOKEN_KEY)
  localStorage.removeItem(AUTH_USER_KEY)
}

function readCachedUser() {
  try {
    const raw = localStorage.getItem(AUTH_USER_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

/** Headers for authenticated API calls (Bearer JWT). */
function authHeaders(extra = {}) {
  const headers = { ...extra }
  const token = getAccessToken()
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

/** Canonical clinic id from auth user DTO (clinicId preferred; tenantId is legacy alias). */
function clinicIdOf(userOrIdentity) {
  return userOrIdentity?.clinicId || userOrIdentity?.tenantId || ''
}

/** Embed visitors use CallerId = visitor:{sessionId} — too long for staff UI. */
function isEmbedVisitorId(id) {
  return typeof id === 'string' && id.toLowerCase().startsWith('visitor:')
}

/** Short stable code from embed session id (first 6 hex chars). */
function visitorShortCode(id) {
  if (!isEmbedVisitorId(id)) return ''
  const raw = id.slice('visitor:'.length).replace(/[^a-fA-F0-9]/g, '')
  return (raw.slice(0, 6) || '------').toUpperCase()
}

/**
 * Human label for staff surfaces. Never show full visitor:{guid} as the title.
 * @param {string} id
 * @param {{ displayName?: string } | null} [known]
 */
function peerLabel(id, known = null) {
  if (known?.displayName && known.displayName !== id) return known.displayName
  if (isEmbedVisitorId(id)) return `Khách #${visitorShortCode(id)}`
  if (!id) return '—'
  // Demo queue visitors VA/VB without directory hit
  if (/^V[A-Z0-9]+$/i.test(id)) return `Khách ${id.toUpperCase()}`
  return id
}

/** Compact avatar initials (never the full visitor GUID). */
function peerAvatarText(id, known = null) {
  if (known?.displayName && known.displayName !== id) {
    return initialsFromDisplayName(known.displayName, id)
  }
  if (isEmbedVisitorId(id)) return 'K'
  if (!id) return '?'
  return String(id).slice(0, 2).toUpperCase()
}

/** Initials for directory / login avatars (prefer display name). */
function initialsFromDisplayName(displayName, fallbackId = '') {
  const name = String(displayName || '').trim()
  if (name) {
    const parts = name.split(/\s+/).filter(Boolean)
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    }
    return name.slice(0, 2).toUpperCase()
  }
  if (fallbackId) return String(fallbackId).slice(0, 2).toUpperCase()
  return '?'
}

function userInitials(user) {
  if (!user) return '?'
  return initialsFromDisplayName(user.displayName, user.id)
}

const GUEST_AVATAR_URL = '/assets/guest-avatar.svg'

function agentBadgeClass(state) {
  const s = String(state || 'Offline').toLowerCase()
  if (s === 'available') return 'agent-badge agent-badge--available'
  if (s === 'ringing') return 'agent-badge agent-badge--ringing'
  if (s === 'incall') return 'agent-badge agent-badge--incall'
  return 'agent-badge agent-badge--offline'
}

/** Staff status for doctors / consultants (never raw English enums). */
function agentBadgeLabel(state) {
  const s = String(state || 'Offline')
  if (s === 'Available') return 'Sẵn sàng'
  if (s === 'Ringing') return 'Đang đổ chuông'
  if (s === 'InCall') return 'Đang tư vấn'
  return 'Ngoại tuyến'
}

/** Call lifecycle status for staff UI. */
function callStatusVi(status) {
  switch (status) {
    case 'Queued': return 'Đang chờ'
    case 'Ringing': return 'Đang đổ chuông'
    case 'Accepted': return 'Đang tư vấn'
    case 'Rejected': return 'Đã từ chối'
    case 'Cancelled': return 'Đã hủy'
    case 'Ended': return 'Đã kết thúc'
    case 'Timeout': return 'Hết thời gian chờ'
    case 'NoAgent': return 'Chưa có nhân viên nhận'
    case 'Closed': return 'Phòng khám đang đóng'
    default: return status || '—'
  }
}

function formatQueueLabel(item) {
  if (!item) return 'Khách'
  if (item.callerLabel) return item.callerLabel
  return peerLabel(item.callerId)
}

function queueStatusVi(status) {
  return callStatusVi(status)
}

function clinicDisplayName(clinicId) {
  if (!clinicId) return 'Phòng khám'
  if (clinicId === 'clinic-a') return 'Phòng khám A'
  if (clinicId === 'clinic-b') return 'Phòng khám B'
  return String(clinicId).replace(/^clinic-/i, 'Phòng khám ')
}

function roleDisplayName(role) {
  if (!role || role === 'Staff') return 'Nhân viên tư vấn'
  if (role === 'Visitor') return 'Khách'
  if (role === 'Admin' || role === 'Manager') return 'Quản lý'
  return role
}

function recordingModeLabel(mode) {
  if (mode === 'AudioOnly') return 'Chỉ ghi âm'
  if (mode === 'Video') return 'Ghi hình'
  return 'Không ghi'
}

function recordingStatusLabelVi(status) {
  switch (String(status || '')) {
    case 'Complete': return 'Sẵn sàng tải'
    case 'Failed': return 'Ghi lỗi'
    case 'Deleted': return 'Đã xóa'
    case 'Recording': return 'Đang ghi'
    case 'Starting': return 'Đang bắt đầu'
    case 'Stopping': return 'Đang dừng'
    case 'Idle': return 'Chưa ghi'
    default: return status || '—'
  }
}

function formatViDateTime(iso) {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return '—'
    return d.toLocaleString('vi-VN', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  } catch {
    return '—'
  }
}

function formatWaitSeconds(seconds) {
  const n = Number(seconds)
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 60) return `khoảng ${Math.floor(n)} giây`
  const m = Math.floor(n / 60)
  const s = Math.floor(n % 60)
  if (s === 0) return `khoảng ${m} phút`
  return `khoảng ${m} phút ${s} giây`
}

async function apiFetch(path, options = {}) {
  const headers = authHeaders(options.headers || {})
  const res = await fetch(`${API_URL}${path}`, { ...options, headers })
  if (res.status === 401 && !path.startsWith('/api/auth/login')) {
    // Token expired / invalid — force re-login on main app
    clearAuthSession()
  }
  return res
}

const initialQualityStats = () => ({
  incomingResolution: 'Chưa có',
  incomingFps: 0,
  incomingBitrateKbps: 0,
  packetLossPercent: 0,
  jitterMs: 0,
  roundTripTimeMs: 0,
  outgoingResolution: 'Chưa có',
  outgoingFps: 0,
  outgoingBitrateKbps: 0,
  qualityLimitationReason: 'none',
  codec: 'Chưa có'
})

const createClientSessionId = () => globalThis.crypto?.randomUUID?.()
  || `client-${Date.now()}-${Math.random().toString(16).slice(2)}`

const finiteOrNull = value => Number.isFinite(value) ? value : null

/** Prefer real device orientation so portrait callers are not cropped into 16:9. */
function isPortraitCapturePreferred() {
  try {
    const type = screen.orientation?.type || ''
    if (type.startsWith('portrait')) return true
    if (type.startsWith('landscape')) return false
  } catch {
    /* ignore */
  }
  if (typeof window.matchMedia === 'function') {
    if (window.matchMedia('(orientation: portrait)').matches) return true
    if (window.matchMedia('(orientation: landscape)').matches) return false
  }
  // visualViewport is more accurate on mobile browsers than innerWidth alone
  const vv = window.visualViewport
  if (vv && vv.height > 0 && vv.width > 0) return vv.height >= vv.width
  return window.innerHeight >= window.innerWidth
}

/**
 * Capture at sensor-friendly 1280×720. Do NOT request 720×1280 / aspectRatio 9:16
 * on portrait phones — browsers crop the sensor FOV to match, which feels "zoomed".
 * Portrait layout is handled later by contain-letterbox (publish + remote display).
 */
function preferredVideoCaptureResolution() {
  return VideoPresets.h720.resolution
}

/** Portrait simulcast layers (height-major) when publishing from a vertical device. */
function preferredSimulcastLayers() {
  if (!isPortraitCapturePreferred()) {
    return [VideoPresets.h540, VideoPresets.h216]
  }
  return [
    new VideoPreset(
      VideoPresets.h540.height,
      VideoPresets.h540.width,
      VideoPresets.h540.encoding.maxBitrate,
      VideoPresets.h540.encoding.maxFramerate
    ),
    new VideoPreset(
      VideoPresets.h216.height,
      VideoPresets.h216.width,
      VideoPresets.h216.encoding.maxBitrate,
      VideoPresets.h216.encoding.maxFramerate
    )
  ]
}

/**
 * =============================================================================
 * ROOT CAUSE (camera dọc nhưng remote ngang / hoặc portrait nhưng người nằm ngang)
 * =============================================================================
 *
 * Layer 1 — Sensor vs UI
 *   Phone UI is portrait, but most mobile camera sensors deliver a *landscape*
 *   buffer (e.g. 1280×720). "Cầm dọc" ≠ getUserMedia trả về 720×1280.
 *
 * Layer 2 — Local preview lies to you
 *   <video> on the phone often looks upright because the browser applies
 *   rotation for *display* (CSS / internal compositor / video metadata).
 *   That does NOT mean the raw samples WebRTC encodes are portrait or upright
 *   for every peer.
 *
 * Layer 3 — WebRTC / SFU drop rotation metadata
 *   Even when frames carry rotation (VideoFrame.rotation / RTP CVO), many paths
 *   (canvas, SFU, remote decoder) ignore it and show the buffer axes as-is →
 *   remote sees landscape or a sideways person.
 *
 * Layer 4 — Our previous bug (double rotation)
 *   We forced ctx.rotate(±90°) from screen.orientation while Chromium often
 *   already gives *upright pixels* to drawImage(video) even when
 *   videoWidth > videoHeight. Result: output size was portrait (good) but
 *   content was rotated an extra 90° (person lying on their side).
 *
 * CORRECT APPROACH
 *   1) Prefer VideoFrame.rotation via MediaStreamTrackProcessor — apply that
 *      angle ONCE when baking pixels, output rotation=0 portrait frames.
 *   2) Fallback: drawImage(video) with NO guessed rotation, then center-cover
 *      into a 9:16 canvas (assumes browser already uprighted samples for 2D).
 *   3) Never use screen.orientation.angle alone to invent a 90° turn.
 * =============================================================================
 */

async function waitForVideoFrame(video, timeoutMs = 4000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (video.videoWidth > 0 && video.videoHeight > 0) return
    await new Promise(r => setTimeout(r, 50))
  }
}

/**
 * Center-CONTAIN draw (full FOV). scale = min(...) so nothing is cropped.
 * Opposite of cover (max) which zoomed into the center and felt "phóng to".
 */
function containDraw(ctx, source, sw, sh, outW, outH) {
  if (!sw || !sh) return
  const scale = Math.min(outW / sw, outH / sh)
  const dw = sw * scale
  const dh = sh * scale
  const dx = (outW - dw) / 2
  const dy = (outH - dh) / 2
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, outW, outH)
  ctx.drawImage(source, dx, dy, dw, dh)
}

/**
 * Portrait publish box that can hold the full source without cropping.
 * For landscape source w×h: outH = h, outW = round(h * 9/16) so source fits by
 * height (contain) with side padding inside the portrait frame — no digital zoom.
 */
function portraitOutputSize(srcW, srcH) {
  if (srcH >= srcW && srcW > 0) {
    // Already portrait: keep native pixels (no rescale crop)
    return { outW: srcW, outH: srcH }
  }
  // Landscape sensor: portrait frame tall enough for full source height
  const outH = Math.max(srcH, 720)
  const outW = Math.max(2, Math.round((outH * 9) / 16))
  return { outW, outH }
}

/**
 * Upright pixel size of a VideoFrame WITHOUT applying rotation ourselves.
 * Prefer createImageBitmap (UA resolves orientation). Manual rotate is how we
 * previously got "portrait box + sideways person".
 */
async function uprightBitmapFromFrame(frame) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(frame)
    } catch {
      /* fall through */
    }
  }
  const w = frame.displayWidth || frame.codedWidth
  const h = frame.displayHeight || frame.codedHeight
  const mid = document.createElement('canvas')
  mid.width = Math.max(2, w)
  mid.height = Math.max(2, h)
  const mctx = mid.getContext('2d', { alpha: false })
  if (!mctx) return null
  try {
    // Let the UA draw; do not ctx.rotate(frame.rotation) here.
    mctx.drawImage(frame, 0, 0, mid.width, mid.height)
  } catch {
    return null
  }
  return mid
}

/**
 * Processor path: read VideoFrame → upright bitmap (UA) → contain into 9:16
 * (full FOV, letterbox inside portrait; never cover-crop / digital zoom).
 */
async function normalizePortraitViaVideoFrames(sourceTrack) {
  const mst = sourceTrack.mediaStreamTrack
  const processor = new MediaStreamTrackProcessor({ track: mst })
  const generator = new MediaStreamTrackGenerator({ kind: 'video' })
  const reader = processor.readable.getReader()
  const writer = generator.writable.getWriter()

  let stopped = false
  let canvas = null
  let ctx = null
  let logged = false

  const pump = async () => {
    try {
      while (!stopped) {
        const result = await reader.read()
        if (result.done || !result.value) break
        const frame = result.value
        try {
          const bitmap = await uprightBitmapFromFrame(frame)
          const bw = bitmap?.width || frame.displayWidth || frame.codedWidth
          const bh = bitmap?.height || frame.displayHeight || frame.codedHeight
          if (!canvas) {
            const { outW, outH } = bh >= bw
              ? { outW: bw, outH: bh }
              : portraitOutputSize(bw, bh)
            canvas = document.createElement('canvas')
            canvas.width = outW
            canvas.height = outH
            ctx = canvas.getContext('2d', { alpha: false })
            if (!logged) {
              console.info('[media] VideoFrame portrait bake', {
                coded: `${frame.codedWidth}x${frame.codedHeight}`,
                display: `${frame.displayWidth}x${frame.displayHeight}`,
                rotation: frame.rotation,
                bitmap: `${bw}x${bh}`,
                out: `${canvas.width}x${canvas.height}`
              })
              logged = true
            }
          }
          const ts = frame.timestamp
          frame.close()
          if (!ctx || !canvas || !bitmap) {
            if (bitmap && typeof bitmap.close === 'function') bitmap.close()
            continue
          }
          containDraw(ctx, bitmap, bitmap.width, bitmap.height, canvas.width, canvas.height)
          if (typeof bitmap.close === 'function') bitmap.close()
          const outFrame = new VideoFrame(canvas, {
            timestamp: ts,
            alpha: 'discard'
          })
          await writer.write(outFrame)
          outFrame.close()
        } catch (e) {
          try {
            frame.close()
          } catch {
            /* ignore */
          }
          console.warn('[media] VideoFrame bake frame error', e)
        }
      }
    } catch (e) {
      if (!stopped) console.warn('[media] VideoFrame pump ended', e)
    } finally {
      try {
        await writer.close()
      } catch {
        /* ignore */
      }
      try {
        reader.releaseLock()
      } catch {
        /* ignore */
      }
    }
  }

  pump()

  const normalizedTrack = new LocalVideoTrack(generator, undefined, true)
  normalizedTrack.source = Track.Source.Camera

  const cleanup = () => {
    stopped = true
    try {
      reader.cancel()
    } catch {
      /* ignore */
    }
    try {
      generator.stop()
    } catch {
      /* ignore */
    }
    try {
      sourceTrack.stop()
    } catch {
      /* ignore */
    }
  }

  return { track: normalizedTrack, cleanup, normalized: true }
}

/**
 * Fallback: NO manual ±90 from screen orientation.
 * drawImage(video) then center-CONTAIN into 9:16 — full FOV, no cover zoom.
 */
async function normalizePortraitViaCanvasCover(sourceTrack) {
  const mst = sourceTrack.mediaStreamTrack
  const video = document.createElement('video')
  video.playsInline = true
  video.setAttribute('playsinline', '')
  video.muted = true
  video.srcObject = new MediaStream([mst])
  try {
    await video.play()
  } catch (e) {
    console.warn('[media] canvas cover: video.play failed', e)
    return { track: sourceTrack, cleanup: () => {}, normalized: false }
  }
  await waitForVideoFrame(video)

  const vw = video.videoWidth
  const vh = video.videoHeight
  if (!vw || !vh) {
    video.srcObject = null
    return { track: sourceTrack, cleanup: () => {}, normalized: false }
  }
  // Already portrait samples — publish camera track as-is
  if (vh >= vw) {
    video.srcObject = null
    return { track: sourceTrack, cleanup: () => {}, normalized: false }
  }

  const { outW, outH } = portraitOutputSize(vw, vh)
  const canvas = document.createElement('canvas')
  canvas.width = outW
  canvas.height = outH
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) {
    video.srcObject = null
    return { track: sourceTrack, cleanup: () => {}, normalized: false }
  }

  let raf = 0
  let stopped = false
  const paint = () => {
    if (stopped) return
    // Critical: do NOT ctx.rotate based on screen.orientation — that double-rotates
    // on Chromium when drawImage already yields upright samples.
    // contain (not cover): keep full camera FOV; black bars inside portrait if needed.
    containDraw(ctx, video, video.videoWidth, video.videoHeight, outW, outH)
    raf = requestAnimationFrame(paint)
  }
  paint()

  const outStream = canvas.captureStream(30)
  const outMst = outStream.getVideoTracks()[0]
  if (!outMst) {
    stopped = true
    cancelAnimationFrame(raf)
    video.srcObject = null
    return { track: sourceTrack, cleanup: () => {}, normalized: false }
  }

  const normalizedTrack = new LocalVideoTrack(outMst, undefined, true)
  normalizedTrack.source = Track.Source.Camera

  console.info('[media] canvas contain portrait (full FOV, no zoom crop)', `${vw}x${vh}`, '→', `${outW}x${outH}`)

  const cleanup = () => {
    stopped = true
    cancelAnimationFrame(raf)
    try {
      outMst.stop()
    } catch {
      /* ignore */
    }
    try {
      sourceTrack.stop()
    } catch {
      /* ignore */
    }
    video.srcObject = null
  }

  return { track: normalizedTrack, cleanup, normalized: true }
}

/**
 * @param {import('livekit-client').LocalVideoTrack} sourceTrack
 */
async function normalizeToPortraitVideoTrack(sourceTrack) {
  const mst = sourceTrack.mediaStreamTrack
  if (!mst) {
    return { track: sourceTrack, cleanup: () => {}, normalized: false }
  }

  const canUseFrames =
    typeof MediaStreamTrackProcessor === 'function'
    && typeof MediaStreamTrackGenerator === 'function'
    && typeof VideoFrame === 'function'

  if (canUseFrames) {
    try {
      return await normalizePortraitViaVideoFrames(sourceTrack)
    } catch (e) {
      console.warn('[media] VideoFrame path failed, canvas cover fallback', e)
    }
  }
  return normalizePortraitViaCanvasCover(sourceTrack)
}

/**
 * If UI is portrait, ensure published camera track is portrait-sized + upright.
 * Returns { tracks, cleanup }.
 */
async function prepareLocalTracksForOrientation(localTracks) {
  const cleanupFns = []
  if (!isPortraitCapturePreferred()) {
    return {
      tracks: localTracks,
      cleanup: () => cleanupFns.forEach(fn => fn())
    }
  }

  const next = []
  for (const track of localTracks) {
    if (track.kind !== Track.Kind.Video) {
      next.push(track)
      continue
    }
    // Do not applyConstraints({ aspectRatio: 9/16 }) — that crops FOV (zoom).
    const settings = track.mediaStreamTrack?.getSettings?.() || {}
    if ((settings.height || 0) > (settings.width || 0)) {
      console.info('[media] native portrait track', settings.width, 'x', settings.height)
      next.push(track)
      continue
    }
    const { track: normalized, cleanup, normalized: used } = await normalizeToPortraitVideoTrack(track)
    if (used) cleanupFns.push(cleanup)
    next.push(normalized)
  }
  return {
    tracks: next,
    cleanup: () => cleanupFns.forEach(fn => fn())
  }
}

/**
 * Local PiP: size <video> to stream aspect within max box; host is fit-content
 * (no oversized grey frame — border is on the video itself).
 */
function applyLocalPipFit(element, hostEl) {
  const layout = () => {
    const vw = element.videoWidth || 0
    const vh = element.videoHeight || 0
    element.classList.remove('is-portrait', 'is-landscape')
    if (vw > 0 && vh > 0) {
      element.classList.add(vh > vw ? 'is-portrait' : 'is-landscape')
    }

    // Let CSS max-width/max-height + intrinsic ratio hug the frame.
    // Clear any previous remote letterbox pixel sizing.
    element.style.removeProperty('width')
    element.style.removeProperty('height')
    element.style.setProperty('width', 'auto', 'important')
    element.style.setProperty('height', 'auto', 'important')
    element.style.setProperty('object-fit', 'contain', 'important')
    element.style.setProperty('object-position', 'center center', 'important')

    if (vw > 0 && vh > 0 && hostEl) {
      // Optional: explicit pixel size so host fit-content is exact (no 1px gap)
      const maxW = Math.min(126, Math.floor(window.innerWidth * 0.28) || 126)
      const maxH = Math.min(168, Math.floor(window.innerHeight * 0.32) || 168)
      const scale = Math.min(maxW / vw, maxH / vh)
      const drawW = Math.max(1, Math.round(vw * scale))
      const drawH = Math.max(1, Math.round(vh * scale))
      element.style.setProperty('width', `${drawW}px`, 'important')
      element.style.setProperty('height', `${drawH}px`, 'important')
      hostEl.style.width = `${drawW}px`
      hostEl.style.height = `${drawH}px`
    }
  }

  layout()
  element.addEventListener('loadedmetadata', layout)
  element.addEventListener('resize', layout)
  element.addEventListener('playing', layout)
  window.addEventListener('resize', layout)
  element._letterboxOnWinResize = layout
}

/**
 * True letterbox layout for remote video on the main stage.
 *
 * Why object-fit alone failed:
 *   width:100% + height:100% makes the <video> *element* fill the landscape
 *   stage. We size the element to the largest rect that fits stream aspect —
 *   black bars are the host background.
 */
function applyVideoDisplayFit(element, hostEl = null) {
  if (!element) return

  if (hostEl?.classList?.contains('local-video-container')) {
    applyLocalPipFit(element, hostEl)
    return
  }

  const layout = () => {
    const vw = element.videoWidth || 0
    const vh = element.videoHeight || 0
    element.classList.remove('is-portrait', 'is-landscape')
    if (vw > 0 && vh > 0) {
      element.classList.add(vh > vw ? 'is-portrait' : 'is-landscape')
    }

    element.style.setProperty('object-fit', 'contain', 'important')
    element.style.setProperty('object-position', 'center center', 'important')
    element.style.setProperty('max-width', '100%', 'important')
    element.style.setProperty('max-height', '100%', 'important')

    if (!hostEl || vw <= 0 || vh <= 0) {
      element.style.setProperty('width', 'auto', 'important')
      element.style.setProperty('height', 'auto', 'important')
      return
    }

    const cw = hostEl.clientWidth
    const ch = hostEl.clientHeight
    if (cw <= 0 || ch <= 0) return

    const scale = Math.min(cw / vw, ch / vh)
    const drawW = Math.max(1, Math.floor(vw * scale))
    const drawH = Math.max(1, Math.floor(vh * scale))

    element.style.setProperty('width', `${drawW}px`, 'important')
    element.style.setProperty('height', `${drawH}px`, 'important')
  }

  layout()
  element.addEventListener('loadedmetadata', layout)
  element.addEventListener('resize', layout)
  element.addEventListener('playing', layout)

  if (hostEl && typeof ResizeObserver === 'function') {
    if (element._letterboxRO) {
      try {
        element._letterboxRO.disconnect()
      } catch {
        /* ignore */
      }
    }
    const ro = new ResizeObserver(() => layout())
    ro.observe(hostEl)
    element._letterboxRO = ro
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('resize', layout)
    element._letterboxOnWinResize = layout
  }
}

function cumulativeDelta(previous, key, current) {
  if (!Number.isFinite(current)) return null
  const oldValue = previous[key]
  previous[key] = current
  return Number.isFinite(oldValue) && current >= oldValue ? current - oldValue : 0
}

function readConnectionStats(report) {
  let transport = null
  let selectedPair = null
  report.forEach(stat => {
    if (stat.type === 'transport' && stat.selectedCandidatePairId) transport = stat
    if (stat.type === 'candidate-pair' && stat.state === 'succeeded' && stat.nominated) selectedPair = stat
  })
  if (transport?.selectedCandidatePairId) selectedPair = report.get(transport.selectedCandidatePairId) || selectedPair
  if (!selectedPair) return null
  const localCandidate = report.get(selectedPair.localCandidateId)
  const remoteCandidate = report.get(selectedPair.remoteCandidateId)
  return {
    protocol: localCandidate?.protocol || selectedPair.protocol || null,
    localCandidateType: localCandidate?.candidateType || null,
    remoteCandidateType: remoteCandidate?.candidateType || null,
    currentRoundTripTimeMs: Number.isFinite(selectedPair.currentRoundTripTime)
      ? selectedPair.currentRoundTripTime * 1000
      : null,
    availableOutgoingBitrateKbps: Number.isFinite(selectedPair.availableOutgoingBitrate)
      ? selectedPair.availableOutgoingBitrate / 1000
      : null,
    availableIncomingBitrateKbps: Number.isFinite(selectedPair.availableIncomingBitrate)
      ? selectedPair.availableIncomingBitrate / 1000
      : null
  }
}

async function readTrackStats(track, direction, previous) {
  const report = await track?.getRTCStatsReport?.()
  if (!report) return null
  let media = null
  let remoteInbound = null
  let codec = null
  report.forEach(stat => {
    if (stat.type === `${direction}-rtp` && !stat.isRemote && (stat.kind === 'video' || stat.mediaType === 'video')) media = stat
    if (stat.type === 'remote-inbound-rtp' && (stat.kind === 'video' || stat.mediaType === 'video')) remoteInbound = stat
  })
  if (!media) return null
  if (media.codecId) codec = report.get(media.codecId)

  const bytes = direction === 'inbound' ? media.bytesReceived : media.bytesSent
  let bitrateKbps = 0
  if (previous.timestamp && media.timestamp > previous.timestamp && bytes >= previous.bytes) {
    bitrateKbps = Math.round(((bytes - previous.bytes) * 8) / (media.timestamp - previous.timestamp))
  }
  previous.timestamp = media.timestamp
  previous.bytes = bytes
  const packetCount = direction === 'inbound' ? media.packetsReceived : media.packetsSent
  const packetDelta = cumulativeDelta(previous, 'packets', packetCount)
  const lossSource = direction === 'inbound' ? media : remoteInbound
  const lostDelta = cumulativeDelta(previous, 'packetsLost', lossSource?.packetsLost)
  const packetsTotal = direction === 'inbound'
    ? (packetDelta || 0) + (lostDelta || 0)
    : (packetDelta || 0)
  const framesCount = direction === 'inbound' ? media.framesDecoded : media.framesEncoded
  const framesDelta = cumulativeDelta(previous, 'frames', framesCount)
  const processingTotal = direction === 'inbound' ? media.totalDecodeTime : media.totalEncodeTime
  const processingDelta = cumulativeDelta(previous, 'processingTime', processingTotal)
  const qpDelta = cumulativeDelta(previous, 'qpSum', media.qpSum)
  const framesDroppedDelta = cumulativeDelta(previous, 'framesDropped', media.framesDropped)
  const freezeCountDelta = direction === 'inbound'
    ? cumulativeDelta(previous, 'freezeCount', media.freezeCount)
    : null
  const freezeDurationDelta = direction === 'inbound'
    ? cumulativeDelta(previous, 'freezeDuration', media.totalFreezesDuration)
    : null
  return {
    resolution: media.frameWidth && media.frameHeight ? `${media.frameWidth}×${media.frameHeight}` : 'Chưa có',
    width: finiteOrNull(media.frameWidth),
    height: finiteOrNull(media.frameHeight),
    fps: Math.round(media.framesPerSecond || 0),
    bitrateKbps,
    packetLossPercent: packetsTotal > 0 ? Number((((lostDelta || 0) / packetsTotal) * 100).toFixed(2)) : 0,
    jitterMs: Math.round((media.jitter || 0) * 1000),
    roundTripTimeMs: Math.round((remoteInbound?.roundTripTime || 0) * 1000),
    framesDroppedDelta,
    freezeCountDelta,
    freezeDurationDeltaMs: freezeDurationDelta === null ? null : Math.round(freezeDurationDelta * 1000),
    averageProcessingTimeMs: framesDelta > 0 && processingDelta !== null
      ? Number(((processingDelta / framesDelta) * 1000).toFixed(2))
      : null,
    averageQp: framesDelta > 0 && qpDelta !== null ? Number((qpDelta / framesDelta).toFixed(2)) : null,
    qualityLimitationReason: media.qualityLimitationReason || 'none',
    codec: codec?.mimeType?.replace('video/', '') || 'Chưa có',
    encoderImplementation: media.encoderImplementation || null,
    decoderImplementation: media.decoderImplementation || null,
    connection: readConnectionStats(report)
  }
}

function toTelemetryVideoStats(stats) {
  if (!stats) return null
  return {
    width: stats.width,
    height: stats.height,
    fps: stats.fps,
    bitrateKbps: stats.bitrateKbps,
    packetLossPercent: stats.packetLossPercent,
    jitterMs: stats.jitterMs,
    roundTripTimeMs: stats.roundTripTimeMs,
    framesDroppedDelta: stats.framesDroppedDelta,
    freezeCountDelta: stats.freezeCountDelta,
    freezeDurationDeltaMs: stats.freezeDurationDeltaMs,
    averageProcessingTimeMs: stats.averageProcessingTimeMs,
    averageQp: stats.averageQp,
    qualityLimitationReason: stats.qualityLimitationReason,
    codec: stats.codec,
    encoderImplementation: stats.encoderImplementation,
    decoderImplementation: stats.decoderImplementation
  }
}

function clientEnvironment(localVideoTrack) {
  const settings = localVideoTrack?.mediaStreamTrack?.getSettings?.() || {}
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection
  return {
    userAgent: navigator.userAgent || null,
    platform: navigator.userAgentData?.platform || navigator.platform || null,
    browserLanguage: navigator.language || null,
    hardwareConcurrency: finiteOrNull(navigator.hardwareConcurrency),
    deviceMemoryGb: finiteOrNull(navigator.deviceMemory),
    screenWidth: finiteOrNull(screen.width),
    screenHeight: finiteOrNull(screen.height),
    devicePixelRatio: finiteOrNull(window.devicePixelRatio),
    networkType: connection?.effectiveType || connection?.type || null,
    networkDownlinkMbps: finiteOrNull(connection?.downlink),
    networkRttMs: finiteOrNull(connection?.rtt),
    cameraDeviceId: settings.deviceId || null,
    cameraWidth: finiteOrNull(settings.width),
    cameraHeight: finiteOrNull(settings.height),
    cameraFrameRate: finiteOrNull(settings.frameRate)
  }
}

/**
 * Download recording via catalog-backed download-url (presign or proxy).
 * Shared by call window + main portal (two separate Vue apps).
 */
async function fetchAndSaveRecording(callId) {
  const metaRes = await apiFetch(`/api/calls/${callId}/recording/download-url`, {
    headers: authHeaders()
  })
  if (!metaRes.ok) {
    const body = await metaRes.json().catch(() => ({}))
    throw new Error(body.error || `Không lấy được link tải (HTTP ${metaRes.status})`)
  }
  const meta = await metaRes.json()
  const mode = meta.mode || 'proxy'
  const fileName = `recording-${String(callId).replace(/-/g, '')}.mp4`

  if (mode === 'presign' && meta.url) {
    // Browser hits Object Storage directly — no Bearer on storage host.
    const link = document.createElement('a')
    link.href = meta.url
    link.download = fileName
    link.rel = 'noopener'
    document.body.appendChild(link)
    link.click()
    link.remove()
    return
  }

  // Proxy: authenticated stream through API.
  const path = meta.url || `/api/calls/${callId}/recording/file`
  const res = await apiFetch(path, { headers: authHeaders() })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || `Không tải được file (HTTP ${res.status})`)
  }
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

/** Download consultation media asset (audio / clip / photo) via Manager endpoint. */
async function fetchAndSaveMediaAsset(assetId, kindHint = '') {
  const metaRes = await apiFetch(`/api/media/${assetId}/download-url`, {
    headers: authHeaders()
  })
  if (!metaRes.ok) {
    const body = await metaRes.json().catch(() => ({}))
    throw new Error(body.error || `Không lấy được link media (HTTP ${metaRes.status})`)
  }
  const meta = await metaRes.json()
  const ext = kindHint === 'CallAudio' || meta.kind === 'CallAudio'
    ? 'mp3'
    : (kindHint === 'Snapshot' || meta.kind === 'Snapshot' ? 'jpg' : 'mp4')
  const fileName = `media-${String(assetId).replace(/-/g, '')}.${ext}`

  if ((meta.mode || '') === 'presign' && meta.url) {
    const link = document.createElement('a')
    link.href = meta.url
    link.download = fileName
    link.rel = 'noopener'
    document.body.appendChild(link)
    link.click()
    link.remove()
    return
  }

  const path = meta.url || `/api/media/${assetId}/file`
  const res = await apiFetch(path, { headers: authHeaders() })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || `Không tải được media (HTTP ${res.status})`)
  }
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

/**
 * Patient-side: capture photo from local camera and PUT to presigned URL.
 * Invoked when RoomEvent.DataReceived carries type=capture_photo.
 */
async function captureLocalPhotoBlob(room) {
  const localVideoTrack = room?.localParticipant
    ?.getTrackPublication?.(Track.Source.Camera)?.track
    || room?.localParticipant
      ?.getTrackPublication?.(Track.Source.Camera)?.videoTrack
  const mst = localVideoTrack?.mediaStreamTrack
  if (!mst) {
    throw new Error('No local camera track for photo capture')
  }

  const settings = mst.getSettings?.() || {}
  let blob = null
  let actualWidth = settings.width || null
  let actualHeight = settings.height || null

  if (typeof ImageCapture !== 'undefined') {
    try {
      const capture = new ImageCapture(mst)
      const photoBlob = await capture.takePhoto()
      if (photoBlob instanceof Blob) blob = photoBlob
    } catch (e) {
      console.warn('ImageCapture.takePhoto failed, canvas fallback', e)
    }
  }

  if (!blob) {
    const canvas = document.createElement('canvas')
    canvas.width = settings.width || 1280
    canvas.height = settings.height || 720
    actualWidth = canvas.width
    actualHeight = canvas.height
    const videoEl = document.createElement('video')
    videoEl.muted = true
    videoEl.playsInline = true
    videoEl.srcObject = new MediaStream([mst])
    await videoEl.play()
    await new Promise(r => setTimeout(r, 50))
    canvas.getContext('2d').drawImage(videoEl, 0, 0, canvas.width, canvas.height)
    videoEl.pause()
    videoEl.srcObject = null
    blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.95))
  }

  if (!blob) throw new Error('Không chụp được ảnh')
  return { blob, actualWidth, actualHeight }
}

async function handleCapturePhotoCommand(room, msg) {
  if (!msg?.assetId) return
  const { blob, actualWidth, actualHeight } = await captureLocalPhotoBlob(room)
  const mode = msg.uploadMode || (msg.uploadUrl ? 'presign' : 'api')

  if (mode === 'presign' && msg.uploadUrl) {
    const putRes = await fetch(msg.uploadUrl, {
      method: 'PUT',
      body: blob,
      headers: { 'Content-Type': 'image/jpeg' }
    })
    if (!putRes.ok) {
      throw new Error(`Upload ảnh thất bại HTTP ${putRes.status}`)
    }
    // Notify backend (retry up to 3 times)
    let lastErr = null
    for (let i = 0; i < 3; i++) {
      try {
        const res = await apiFetch(`/api/media/${msg.assetId}/upload-complete`, {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            actualWidth,
            actualHeight,
            bytes: blob.size
          })
        })
        if (res.ok || res.status === 202) return
        const body = await res.json().catch(() => ({}))
        lastErr = new Error(body.error || `upload-complete HTTP ${res.status}`)
        await new Promise(r => setTimeout(r, 800 * (i + 1)))
      } catch (e) {
        lastErr = e
        await new Promise(r => setTimeout(r, 800 * (i + 1)))
      }
    }
    if (lastErr) throw lastErr
    return
  }

  // Local / API path: POST bytes to backend (Bearer JWT)
  const path = msg.uploadPath || `/api/media/${msg.assetId}/upload`
  const q = new URLSearchParams()
  if (actualWidth) q.set('w', String(actualWidth))
  if (actualHeight) q.set('h', String(actualHeight))
  const url = q.toString() ? `${path}?${q}` : path
  const res = await apiFetch(url, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'image/jpeg' }),
    body: blob
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || `API upload HTTP ${res.status}`)
  }
}

// Determine route mode
const path = window.location.pathname
const isCallRoute = path.startsWith('/call/')

if (isCallRoute) {
  // =========================================================================
  // 1. STANDALONE CALL WINDOW APP (/call/{callId})
  // =========================================================================
  const callId = path.replace('/call/', '').trim()
  // Identity comes from JWT session (not spoofable query alone).
  const cached = readCachedUser()
  const callQuery = new URLSearchParams(window.location.search)
  const userId = cached?.id || callQuery.get('user') || ''
  /**
   * URL/sessionStorage media= is a cache/hint only.
   * Authoritative source is call.initialMediaMode from the backend (set at call creation).
   */
  function normalizeMediaMode(value) {
    const v = String(value || '').toLowerCase()
    return v === 'audio' ? 'audio' : 'video'
  }
  let preferredMediaHint = normalizeMediaMode(callQuery.get('media') || 'video')
  try {
    const stored = sessionStorage.getItem('simlydent_preferred_media')
    if (stored && !callQuery.get('media')) preferredMediaHint = normalizeMediaMode(stored)
  } catch { /* ignore */ }

  function rtLog(event, detail) {
    const ts = new Date().toISOString()
    const extra = detail !== undefined ? ` ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''
    console.info(`[rt ${ts}] ${event}${extra}`)
  }

  new Vue({
    el: '#app',
    data: {
      callId,
      userId,
      /** Resolved authoritative mode: audio | video — prefer server call.initialMediaMode */
      preferredMediaMode: preferredMediaHint,
      currentUser: cached || null,
      identities: [],
      call: null,
      recordingCaps: { canStart: false, canStop: false, canDownload: false, canDelete: false },
      hub: null,
      room: null,
      localTracks: [],
      /** Stops canvas portrait pipeline (if used) */
      localMediaCleanup: null,
      connected: false,
      joining: false,
      mediaPermissionState: 'idle',
      cameraEnabled: preferredMediaHint !== 'audio',
      microphoneEnabled: true,
      cameraToggleBusy: false,
      intentionalLeave: false,
      reconnectNotice: '',
      remoteVideoConnected: false,
      needsAudioPermission: false,
      /** Consultation media (M2–M4) */
      dentalClipBusy: false,
      dentalClipStatus: 'Idle',
      dentalClipAssetId: null,
      photoBusy: false,
      photoStatus: '',
      qualityStats: initialQualityStats(),
      qualityStatsTimer: null,
      qualityStatsPrevious: { inbound: {}, outbound: {} },
      qualityClientSessionId: createClientSessionId(),
      qualityLogBuffer: [],
      qualityFlushTimer: null,
      qualityFlushInFlight: false,
      qualityFlushPromise: null,
      showQualityPanel: false,
      recordingBusy: false,
      error: '',
      broadcastChannel: null,
      guestAvatarUrl: GUEST_AVATAR_URL
    },
    computed: {
      peerId() {
        if (!this.call) return ''
        return this.call.callerId === this.userId ? this.call.calleeId : this.call.callerId
      },
      peerKnown() {
        return this.identities.find(i => i.id === this.peerId) || null
      },
      peerName() {
        return peerLabel(this.peerId, this.peerKnown)
      },
      peerAvatar() {
        return peerAvatarText(this.peerId, this.peerKnown)
      },
      isEmbedPeer() {
        return isEmbedVisitorId(this.peerId)
      },
      showRemotePlaceholder() {
        return this.mediaPermissionState === 'connected' && !this.remoteVideoConnected
      },
      remotePlaceholderText() {
        if (this.isEmbedPeer) return 'Khách đang tắt camera'
        return 'Đối phương đang tắt camera'
      },
      mediaSetupLabel() {
        if (this.mediaPermissionState === 'requesting') {
          return this.preferredMediaMode === 'audio'
            ? 'Đang xin quyền micro (thoại)…'
            : 'Đang xin quyền camera và micro…'
        }
        if (this.mediaPermissionState === 'connecting') {
          return this.preferredMediaMode === 'audio'
            ? 'Đang kết nối thoại…'
            : 'Đang kết nối video…'
        }
        if (this.mediaPermissionState === 'reconnecting') {
          return this.reconnectNotice || 'Đang kết nối lại media…'
        }
        if (this.mediaPermissionState === 'error') return this.error || 'Không kết nối được hình ảnh / âm thanh'
        if (this.mediaPermissionState === 'connected' && !this.remoteVideoConnected) {
          return this.isEmbedPeer
            ? 'Khách đang tắt camera (vẫn nghe được tiếng).'
            : 'Đối phương đang tắt camera.'
        }
        return this.preferredMediaMode === 'audio'
          ? 'Đang chuẩn bị micro…'
          : 'Đang chuẩn bị camera và micro…'
      },
      callStatusLabel() {
        if (!this.call) return 'Đang tải…'
        return callStatusVi(this.call.status)
      },
      qualityBadge() {
        const resolution = this.qualityStats.incomingResolution
        if (/1280×720|720×1280|1920×1080|1080×1920/.test(resolution)) return 'HD'
        if (/640×360|360×640/.test(resolution)) return 'SD'
        return this.remoteVideoConnected ? 'LOW' : '--'
      },
      isRecording() {
        return this.call?.recordingStatus === 'Recording'
      },
      recordingInProgress() {
        return ['Starting', 'Stopping'].includes(this.call?.recordingStatus)
      },
      recordingAvailable() {
        // Download is Manager-only; never offer staff default download.
        return this.isManagerRole && (this.recordingCaps?.canDownload || this.call?.recordingAvailable === true)
      },
      isManagerRole() {
        return String(this.currentUser?.role || this.userRole || '').toLowerCase() === 'manager'
      },
      recordingStatusLabel() {
        const s = this.call?.recordingStatus
        if (s === 'Recording') {
          return this.call?.recordingMode === 'AudioOnly' ? 'Đang ghi âm' : 'Đang ghi hình'
        }
        if (s === 'Starting') return 'Đang bắt đầu ghi…'
        if (s === 'Stopping') return 'Đang dừng ghi…'
        if (s === 'Complete') return 'Đã có bản ghi'
        if (s === 'Failed') return 'Ghi không thành công'
        if (s === 'Deleted') return 'Đã xóa bản ghi'
        return ''
      }
    },
    async mounted() {
      // Init BroadcastChannel
      if ('BroadcastChannel' in window) {
        this.broadcastChannel = new BroadcastChannel('livekit_call_channel')
        this.broadcastChannel.postMessage({ type: 'CALL_WINDOW_OPENED', callId: this.callId })
      }

      if (!getAccessToken()) {
        this.error = 'Chưa đăng nhập. Hãy mở trang chính và login trước.'
        return
      }
      // Resolve identity from JWT (source of truth)
      try {
        const meRes = await apiFetch('/api/auth/me')
        if (meRes.ok) {
          const me = await meRes.json()
          this.userId = me.id
        } else {
          this.error = 'Phiên đăng nhập hết hạn. Hãy login lại trên trang chính.'
          return
        }
      } catch (e) {
        this.error = 'Không xác thực được phiên: ' + e.message
        return
      }

      await this.loadIdentities()
      await this.verifyAndConnect()

      window.addEventListener('beforeunload', this.handleBeforeUnload)
    },
    beforeDestroy() {
      this.disconnectRoom()
      if (this.hub) this.hub.stop()
      if (this.broadcastChannel) {
        this.broadcastChannel.postMessage({ type: 'CALL_WINDOW_CLOSED', callId: this.callId })
        this.broadcastChannel.close()
      }
      window.removeEventListener('beforeunload', this.handleBeforeUnload)
    },
    methods: {
      async loadIdentities() {
        try {
          const res = await apiFetch(`/api/identities`)
          this.identities = await res.json()
        } catch (e) {
          console.error(e)
        }
      },
      /**
       * Authoritative initial media from server CallView.
       * URL/sessionStorage is only a fallback when older backend lacks the field.
       */
      applyAuthoritativeMediaMode(call) {
        const serverMode = call?.initialMediaMode || call?.InitialMediaMode
        if (serverMode) {
          this.preferredMediaMode = normalizeMediaMode(serverMode)
        } else if (this.preferredMediaMode) {
          // keep URL/session hint
        } else {
          this.preferredMediaMode = 'video'
        }
        // Only seed cameraEnabled before join; after connect LiveKit is truth.
        if (!this.room) {
          this.cameraEnabled = this.preferredMediaMode !== 'audio'
        }
        try {
          sessionStorage.setItem('simlydent_preferred_media', this.preferredMediaMode)
        } catch { /* ignore */ }
        rtLog('media_mode_resolved', {
          preferred: this.preferredMediaMode,
          server: serverMode || null,
          urlHint: preferredMediaHint
        })
      },
      async verifyAndConnect() {
        try {
          // Connect SignalR first for realtime updates
          await this.connectRealtime()

          // Verify Call with Backend
          const res = await apiFetch(`/api/calls/${this.callId}`, {
            headers: authHeaders()
          })
          if (!res.ok) {
            throw new Error('Cuộc gọi không tồn tại hoặc bạn không có quyền truy cập.')
          }
          this.call = await res.json()
          this.applyAuthoritativeMediaMode(this.call)

          // If Call is accepted, join LiveKit room
          if (this.call.status === 'Accepted') {
            await this.joinRoom()
          } else if (['Rejected', 'Cancelled', 'Ended'].includes(this.call.status)) {
            this.handleCallEnded()
          }
        } catch (err) {
          this.error = err.message
        }
      },
      async connectRealtime() {
        if (this.hub) await this.hub.stop()
        this.hub = new signalR.HubConnectionBuilder()
          .withUrl(`${API_URL}/hubs/calls`, {
            accessTokenFactory: () => getAccessToken()
          })
          .withAutomaticReconnect()
          .build()

        this.hub.on('CallUpdated', async call => {
          if (call.id !== this.callId) return
          const prevStatus = this.call?.status
          this.call = call
          this.applyAuthoritativeMediaMode(call)
          rtLog('CallUpdated', { status: call.status, initialMediaMode: call.initialMediaMode })

          if (call.status === 'Accepted' && prevStatus !== 'Accepted') {
            await this.joinRoom()
          } else if (['Rejected', 'Cancelled', 'Ended'].includes(call.status)) {
            // Business call terminal — not the same as WebRTC blip
            this.intentionalLeave = true
            this.handleCallEnded()
          }
        })
        await this.hub.start()
        this.connected = true
      },
      async joinRoom() {
        if (this.room || this.joining) return
        this.joining = true
        this.intentionalLeave = false
        this.reconnectNotice = ''
        try {
          // Re-resolve media mode from latest call (server wins)
          if (this.call) this.applyAuthoritativeMediaMode(this.call)

          // Fetch Media Token
          const res = await apiFetch(`/api/calls/${this.callId}/token`, {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' })
          })
          if (!res.ok) {
            const errData = await res.json().catch(() => ({}))
            throw new Error(errData.error || 'Không thể lấy Token kết nối media')
          }
          const credentials = await res.json()

          this.mediaPermissionState = 'requesting'
          let localTracks = []
          const audioOnly = this.preferredMediaMode === 'audio'
          rtLog('joinRoom_media', { audioOnly, preferredMediaMode: this.preferredMediaMode })
          try {
            if (audioOnly) {
              localTracks = await createLocalTracks({
                audio: {
                  echoCancellation: true,
                  noiseSuppression: true,
                  autoGainControl: true
                },
                video: false
              })
              this.cameraEnabled = false
            } else {
              const captureResolution = preferredVideoCaptureResolution()
              localTracks = await createLocalTracks({
                audio: {
                  echoCancellation: true,
                  noiseSuppression: true,
                  autoGainControl: true
                },
                video: {
                  facingMode: 'user',
                  resolution: captureResolution
                }
              })
              const prepared = await prepareLocalTracksForOrientation(localTracks)
              localTracks = prepared.tracks
              if (typeof this.localMediaCleanup === 'function') this.localMediaCleanup()
              this.localMediaCleanup = prepared.cleanup
            }
          } catch (e) {
            console.warn('Could not start preferred media, trying audio only:', e)
            try {
              localTracks = await createLocalTracks({ audio: true, video: false })
              this.cameraEnabled = false
            } catch (e2) {
              // Staff may still join receive-only if devices fully denied.
              console.warn('Audio also failed; joining without local tracks:', e2)
              localTracks = []
              this.cameraEnabled = false
              this.microphoneEnabled = false
            }
          }
          this.localTracks = localTracks
          this.$nextTick(() => {
            this.attachLocalVideo()
          })

          this.mediaPermissionState = 'connecting'
          // Portrait phones often need a single canvas layer; multi-layer simulcast
          // can re-encode oddly and look "landscape cropped" on the far side.
          const portraitPublish = isPortraitCapturePreferred()
          const room = new Room({
            adaptiveStream: true,
            dynacast: true,
            publishDefaults: {
              simulcast: !portraitPublish,
              videoCodec: 'vp8',
              videoSimulcastLayers: portraitPublish ? [] : preferredSimulcastLayers()
            }
          })
          room.on(RoomEvent.TrackSubscribed, track => {
            rtLog('TrackSubscribed', { kind: track?.kind, sid: track?.sid })
            this.attachRemoteTrack(track)
          })
          room.on(RoomEvent.TrackPublished, publication => {
            rtLog('TrackPublished', { kind: publication?.kind, sid: publication?.trackSid })
            publication.setSubscribed(true)
          })
          room.on(RoomEvent.TrackSubscriptionFailed, () => {
            this.remoteVideoConnected = false
          })
          room.on(RoomEvent.TrackUnsubscribed, track => {
            rtLog('TrackUnsubscribed', { kind: track?.kind, sid: track?.sid })
            track.detach().forEach(node => node.remove())
            if (track.kind === Track.Kind.Video) this.remoteVideoConnected = false
          })
          // Mid-call cam toggle: muted → placeholder; unmuted → video again.
          room.on(RoomEvent.TrackMuted, (publication, participant) => {
            rtLog('TrackMuted', {
              kind: publication?.kind,
              local: participant?.isLocal,
              sid: publication?.trackSid
            })
            if (participant?.isLocal) {
              this.reconcileLocalMediaUi()
              return
            }
            if (publication?.kind === Track.Kind.Video || publication?.track?.kind === Track.Kind.Video) {
              this.remoteVideoConnected = false
            }
          })
          room.on(RoomEvent.TrackUnmuted, (publication, participant) => {
            rtLog('TrackUnmuted', {
              kind: publication?.kind,
              local: participant?.isLocal,
              sid: publication?.trackSid
            })
            if (participant?.isLocal) {
              this.reconcileLocalMediaUi()
              if (this.cameraEnabled) this.attachLocalVideo()
              return
            }
            if (publication?.kind === Track.Kind.Video || publication?.track?.kind === Track.Kind.Video) {
              if (publication.track) this.attachRemoteTrack(publication.track)
              else this.remoteVideoConnected = true
            }
          })
          room.on(RoomEvent.LocalTrackPublished, (publication) => {
            rtLog('LocalTrackPublished', { kind: publication?.kind, sid: publication?.trackSid })
            this.reconcileLocalMediaUi()
            if (publication?.kind === Track.Kind.Video) this.attachLocalVideo()
          })
          room.on(RoomEvent.LocalTrackUnpublished, (publication) => {
            rtLog('LocalTrackUnpublished', { kind: publication?.kind, sid: publication?.trackSid })
            this.reconcileLocalMediaUi()
            if (publication?.kind === Track.Kind.Video && this.$refs.localMedia) {
              this.$refs.localMedia.replaceChildren()
            }
          })
          room.on(RoomEvent.ParticipantConnected, (p) => {
            rtLog('ParticipantConnected', p?.identity)
          })
          room.on(RoomEvent.ParticipantDisconnected, (p) => {
            rtLog('ParticipantDisconnected', p?.identity)
          })
          room.on(RoomEvent.AudioPlaybackStatusChanged, () => {
            this.needsAudioPermission = !room.canPlaybackAudio
          })
          // WebRTC reconnect ≠ business Call Ended. Only leave UI on intentional hangup
          // or when CallUpdated says status is terminal.
          room.on(RoomEvent.Reconnecting, () => {
            rtLog('Reconnecting')
            this.mediaPermissionState = 'reconnecting'
            this.reconnectNotice = 'Mạng media đang reconnect… cuộc gọi business vẫn mở.'
          })
          room.on(RoomEvent.Reconnected, () => {
            rtLog('Reconnected')
            this.mediaPermissionState = 'connected'
            this.reconnectNotice = ''
            this.reconcileLocalMediaUi()
            this.attachAvailableRemoteTracks()
          })
          room.on(RoomEvent.Disconnected, (reason) => {
            const reasonStr = reason != null ? String(reason) : 'unknown'
            rtLog('Disconnected', reasonStr)
            if (this.intentionalLeave || this._endingCall) {
              this.handleCallEnded()
              return
            }
            if (this.call && ['Rejected', 'Cancelled', 'Ended'].includes(this.call.status)) {
              this.handleCallEnded()
              return
            }
            // Unexpected permanent media loss — keep call window, allow rejoin
            this.room = null
            this.mediaPermissionState = 'error'
            this.error = `Mất kết nối media (${reasonStr}). Cuộc gọi chưa kết thúc — bấm Tham gia lại.`
            this.stopQualityMonitoring?.()
          })
          // Snapshot command from backend RoomService.SendData (targeted to patient)
          room.on(RoomEvent.DataReceived, async (payload, participant, kind) => {
            let msg
            try {
              msg = JSON.parse(new TextDecoder().decode(payload))
            } catch {
              return
            }
            if (msg?.type !== 'capture_photo') return
            try {
              this.photoStatus = 'Đang chụp…'
              await handleCapturePhotoCommand(room, msg)
              this.photoStatus = 'Đã gửi ảnh'
            } catch (e) {
              console.warn('capture_photo failed', e)
              this.photoStatus = e.message || 'Chụp ảnh thất bại'
              this.error = this.photoStatus
            }
          })

          await room.connect(credentials.url, credentials.token, {
            websocketTimeout: 15000,
            peerConnectionTimeout: 15000
          })
          this.room = room
          this.attachAvailableRemoteTracks()

          for (const track of localTracks) {
            await room.localParticipant.publishTrack(track)
          }

          this.mediaPermissionState = 'connected'
          this.startQualityMonitoring()
          this.$nextTick(() => {
            this.attachLocalVideo()
          })
        } catch (err) {
          if (this.room) await this.room.disconnect()
          this.room = null
          if (typeof this.localMediaCleanup === 'function') {
            this.localMediaCleanup()
            this.localMediaCleanup = null
          }
          this.localTracks.forEach(t => t.stop())
          this.localTracks = []
          this.mediaPermissionState = 'error'
          const message = String(err?.message || err)
          this.error = /peer connection|pc connection|ice/i.test(message)
            ? 'Không thể thiết lập đường truyền media. Wi-Fi đang chặn kết nối trực tiếp hoặc hệ thống chưa có TURN.'
            : message
        } finally {
          this.joining = false
        }
      },
      attachRemoteTrack(track) {
        const element = track.attach()
        element.autoplay = true
        if (track.kind === Track.Kind.Video) {
          element.muted = true
          element.playsInline = true
          element.setAttribute('playsinline', '')
          element.setAttribute('webkit-playsinline', '')
          const host = this.$refs.remoteMedia
          applyVideoDisplayFit(element, host)
          if (host) {
            host.querySelectorAll('video').forEach(n => n.remove())
            host.appendChild(element)
            this.remoteVideoConnected = true
            element.play().catch(() => {})
          }
        } else if (this.$refs.remoteAudio) {
          this.$refs.remoteAudio.querySelectorAll('audio').forEach(n => n.remove())
          this.$refs.remoteAudio.appendChild(element)
          element.play().catch(() => {
            this.needsAudioPermission = true
          })
        }
      },
      attachAvailableRemoteTracks() {
        if (!this.room) return
        for (const participant of this.room.remoteParticipants.values()) {
          for (const publication of participant.trackPublications.values()) {
            publication.setSubscribed(true)
            if (publication.track) this.attachRemoteTrack(publication.track)
          }
        }
      },
      attachLocalVideo() {
        if (!this.$refs.localMedia) return
        const publication = this.getLocalCameraPublication()
        const track = this.localTracks.find(item => item.kind === Track.Kind.Video) || publication?.track
        if (!track) return
        const element = track.attach()
        element.autoplay = true
        element.muted = true
        element.playsInline = true
        element.setAttribute('playsinline', '')
        element.setAttribute('webkit-playsinline', '')
        applyVideoDisplayFit(element, this.$refs.localMedia)
        this.$refs.localMedia.replaceChildren(element)
        element.play().catch(() => {})
      },
      getLocalCameraPublication() {
        if (!this.room?.localParticipant) return null
        const pubs = [...this.room.localParticipant.videoTrackPublications.values()]
        return pubs[0] || null
      },
      /** Read camera/mic truth from LiveKit publications — not Vue flags. */
      reconcileLocalMediaUi() {
        if (!this.room?.localParticipant) return
        const camPub = this.getLocalCameraPublication()
        const camOn = !!(
          camPub &&
          !camPub.isMuted &&
          camPub.track &&
          !camPub.track.isMuted
        )
        this.cameraEnabled = camOn
        const micPubs = [...this.room.localParticipant.audioTrackPublications.values()]
        const micPub = micPubs[0]
        if (micPub) {
          this.microphoneEnabled = !micPub.isMuted && !!micPub.track && !micPub.track.isMuted
        }
      },
      /**
       * Single path for camera on/off. Operates on LocalParticipant, then
       * re-reads publication state into UI. Do not flip Vue flags first.
       */
      async ensureCameraEnabled(wantEnabled) {
        if (!this.room?.localParticipant) return false
        if (this.cameraToggleBusy) return this.cameraEnabled
        this.cameraToggleBusy = true
        try {
          this.reconcileLocalMediaUi()
          if (this.cameraEnabled === !!wantEnabled) {
            if (wantEnabled) this.attachLocalVideo()
            else if (this.$refs.localMedia) this.$refs.localMedia.replaceChildren()
            return this.cameraEnabled
          }
          rtLog('ensureCameraEnabled', { want: !!wantEnabled, before: this.cameraEnabled })
          await this.room.localParticipant.setCameraEnabled(!!wantEnabled)
          // Re-read actual publication/mute after LiveKit settles
          this.reconcileLocalMediaUi()
          if (this.cameraEnabled) this.attachLocalVideo()
          else if (this.$refs.localMedia) this.$refs.localMedia.replaceChildren()
          rtLog('ensureCameraEnabled_done', { after: this.cameraEnabled })
          return this.cameraEnabled
        } catch (e) {
          console.warn('ensureCameraEnabled failed', e)
          this.reconcileLocalMediaUi()
          this.error = wantEnabled
            ? (e?.message || 'Không bật được camera — đã giữ trạng thái thoại.')
            : (e?.message || 'Không tắt được camera.')
          return this.cameraEnabled
        } finally {
          this.cameraToggleBusy = false
        }
      },
      async toggleCamera() {
        if (!this.room) return
        await this.ensureCameraEnabled(!this.cameraEnabled)
      },
      async toggleMicrophone() {
        if (!this.room?.localParticipant) return
        try {
          const want = !this.microphoneEnabled
          await this.room.localParticipant.setMicrophoneEnabled(want)
          this.reconcileLocalMediaUi()
        } catch (e) {
          console.warn('toggleMicrophone failed', e)
          this.reconcileLocalMediaUi()
        }
      },
      async enableAudioPlayback() {
        if (this.room) {
          await this.room.startAudio()
          this.needsAudioPermission = !this.room.canPlaybackAudio
        }
      },
      /** LiveKit participant identity for remote patient (clinicId:userId). */
      resolvePatientParticipantIdentity() {
        if (!this.room || !this.call) return null
        const peerId = this.call.callerId === this.userId ? this.call.calleeId : this.call.callerId
        const clinic = clinicIdOf(this.currentUser) || this.call.clinicId || ''
        // Prefer remote participant that actually has a camera track
        for (const p of this.room.remoteParticipants.values()) {
          const id = p.identity || ''
          const pubs = [...(p.videoTrackPublications?.values?.() || p.trackPublications?.values?.() || [])]
          const hasCam = pubs.some(pub =>
            pub?.source === Track.Source.Camera
            || pub?.kind === Track.Kind.Video
            || pub?.track?.kind === Track.Kind.Video)
          if (hasCam && id) return id
        }
        for (const p of this.room.remoteParticipants.values()) {
          const id = p.identity || ''
          if (id === peerId || id.endsWith(':' + peerId) || (peerId && id.includes(peerId))) {
            return id
          }
        }
        // Fallback: convention {clinicId}:{userId}
        if (clinic && peerId) return `${clinic}:${peerId}`
        // Last resort: first remote identity
        const first = [...this.room.remoteParticipants.values()][0]
        return first?.identity || peerId || null
      },
      resolvePatientVideoTrackSid() {
        if (!this.room) return null
        for (const p of this.room.remoteParticipants.values()) {
          for (const pub of p.videoTrackPublications?.values?.() || p.trackPublications?.values?.() || []) {
            if (pub?.source === Track.Source.Camera || pub?.kind === Track.Kind.Video || pub?.track?.kind === Track.Kind.Video) {
              return pub.trackSid || pub.track?.sid || null
            }
          }
        }
        return null
      },
      async toggleDentalClip() {
        if (!this.callId || this.dentalClipBusy) return
        this.dentalClipBusy = true
        try {
          if (this.dentalClipStatus === 'Recording' && this.dentalClipAssetId) {
            const res = await apiFetch(
              `/api/calls/${this.callId}/video-clips/${this.dentalClipAssetId}/stop`,
              { method: 'POST', headers: authHeaders() }
            )
            const body = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(body.error || `Stop clip HTTP ${res.status}`)
            this.dentalClipStatus = 'Finalizing'
          } else {
            const patientIdentity = this.resolvePatientParticipantIdentity()
            if (!patientIdentity) throw new Error('Chưa thấy bệnh nhân trong room')
            const trackHint = this.resolvePatientVideoTrackSid()
            const remotePub = this.room
              ? [...this.room.remoteParticipants.values()][0]
              : null
            const settings = remotePub
              ? [...(remotePub.videoTrackPublications?.values?.() || [])][0]
                ?.track?.mediaStreamTrack?.getSettings?.()
              : null
            const res = await apiFetch(`/api/calls/${this.callId}/video-clips/start`, {
              method: 'POST',
              headers: authHeaders({ 'Content-Type': 'application/json' }),
              body: JSON.stringify({
                patientParticipantIdentity: patientIdentity,
                patientVideoTrackSidHint: trackHint,
                actualWidth: settings?.width || null,
                actualHeight: settings?.height || null,
                actualFrameRate: settings?.frameRate || null
              })
            })
            const body = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(body.error || `Start clip HTTP ${res.status}`)
            this.dentalClipAssetId = body.assetId
            this.dentalClipStatus = body.status || 'Recording'
          }
        } catch (e) {
          this.error = e.message
        } finally {
          this.dentalClipBusy = false
        }
      },
      async requestPhoto() {
        if (!this.callId || this.photoBusy) return
        this.photoBusy = true
        this.photoStatus = ''
        try {
          const patientIdentity = this.resolvePatientParticipantIdentity()
          if (!patientIdentity) throw new Error('Chưa thấy bệnh nhân trong room')
          const res = await apiFetch(`/api/calls/${this.callId}/photos/request`, {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ patientParticipantIdentity: patientIdentity })
          })
          const body = await res.json().catch(() => ({}))
          if (!res.ok) throw new Error(body.error || `Request photo HTTP ${res.status}`)
          this.photoStatus = 'Đã gửi lệnh chụp'
        } catch (e) {
          this.error = e.message
          this.photoStatus = e.message
        } finally {
          this.photoBusy = false
        }
      },
      startQualityMonitoring() {
        this.stopQualityMonitoring(false)
        this.qualityClientSessionId = createClientSessionId()
        this.qualityLogBuffer = []
        this.updateQualityStats()
        this.qualityStatsTimer = window.setInterval(() => this.updateQualityStats(), 2000)
        this.qualityFlushTimer = window.setInterval(() => this.flushQualityLog(), 10000)
      },
      stopQualityMonitoring(flush = true) {
        if (this.qualityStatsTimer) window.clearInterval(this.qualityStatsTimer)
        if (this.qualityFlushTimer) window.clearInterval(this.qualityFlushTimer)
        this.qualityStatsTimer = null
        this.qualityFlushTimer = null
        if (flush) this.flushQualityLog()
      },
      async updateQualityStats() {
        if (!this.room) return
        try {
          let remoteVideoTrack = null
          for (const participant of this.room.remoteParticipants.values()) {
            for (const publication of participant.videoTrackPublications.values()) {
              if (publication.track) remoteVideoTrack = publication.track
            }
          }
          const localVideoTrack = this.localTracks.find(track => track.kind === Track.Kind.Video)
          const [incoming, outgoing] = await Promise.all([
            readTrackStats(remoteVideoTrack, 'inbound', this.qualityStatsPrevious.inbound),
            readTrackStats(localVideoTrack, 'outbound', this.qualityStatsPrevious.outbound)
          ])
          if (incoming) {
            this.qualityStats.incomingResolution = incoming.resolution
            this.qualityStats.incomingFps = incoming.fps
            this.qualityStats.incomingBitrateKbps = incoming.bitrateKbps
            this.qualityStats.packetLossPercent = incoming.packetLossPercent
            this.qualityStats.jitterMs = incoming.jitterMs
            this.qualityStats.codec = incoming.codec
          }
          if (outgoing) {
            this.qualityStats.outgoingResolution = outgoing.resolution
            this.qualityStats.outgoingFps = outgoing.fps
            this.qualityStats.outgoingBitrateKbps = outgoing.bitrateKbps
            this.qualityStats.roundTripTimeMs = outgoing.roundTripTimeMs
            this.qualityStats.qualityLimitationReason = outgoing.qualityLimitationReason
          }
          if (incoming || outgoing) {
            this.qualityLogBuffer.push({
              timestamp: new Date().toISOString(),
              incoming: toTelemetryVideoStats(incoming),
              outgoing: toTelemetryVideoStats(outgoing),
              connection: outgoing?.connection || incoming?.connection || null
            })
            if (this.qualityLogBuffer.length >= 5) this.flushQualityLog()
          }
        } catch (err) {
          console.warn('Could not read WebRTC stats:', err)
        }
      },
      qualityBatch(samples) {
        const localVideoTrack = this.localTracks.find(track => track.kind === Track.Kind.Video)
        return {
          clientSessionId: this.qualityClientSessionId,
          environment: clientEnvironment(localVideoTrack),
          samples
        }
      },
      async flushQualityLog(useBeacon = false) {
        if (!this.qualityLogBuffer.length) return
        const samples = this.qualityLogBuffer.slice(0, 50)
        const payload = JSON.stringify(this.qualityBatch(samples))
        const url = `${API_URL}/api/calls/${this.callId}/quality/samples`
        if (useBeacon && navigator.sendBeacon) {
          const sent = navigator.sendBeacon(
            `${url}?access_token=${encodeURIComponent(getAccessToken())}`,
            new Blob([payload], { type: 'application/json' })
          )
          if (sent) this.qualityLogBuffer.splice(0, samples.length)
          return
        }
        if (this.qualityFlushInFlight) return this.qualityFlushPromise
        this.qualityFlushInFlight = true
        this.qualityFlushPromise = (async () => {
          try {
            const res = await fetch(url, {
              method: 'POST',
              headers: authHeaders({ 'Content-Type': 'application/json' }),
              body: payload,
              keepalive: true
            })
            if (!res.ok) throw new Error(`Quality telemetry returned HTTP ${res.status}`)
            this.qualityLogBuffer.splice(0, samples.length)
          } catch (err) {
            console.warn('Could not persist WebRTC quality telemetry:', err)
          } finally {
            this.qualityFlushInFlight = false
            this.qualityFlushPromise = null
          }
        })()
        return this.qualityFlushPromise
      },
      async downloadQualityLog(format) {
        try {
          await this.flushQualityLog()
          const res = await apiFetch(`/api/calls/${this.callId}/quality/export?format=${format}`, {
            headers: authHeaders()
          })
          if (!res.ok) {
            const body = await res.json().catch(() => ({}))
            throw new Error(body.error || 'Chưa có dữ liệu chất lượng để tải.')
          }
          const blob = await res.blob()
          const url = URL.createObjectURL(blob)
          const link = document.createElement('a')
          link.href = url
          link.download = `call-${this.callId}-quality.${format}`
          link.click()
          URL.revokeObjectURL(url)
          return true
        } catch (err) {
          this.error = err.message
          return false
        }
      },
      /**
       * Flush telemetry, download CSV report, then hang up.
       * Use after a timed real-device test so metrics are not lost.
       */
      async endCallAndExport() {
        if (this._endingCall) return
        try {
          await this.flushQualityLog()
          // Prefer CSV for spreadsheets; fall back quietly if no samples yet
          const ok = await this.downloadQualityLog('csv')
          if (!ok) {
            // Still allow hangup; user may export later via API if samples arrive late
            console.warn('Quality CSV export skipped or failed before hangup')
          }
        } catch (e) {
          console.warn(e)
        }
        await this.endCall()
      },
      copyCallId() {
        const id = this.callId || this.call?.id
        if (!id) return
        const text = String(id)
        if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(text).then(() => {
            this.error = ''
            // brief non-blocking hint via title swap
            console.info('Call ID copied:', text)
          }).catch(() => {
            window.prompt('Copy Call ID:', text)
          })
        } else {
          window.prompt('Copy Call ID:', text)
        }
      },
      applyRecordingView(body) {
        if (!body || !this.call) return
        // Recording endpoints return actor-aware RecordingView, not full CallView.
        if (body.recordingStatus != null || body.recordingMode != null) {
          this.call = {
            ...this.call,
            recordingMode: body.recordingMode ?? this.call.recordingMode,
            recordingStatus: body.recordingStatus ?? this.call.recordingStatus,
            consentStatus: body.consentStatus ?? this.call.consentStatus,
            recordingAvailable: body.canDownload === true
          }
          this.recordingCaps = {
            canStart: !!body.canStart,
            canStop: !!body.canStop,
            canDownload: !!body.canDownload,
            canDelete: !!body.canDelete
          }
          return
        }
        if (body.id) this.call = body
      },
      async toggleRecording() {
        if (this.recordingBusy || this.recordingInProgress) return
        const start = !this.isRecording
        if (start && !window.confirm('Bắt đầu ghi cuộc gọi? Khách/đồng nghiệp sẽ thấy trạng thái đang ghi. Cần đồng ý ghi trước khi bắt đầu.')) return
        this.recordingBusy = true
        this.error = ''
        try {
          if (start) {
            // Snapshot mode Video (default policy is None) + staff consent evidence.
            let res = await apiFetch(`/api/calls/${this.callId}/recording/mode`, {
              method: 'POST',
              headers: authHeaders({ 'Content-Type': 'application/json' }),
              body: JSON.stringify({ mode: 'Video' })
            })
            let body = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(body.error || 'Không đặt được chế độ ghi.')
            this.applyRecordingView(body)
            res = await apiFetch(`/api/calls/${this.callId}/recording/consent`, {
              method: 'POST',
              headers: authHeaders({ 'Content-Type': 'application/json' }),
              body: JSON.stringify({ status: 'Granted' })
            })
            body = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(body.error || 'Không ghi nhận đồng ý ghi.')
            this.applyRecordingView(body)
          }
          const action = start ? 'start' : 'stop'
          const res = await apiFetch(`/api/calls/${this.callId}/recording/${action}`, {
            method: 'POST',
            headers: authHeaders()
          })
          const body = await res.json().catch(() => ({}))
          if (!res.ok) throw new Error(body.error || 'Không thể thay đổi trạng thái ghi.')
          this.applyRecordingView(body)
          if (body.call) this.call = { ...this.call, ...body.call }
        } catch (err) {
          this.error = err.message
        } finally {
          this.recordingBusy = false
        }
      },
      async downloadRecording() {
        try {
          if (!this.callId) throw new Error('Thiếu callId.')
          await fetchAndSaveRecording(this.callId)
        } catch (err) {
          this.error = err.message
        }
      },
      async endCall() {
        // Prevent double-tap / concurrent hangup paths hanging the UI
        if (this._endingCall) return
        this._endingCall = true
        this.intentionalLeave = true
        try {
          // Never block hangup on recording/telemetry (was a source of "tắt call không được")
          const sideWork = []
          if (this.isRecording) {
            sideWork.push(this.toggleRecording().catch(err => console.warn('stop recording on end', err)))
          }
          sideWork.push(this.flushQualityLog().catch(err => console.warn('flush quality on end', err)))
          await Promise.race([
            Promise.all(sideWork),
            new Promise(resolve => setTimeout(resolve, 1500))
          ])

          const status = this.call?.status
          let action = 'end'
          if (status === 'Ringing') {
            // Still ringing: caller cancels, callee rejects
            action = this.call?.callerId === this.userId ? 'cancel' : 'reject'
          } else if (status && status !== 'Accepted') {
            // Already terminal — just leave UI
            return
          }

          await apiFetch(`/api/calls/${this.callId}/${action}`, {
            method: 'POST',
            headers: authHeaders(),
            keepalive: true
          }).catch(err => console.warn('end/cancel API', err))
        } catch (e) {
          console.error(e)
        } finally {
          this.handleCallEnded()
          this._endingCall = false
        }
      },
      /** Explicit rejoin after unexpected media disconnect (business call still Accepted). */
      async rejoinMedia() {
        this.error = ''
        this.reconnectNotice = ''
        try {
          await this.disconnectRoom()
        } catch { /* ignore */ }
        this.room = null
        await this.joinRoom()
      },
      handleCallEnded() {
        rtLog('handleCallEnded', {
          intentional: this.intentionalLeave,
          status: this.call?.status
        })
        try {
          this.disconnectRoom()
        } catch (e) {
          console.warn(e)
        }
        if (this.broadcastChannel) {
          try {
            this.broadcastChannel.postMessage({ type: 'CALL_WINDOW_CLOSED', callId: this.callId })
          } catch {
            /* ignore */
          }
        }
        // Prefer close popup window; always navigate home as fallback so main UI unlocks
        const home = `/?user=${encodeURIComponent(this.userId)}`
        try {
          if (window.opener && !window.opener.closed) {
            window.close()
            // If browser blocks close, still leave call route
            setTimeout(() => {
              if (!window.closed) window.location.href = home
            }, 200)
            return
          }
        } catch {
          /* ignore */
        }
        window.location.href = home
      },
      disconnectRoom() {
        this.stopQualityMonitoring()
        if (this.room) this.room.disconnect()
        this.room = null
        if (typeof this.localMediaCleanup === 'function') {
          this.localMediaCleanup()
          this.localMediaCleanup = null
        }
        this.localTracks.forEach(t => t.stop())
        this.localTracks = []
        this.remoteVideoConnected = false
        this.qualityStats = initialQualityStats()
        this.qualityStatsPrevious = { inbound: {}, outbound: {} }
        this.mediaPermissionState = 'idle'
      },
      handleBeforeUnload() {
        this.intentionalLeave = true
        this.flushQualityLog(true)
        if (this.call && ['Accepted', 'Ringing'].includes(this.call.status)) {
          const action = this.call.status === 'Accepted' ? 'end' : 'cancel'
          navigator.sendBeacon(`${API_URL}/api/calls/${this.callId}/${action}?access_token=${encodeURIComponent(getAccessToken())}`)
        }
        if (this.broadcastChannel) {
          this.broadcastChannel.postMessage({ type: 'CALL_WINDOW_CLOSED', callId: this.callId })
        }
      }
    },
    template: `
      <div class="call-window-shell">
        <header class="call-window-header">
          <div class="call-header-user">
            <div class="call-header-avatar" :title="peerId">{{ peerAvatar }}</div>
            <div>
              <div class="call-header-title">{{ peerName }}</div>
              <div class="call-header-status">{{ callStatusLabel }}</div>
            </div>
          </div>
          <div class="call-header-actions">
            <span v-if="isRecording || recordingStatusLabel" class="recording-indicator"><span></span> {{ recordingStatusLabel || 'Đang ghi' }}</span>
            <span v-if="dentalClipStatus === 'Recording'" class="recording-indicator"><span></span> Clip răng</span>
            <span v-if="photoStatus" class="recording-indicator" style="opacity:.85">{{ photoStatus }}</span>
            <button v-if="mediaPermissionState === 'connected'" class="quality-badge" @click="showQualityPanel = !showQualityPanel" title="Xem chất lượng hình ảnh">{{ qualityBadge }}</button>
            <button v-if="needsAudioPermission" class="audio-fallback-btn" @click="enableAudioPlayback">Bật tiếng</button>
          </div>
        </header>

        <main class="call-window-body">
          <!-- Connecting / Waiting State -->
          <div v-if="!call || call.status !== 'Accepted'" class="call-connecting-state">
            <div class="pulse-ring-avatar" :title="peerName">{{ peerAvatar }}</div>
            <h2>{{ peerName }}</h2>
            <p v-if="call && call.status === 'Ringing'">{{ call.callerId === userId ? 'Đang đổ chuông…' : 'Cuộc gọi đến — vui lòng chờ…' }}</p>
            <p v-else-if="call">{{ callStatusLabel }}</p>
            <p v-else>Đang kết nối…</p>
          </div>

          <!-- Video Grid inside Call Window -->
          <div v-else class="call-video-grid">
            <div class="remote-video-container" ref="remoteMedia">
              <div
                v-if="showRemotePlaceholder"
                class="remote-avatar-placeholder"
              >
                <img
                  v-if="isEmbedPeer"
                  :src="guestAvatarUrl"
                  alt="Khách"
                />
                <div v-else class="initials-avatar">{{ peerAvatar }}</div>
                <p>{{ remotePlaceholderText }}</p>
              </div>
              <span
                v-else-if="mediaPermissionState !== 'connected'"
                class="remote-video-status"
              >{{ mediaSetupLabel }}</span>
            </div>
            <div class="local-video-container" ref="localMedia"></div>
            <div ref="remoteAudio"></div>

            <section v-if="showQualityPanel" class="quality-panel" aria-label="Chất lượng hình ảnh">
              <div class="quality-panel-title">Chất lượng hình ảnh <span class="quality-auto-hint">(tự cập nhật)</span></div>
              <p class="quality-call-id" title="Mã cuộc gọi (hỗ trợ kỹ thuật)">
                Mã cuộc gọi:
                <button type="button" class="quality-call-id-btn" @click="copyCallId">{{ callId }}</button>
              </p>
              <dl>
                <div><dt>Hình nhận</dt><dd>{{ qualityStats.incomingResolution }} · {{ qualityStats.incomingFps }} khung/giây</dd></div>
                <div><dt>Tốc độ nhận</dt><dd>{{ qualityStats.incomingBitrateKbps }} kbps</dd></div>
                <div><dt>Hình gửi</dt><dd>{{ qualityStats.outgoingResolution }} · {{ qualityStats.outgoingFps }} khung/giây</dd></div>
                <div><dt>Tốc độ gửi</dt><dd>{{ qualityStats.outgoingBitrateKbps }} kbps</dd></div>
                <div><dt>Mất tín hiệu</dt><dd>{{ qualityStats.packetLossPercent }}%</dd></div>
                <div><dt>Độ trễ</dt><dd>{{ qualityStats.roundTripTimeMs }} ms</dd></div>
                <div><dt>Định dạng</dt><dd>{{ qualityStats.codec }}</dd></div>
                <div><dt>Hạn chế mạng</dt><dd>{{ qualityStats.qualityLimitationReason }}</dd></div>
              </dl>
              <div class="quality-export-actions">
                <button type="button" class="quality-export-primary" @click="downloadQualityLog('csv')" title="Tải báo cáo chất lượng">Tải báo cáo</button>
                <button type="button" class="quality-export-end" @click="endCallAndExport" title="Tải báo cáo rồi kết thúc">Kết thúc và tải</button>
              </div>
            </section>

            <div class="call-window-controls">
              <button v-if="mediaPermissionState === 'connected'" :class="['ctrl-btn', !microphoneEnabled && 'off']" @click="toggleMicrophone" :title="microphoneEnabled ? 'Tắt micro' : 'Bật micro'">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3M8 22h8"/></svg>
              </button>
              <button v-if="mediaPermissionState === 'connected'" :class="['ctrl-btn', !cameraEnabled && 'off']" @click="toggleCamera" :title="cameraEnabled ? 'Tắt camera' : 'Bật camera'">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m16 13 5 3V8l-5 3V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2z"/></svg>
              </button>
              <button v-if="mediaPermissionState === 'connected'" :class="['ctrl-btn', 'record-btn', isRecording && 'recording']" :disabled="recordingBusy || recordingInProgress" @click="toggleRecording" :title="isRecording ? 'Dừng ghi' : 'Bắt đầu ghi (cần đồng ý)'">
                <span class="record-dot"></span>
              </button>
              <button
                v-if="mediaPermissionState === 'connected' && !isManagerRole"
                :class="['ctrl-btn', dentalClipStatus === 'Recording' && 'recording']"
                :disabled="dentalClipBusy || dentalClipStatus === 'Finalizing'"
                @click="toggleDentalClip"
                :title="dentalClipStatus === 'Recording' ? 'Dừng clip răng' : 'Ghi clip răng (camera bệnh nhân)'"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="14" height="14" rx="2"/><path d="m17 10 4-2v8l-4-2"/></svg>
              </button>
              <button
                v-if="mediaPermissionState === 'connected' && !isManagerRole"
                class="ctrl-btn"
                :disabled="photoBusy"
                @click="requestPhoto"
                title="Chụp ảnh (gửi lệnh cho bệnh nhân)"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
              </button>
              <button v-if="recordingAvailable" class="ctrl-btn download-btn" @click="downloadRecording" title="Tải bản ghi (quản lý)">
                <svg viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>
              </button>
              <button v-if="mediaPermissionState === 'error'" class="start-call-btn" style="padding: 8px 16px; font-size: 13px;" @click="rejoinMedia">
                Tham gia lại media
              </button>
              <button class="ctrl-btn danger" @click="endCall" title="Kết thúc cuộc gọi">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.68 13.31a16 16 0 0 0 6 6l2-2a2 2 0 0 1 2-.48c.68.23 1.37.39 2.08.48A2 2 0 0 1 24 19.3V22a2 2 0 0 1-2.18 2A19.8 19.8 0 0 1 4.55 6.73 2 2 0 0 1 6.53 4.55h2.7a2 2 0 0 1 2 1.72c.09.71.25 1.4.48 2.08a2 2 0 0 1-.47 2zM23 1 1 23"/></svg>
              </button>
            </div>
          </div>
        </main>

        <div class="toast-error" v-if="error">{{ error }}</div>
      </div>
    `
  })

} else {
  // =========================================================================
  // 2. MAIN APP PAGE (/)
  // =========================================================================
  new Vue({
    el: '#app',
    data: {
      identities: [],
      loginAccounts: [],
      loginUserId: 'A1',
      loginPassword: DEMO_PASSWORD_HINT,
      loginError: '',
      loginBusy: false,
      currentUser: null,
      isLoggedIn: false,
      targetId: 'A2',
      searchQuery: '',
      hub: null,
      call: null,
      popupState: 'none', // 'none' | 'incoming' | 'ringing' | 'active_window' | 'popup_blocked' | 'rejected' | 'busy' | 'ended' | 'error'
      popupErrorMessage: '',
      callWindowRef: null,
      broadcastChannel: null,
      /** userId -> online bool (same clinic only) */
      onlineMap: {},
      /** userId -> agent state string (Available/Ringing/InCall/Offline) */
      agentStateMap: {},
      queueItems: [],
      /** Staff/Manager queue dock bottom-right; collapsed by default. */
      queuePanelOpen: false,
      heartbeatTimer: null,
      showOtherClinics: false,
      guestAvatarUrl: GUEST_AVATAR_URL,
      /** Manager library */
      recordings: [],
      recordingsTotal: 0,
      recordingsLoading: false,
      recordingsError: '',
      recordingsFilter: 'all', // all | complete | deleted | failed
      recordingActionId: null,
      /** Manager consultations (M5) */
      consultations: [],
      consultationsLoading: false,
      consultationsError: '',
      consultationDetail: null,
      consultationDetailLoading: false,
      mediaActionId: null,
      /** Left icon rail — only "call" is implemented */
      activeNav: 'call',
      navRailItems: [
        { id: 'call', label: 'Cuộc gọi' },
        { id: 'schedule', label: 'Lịch hẹn' },
        { id: 'patients', label: 'Bệnh nhân' },
        { id: 'chat', label: 'Tin nhắn' },
        { id: 'stats', label: 'Thống kê' },
        { id: 'billing', label: 'Thu chi' },
        { id: 'settings', label: 'Cài đặt' }
      ]
    },
    computed: {
      isCallNav() {
        return this.activeNav === 'call'
      },
      identityId() {
        return this.currentUser?.id || ''
      },
      isVisitor() {
        return (this.currentUser?.role || 'Staff') === 'Visitor'
      },
      isManager() {
        return String(this.currentUser?.role || '').toLowerCase() === 'manager'
      },
      isCallActive() {
        return !!(this.call && ['Queued', 'Ringing', 'Accepted'].includes(this.call.status))
      },
      selectedIdentity() {
        if (this.isVisitor) return null
        return this.identities.find(i => i.id === this.targetId)
          || this.visibleContacts[0]
          || null
      },
      showDetailPanel() {
        return !!(this.selectedIdentity && !this.isVisitor && !this.isManager)
      },
      visibleContacts() {
        const query = this.searchQuery.trim().toLowerCase()
        const clinic = clinicIdOf(this.currentUser)
        return this.identities.filter(i => {
          if (i.id === this.identityId) return false
          // Default: only same clinic (demo B1 is other clinic). Backend also filters directory.
          if (!this.showOtherClinics && clinic && clinicIdOf(i) !== clinic) return false
          if (!query) return true
          return `${i.id} ${i.displayName} ${clinicIdOf(i)}`.toLowerCase().includes(query)
        })
      },
      peerIdentity() {
        if (!this.call) return this.selectedIdentity
        const peerId = this.call.callerId === this.identityId ? this.call.calleeId : this.call.callerId
        const known = this.identities.find(i => i.id === peerId)
        if (known) return known
        return {
          id: peerId,
          displayName: peerLabel(peerId),
          role: isEmbedVisitorId(peerId) ? 'Visitor' : 'Staff'
        }
      },
      peerName() {
        return peerLabel(this.peerIdentity?.id, this.peerIdentity)
      },
      peerAvatar() {
        return peerAvatarText(this.peerIdentity?.id, this.peerIdentity)
      },
      isEmbedPeer() {
        return isEmbedVisitorId(this.peerIdentity?.id)
      },
      selfAgentState() {
        return this.agentStateMap[this.identityId] || (this.identityId ? 'Available' : 'Offline')
      },
      selfAgentBadgeClass() {
        return agentBadgeClass(this.selfAgentState)
      },
      selfAgentBadgeLabel() {
        return agentBadgeLabel(this.selfAgentState)
      },
      queueMineCount() {
        return (this.queueItems || []).filter(i => this.isQueueAssignedToMe(i)).length
      },
      filteredRecordings() {
        const list = this.recordings || []
        const f = this.recordingsFilter
        if (f === 'complete') return list.filter(r => r.recordingStatus === 'Complete')
        if (f === 'deleted') return list.filter(r => r.recordingStatus === 'Deleted')
        if (f === 'failed') return list.filter(r => r.recordingStatus === 'Failed')
        return list
      },
      completeRecordingsCount() {
        return (this.recordings || []).filter(r => r.recordingStatus === 'Complete').length
      },
      /** Group demo accounts by clinic so login stays short + scannable. */
      loginAccountGroups() {
        const map = new Map()
        for (const user of this.loginAccounts || []) {
          const key = clinicIdOf(user) || 'other'
          if (!map.has(key)) {
            map.set(key, {
              clinicId: key,
              label: clinicDisplayName(key),
              users: []
            })
          }
          map.get(key).users.push(user)
        }
        // Prefer clinic-a then clinic-b then others
        const order = ['clinic-a', 'clinic-b']
        return [...map.values()].sort((a, b) => {
          const ia = order.indexOf(a.clinicId)
          const ib = order.indexOf(b.clinicId)
          if (ia === -1 && ib === -1) return a.label.localeCompare(b.label, 'vi')
          if (ia === -1) return 1
          if (ib === -1) return -1
          return ia - ib
        })
      }
    },
    async mounted() {
      // Init BroadcastChannel to sync with Call Window
      if ('BroadcastChannel' in window) {
        this.broadcastChannel = new BroadcastChannel('livekit_call_channel')
        this.broadcastChannel.onmessage = (event) => {
          const { type, callId } = event.data || {}
          if (type === 'CALL_WINDOW_OPENED' || type === 'CALL_WINDOW_READY') {
            if (this.call && this.call.id === callId) {
              this.popupState = 'active_window'
            }
          } else if (type === 'CALL_WINDOW_CLOSED') {
            // Must clear call state — previously popup closed but this.call stayed set,
            // which blocked selectUser() ("call xong chọn user không được").
            if (!this.call || this.call.id === callId || !callId) {
              this.clearCallUiState({ showEndedToast: false })
            }
          }
        }
      }

      await this.bootstrapAuth()
    },
    beforeDestroy() {
      if (this.hub) this.hub.stop()
      if (this.broadcastChannel) this.broadcastChannel.close()
    },
    methods: {
      async bootstrapAuth() {
        // Public account list for login picker
        try {
          const res = await fetch(`${API_URL}/api/auth/accounts`)
          if (res.ok) this.loginAccounts = await res.json()
        } catch (err) {
          this.loginError = 'Không tải được danh sách tài khoản: ' + err.message
        }

        // Restore JWT session if still valid
        if (getAccessToken()) {
          try {
            const meRes = await apiFetch('/api/auth/me')
            if (meRes.ok) {
              const me = await meRes.json()
              await this.enterApp(me)
              return
            }
          } catch {
            /* fall through to login */
          }
          clearAuthSession()
        }
        this.isLoggedIn = false
      },
      async loadIdentities() {
        try {
          const res = await apiFetch(`/api/identities`)
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          this.identities = await res.json()
        } catch (err) {
          this.popupErrorMessage = 'Không thể tải danh sách liên hệ: ' + err.message
          this.popupState = 'error'
        }
      },
      selectLoginAccount(user) {
        this.loginUserId = user.id
        this.loginPassword = DEMO_PASSWORD_HINT
        this.loginError = ''
      },
      async submitLogin() {
        this.loginBusy = true
        this.loginError = ''
        try {
          const res = await fetch(`${API_URL}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              userId: this.loginUserId,
              password: this.loginPassword
            })
          })
          const body = await res.json().catch(() => ({}))
          if (!res.ok) {
            throw new Error(body.error || 'Đăng nhập thất bại')
          }
          setAuthSession(body.accessToken, body.user)
          await this.enterApp(body.user)
        } catch (err) {
          this.loginError = err.message
        } finally {
          this.loginBusy = false
        }
      },
      async enterApp(user) {
        this.currentUser = user
        this.isLoggedIn = true
        this.onlineMap = {}
        this.recordings = []
        this.recordingsError = ''
        history.replaceState(null, '', `?user=${encodeURIComponent(user.id)}`)
        await this.loadIdentities()
        const sameClinicPeers = this.identities.filter(i => i.id !== user.id)
        this.targetId = sameClinicPeers[0]?.id || ''
        await this.connectRealtime()
        if (String(user.role || '').toLowerCase() === 'manager') {
          await Promise.all([this.loadConsultations(), this.loadRecordings()])
        }
      },
      async logout() {
        if (this.heartbeatTimer) {
          clearInterval(this.heartbeatTimer)
          this.heartbeatTimer = null
        }
        if (this.hub) await this.hub.stop()
        clearAuthSession()
        this.currentUser = null
        this.isLoggedIn = false
        this.call = null
        this.popupState = 'none'
        this.onlineMap = {}
        this.agentStateMap = {}
        this.queueItems = []
        this.queuePanelOpen = false
        this.identities = []
        this.recordings = []
        this.recordingsTotal = 0
        this.recordingsError = ''
        this.recordingActionId = null
        this.consultations = []
        this.consultationDetail = null
        history.replaceState(null, '', location.pathname)
      },
      async loadConsultations() {
        if (!this.isManager) return
        this.consultationsLoading = true
        this.consultationsError = ''
        try {
          const res = await apiFetch('/api/consultations?limit=50', { headers: authHeaders() })
          const body = await res.json().catch(() => ({}))
          if (res.status === 404) {
            this.consultations = []
            return
          }
          if (!res.ok) {
            throw new Error(body.error || `Không tải được consultations (HTTP ${res.status})`)
          }
          this.consultations = body.items || []
        } catch (e) {
          this.consultationsError = e.message || 'Lỗi tải consultations'
          this.consultations = []
        } finally {
          this.consultationsLoading = false
        }
      },
      async openConsultationDetail(sessionId) {
        if (!sessionId) return
        this.consultationDetailLoading = true
        try {
          const res = await apiFetch(`/api/consultations/${sessionId}`, { headers: authHeaders() })
          const body = await res.json().catch(() => ({}))
          if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
          this.consultationDetail = body
        } catch (e) {
          this.popupErrorMessage = e.message
          this.popupState = 'error'
        } finally {
          this.consultationDetailLoading = false
        }
      },
      closeConsultationDetail() {
        this.consultationDetail = null
      },
      async downloadMediaAsset(assetId, kind) {
        if (!assetId || this.mediaActionId) return
        this.mediaActionId = assetId
        try {
          await fetchAndSaveMediaAsset(assetId, kind)
        } catch (e) {
          this.popupErrorMessage = e.message
          this.popupState = 'error'
        } finally {
          this.mediaActionId = null
        }
      },
      async deleteMediaAsset(assetId) {
        if (!assetId || this.mediaActionId) return
        const ok = window.confirm('Đánh dấu xóa media này? File sẽ bị xóa sau bởi retention.')
        if (!ok) return
        this.mediaActionId = assetId
        try {
          const res = await apiFetch(`/api/media/${assetId}`, {
            method: 'DELETE',
            headers: authHeaders()
          })
          const body = await res.json().catch(() => ({}))
          if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
          if (this.consultationDetail?.sessionId) {
            await this.openConsultationDetail(this.consultationDetail.sessionId)
          }
          await this.loadConsultations()
        } catch (e) {
          this.popupErrorMessage = e.message
          this.popupState = 'error'
        } finally {
          this.mediaActionId = null
        }
      },
      async loadRecordings() {
        if (!this.isManager) return
        this.recordingsLoading = true
        this.recordingsError = ''
        try {
          const res = await apiFetch('/api/recordings', { headers: authHeaders() })
          const body = await res.json().catch(() => ({}))
          if (!res.ok) {
            throw new Error(body.error || `Không tải được danh sách (HTTP ${res.status})`)
          }
          this.recordings = body.items || []
          this.recordingsTotal = body.total ?? this.recordings.length
        } catch (e) {
          this.recordingsError = e.message || 'Lỗi tải bản ghi'
          this.recordings = []
          this.recordingsTotal = 0
        } finally {
          this.recordingsLoading = false
        }
      },
      async downloadRecordingByCallId(callId) {
        if (!callId || this.recordingActionId) return
        this.recordingActionId = callId
        try {
          await fetchAndSaveRecording(callId)
        } catch (e) {
          this.popupErrorMessage = e.message
          this.popupState = 'error'
          this.error = e.message
        } finally {
          this.recordingActionId = null
        }
      },
      async deleteRecordingByCallId(callId) {
        if (!callId || this.recordingActionId) return
        const ok = window.confirm('Xóa bản ghi này? Thao tác không hoàn tác được.')
        if (!ok) return
        this.recordingActionId = callId
        try {
          const res = await apiFetch(`/api/calls/${callId}/recording`, {
            method: 'DELETE',
            headers: authHeaders()
          })
          const body = await res.json().catch(() => ({}))
          if (!res.ok) {
            throw new Error(body.error || `Không xóa được (HTTP ${res.status})`)
          }
          await this.loadRecordings()
        } catch (e) {
          this.popupErrorMessage = e.message
          this.popupState = 'error'
        } finally {
          this.recordingActionId = null
        }
      },
      recordingStatusLabelVi,
      recordingModeLabel,
      formatViDateTime,
      selectNav(id) {
        this.activeNav = id || 'call'
      },
      isUserOnline(userId) {
        return !!this.onlineMap[userId]
      },
      isCallForMe(call) {
        if (!call) return false
        const me = this.identityId
        return call.callerId === me
          || call.calleeId === me
          || call.assignedStaffId === me
      },
      applyPresenceSnapshot(snapshot) {
        if (!snapshot?.users) return
        const nextOnline = { ...this.onlineMap }
        const nextState = { ...this.agentStateMap }
        for (const u of snapshot.users) {
          nextOnline[u.userId] = !!u.online
          nextState[u.userId] = u.state || (u.online ? 'Available' : 'Offline')
        }
        // Self is online while this page is connected
        if (this.identityId) {
          nextOnline[this.identityId] = true
          if (!nextState[this.identityId] || nextState[this.identityId] === 'Offline') {
            nextState[this.identityId] = 'Available'
          }
        }
        this.onlineMap = nextOnline
        this.agentStateMap = nextState
      },
      clearCallUiState({ showEndedToast = false } = {}) {
        this.call = null
        this.popupState = showEndedToast ? 'ended' : 'none'
        this.callWindowRef = null
      },
      async connectRealtime() {
        if (this.hub) await this.hub.stop()
        if (this.heartbeatTimer) {
          clearInterval(this.heartbeatTimer)
          this.heartbeatTimer = null
        }
        this.hub = new signalR.HubConnectionBuilder()
          .withUrl(`${API_URL}/hubs/calls`, {
            accessTokenFactory: () => getAccessToken()
          })
          .withAutomaticReconnect()
          .build()

        this.hub.on('CallUpdated', call => {
          if (!this.isCallForMe(call)) return

          this.call = call

          if (call.status === 'Queued') {
            this.popupState = call.callerId === this.identityId ? 'ringing' : 'none'
          } else if (call.status === 'Ringing') {
            const assigned = call.assignedStaffId || call.calleeId
            this.popupState = assigned === this.identityId ? 'incoming' : 'ringing'
          } else if (call.status === 'Accepted') {
            this.popupState = 'active_window'
          } else if (call.status === 'Rejected') {
            this.popupState = 'rejected'
          } else if (['Cancelled', 'Ended', 'Timeout', 'NoAgent', 'Closed'].includes(call.status)) {
            this.popupState = 'ended'
            if (this._endedToastTimer) clearTimeout(this._endedToastTimer)
            this._endedToastTimer = setTimeout(() => {
              if (this.popupState === 'ended' && !this.isCallActive) {
                this.clearCallUiState({ showEndedToast: false })
              }
            }, 2500)
          }
        })

        this.hub.on('PresenceUpdated', snapshot => {
          this.applyPresenceSnapshot(snapshot)
        })

        this.hub.on('QueueUpdated', snapshot => {
          this.queueItems = snapshot?.items || []
        })

        this.hub.onreconnected(async () => {
          await this.refreshPresence()
          if (!this.isVisitor) {
            await this.refreshQueue()
            try { await this.hub.invoke('Heartbeat') } catch { /* ignore */ }
          }
        })

        await this.hub.start()
        await this.refreshPresence()

        if (!this.isVisitor && !this.isManager) {
          // Staff only — Manager is not dispatched / not "ready" for queue.
          try {
            await apiFetch('/api/agents/ready', { method: 'POST', headers: authHeaders() })
          } catch { /* ignore */ }
          this.heartbeatTimer = setInterval(() => {
            if (this.hub?.state === 'Connected') {
              this.hub.invoke('Heartbeat').catch(() => {})
            }
          }, 15000)
        }
        if (!this.isVisitor) {
          await this.refreshQueue()
        }

        // Check if there is an active call already
        try {
          const res = await apiFetch(`/api/calls/active`, {
            headers: authHeaders()
          })
          if (res.ok && res.status !== 204) {
            const activeCall = await res.json()
            this.call = activeCall
            if (activeCall.status === 'Accepted') {
              this.popupState = 'active_window'
            } else if (activeCall.status === 'Ringing') {
              const assigned = activeCall.assignedStaffId || activeCall.calleeId
              this.popupState = assigned === this.identityId ? 'incoming' : 'ringing'
            } else if (activeCall.status === 'Queued') {
              this.popupState = 'ringing'
            }
          }
        } catch (e) {
          console.error(e)
        }
      },
      async refreshPresence() {
        try {
          const res = await apiFetch(`/api/presence`, {
            headers: authHeaders()
          })
          if (res.ok) {
            this.applyPresenceSnapshot(await res.json())
          }
        } catch (e) {
          console.warn('presence fetch failed', e)
        }
      },
      async refreshQueue() {
        if (this.isVisitor) return
        try {
          const res = await apiFetch('/api/queue', { headers: authHeaders() })
          if (res.ok) {
            const snap = await res.json()
            this.queueItems = snap?.items || []
          }
        } catch (e) {
          console.warn('queue fetch failed', e)
        }
      },
      formatQueueLabel,
      queueStatusVi,
      callStatusVi,
      formatWaitSeconds,
      clinicDisplayName,
      roleDisplayName,
      userInitials,
      isQueueAssignedToMe(item) {
        if (!item || !this.identityId) return false
        return String(item.assignedStaffId || '').toLowerCase() === this.identityId.toLowerCase()
      },
      agentStateFor(userId) {
        return this.agentStateMap[userId] || 'Offline'
      },
      agentBadgeClassFor(userId) {
        return agentBadgeClass(this.agentStateFor(userId))
      },
      agentBadgeLabelFor(userId) {
        return agentBadgeLabel(this.agentStateFor(userId))
      },
      callUrlFor(callId, mediaMode = 'video') {
        const media = mediaMode === 'audio' ? 'audio' : 'video'
        return `/call/${callId}?user=${encodeURIComponent(this.identityId)}&media=${media}`
      },
      mediaModeFromCall(call, fallback = 'video') {
        const m = call?.initialMediaMode || call?.InitialMediaMode || fallback
        return String(m).toLowerCase() === 'audio' ? 'audio' : 'video'
      },
      async startQueueCall(mediaMode = 'video') {
        if (this.isCallActive) return
        try {
          const media = mediaMode === 'audio' ? 'audio' : 'video'
          try {
            sessionStorage.setItem('simlydent_preferred_media', media)
          } catch { /* ignore */ }
          const res = await apiFetch('/api/queue/calls', {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ initialMediaMode: media === 'audio' ? 'Audio' : 'Video' })
          })
          const body = await res.json().catch(() => ({}))
          if (!res.ok) {
            this.popupErrorMessage = body.error || 'Không vào được hàng đợi.'
            this.popupState = 'error'
            return
          }
          this.call = body
          this.popupState = body.status === 'Ringing' ? 'ringing' : 'ringing'
          // Demo visitor (VA): open call window when accepted — media from server call
          this._queuePreferredMedia = this.mediaModeFromCall(body, media)
        } catch (e) {
          this.popupErrorMessage = e.message
          this.popupState = 'error'
        }
      },
      selectUser(userId) {
        if (userId === this.identityId) return
        // Only block while call is truly active (was: !this.call → stuck after end)
        if (this.isCallActive) return
        const peer = this.identities.find(i => i.id === userId)
        if (!peer) return
        if (!this.sameClinic(peer) && !this.showOtherClinics) return
        this.targetId = userId
      },
      sameClinic(item) {
        return clinicIdOf(item) === clinicIdOf(this.currentUser)
      },
      /** Compatibility alias used by existing templates. */
      sameTenant(item) {
        return this.sameClinic(item)
      },
      contactStatusLabel(item) {
        if (!this.sameClinic(item)) return 'Phòng khám khác'
        const state = this.agentStateMap[item.id]
        if (state && state !== 'Offline') return agentBadgeLabel(state)
        return this.isUserOnline(item.id) ? 'Sẵn sàng' : 'Ngoại tuyến'
      },
      clinicLabel(clinicId) {
        return clinicDisplayName(clinicId)
      },
      roleLabel(role) {
        return roleDisplayName(role)
      },
      isManagerAccount(user) {
        return String(user?.role || '').toLowerCase() === 'manager'
      },
      async startCall(targetId, mediaMode = 'video') {
        if (this.isVisitor) {
          await this.startQueueCall(mediaMode)
          return
        }
        if (this.isManager) {
          this.popupErrorMessage = 'Tài khoản Quản lý không đặt cuộc gọi media. Hãy dùng tài khoản nhân viên tư vấn để nhận khách.'
          this.popupState = 'error'
          return
        }
        if (this.isCallActive) return
        const peer = this.identities.find(i => i.id === targetId)
        if (!peer) return
        if (!this.sameClinic(peer)) {
          this.popupErrorMessage = 'Chỉ gọi được đồng nghiệp cùng phòng khám.'
          this.popupState = 'error'
          return
        }
        if (!this.isUserOnline(targetId)) {
          this.popupErrorMessage = 'Đồng nghiệp này đang ngoại tuyến. Vui lòng gọi khi họ đã đăng nhập.'
          this.popupState = 'error'
          return
        }
        this.targetId = targetId
        const media = mediaMode === 'audio' ? 'audio' : 'video'
        try {
          sessionStorage.setItem('simlydent_preferred_media', media)
        } catch { /* ignore */ }
        const isMobile = window.innerWidth < 768

        // Open blank popup immediately to avoid popup blocker on Desktop
        let popupWin = null
        if (!isMobile) {
          popupWin = window.open('about:blank', `Call_${targetId}`, 'width=960,height=680,scrollbars=no,resizable=yes')
        }

        try {
          const res = await apiFetch(`/api/calls`, {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({
              calleeId: targetId,
              initialMediaMode: media === 'audio' ? 'Audio' : 'Video'
            })
          })

          if (!res.ok) {
            if (popupWin) popupWin.close()
            const errData = await res.json().catch(() => ({}))
            if (res.status === 409) {
              this.popupState = 'busy'
            } else {
              this.popupErrorMessage = errData.error || `Lỗi HTTP ${res.status}`
              this.popupState = 'error'
            }
            return
          }

          const call = await res.json()
          this.call = call
          this.popupState = 'ringing'

          // Prefer server authoritative mode; URL is cache only
          const resolved = this.mediaModeFromCall(call, media)
          const callUrl = this.callUrlFor(call.id, resolved)
          if (isMobile) {
            window.location.href = callUrl
          } else {
            if (popupWin && !popupWin.closed) {
              popupWin.location.href = callUrl
              this.callWindowRef = popupWin
            } else {
              this.popupState = 'popup_blocked'
            }
          }
        } catch (err) {
          if (popupWin) popupWin.close()
          this.popupErrorMessage = err.message
          this.popupState = 'error'
        }
      },
      async acceptCall() {
        if (!this.call) return
        const isMobile = window.innerWidth < 768
        // Authoritative media is call.initialMediaMode from the ringing CallView (set by caller).
        // sessionStorage is only a stale cache — do not let callee default to video on audio calls.
        const media = this.mediaModeFromCall(this.call, 'video')

        let popupWin = null
        if (!isMobile) {
          popupWin = window.open('about:blank', `Call_${this.call.id}`, 'width=960,height=680,scrollbars=no,resizable=yes')
        }

        try {
          const res = await apiFetch(`/api/calls/${this.call.id}/accept`, {
            method: 'POST',
            headers: authHeaders()
          })

          if (!res.ok) {
            if (popupWin) popupWin.close()
            const errData = await res.json().catch(() => ({}))
            this.popupErrorMessage = errData.error || 'Không nhận được cuộc gọi. Có thể đã được chuyển cho người khác.'
            this.popupState = 'error'
            return
          }

          const call = await res.json()
          this.call = call
          this.popupState = 'active_window'

          const resolved = this.mediaModeFromCall(call, media)
          try {
            sessionStorage.setItem('simlydent_preferred_media', resolved)
          } catch { /* ignore */ }
          const callUrl = this.callUrlFor(call.id, resolved)
          if (isMobile) {
            window.location.href = callUrl
          } else {
            if (popupWin && !popupWin.closed) {
              popupWin.location.href = callUrl
              this.callWindowRef = popupWin
            } else {
              this.popupState = 'popup_blocked'
            }
          }
        } catch (err) {
          if (popupWin) popupWin.close()
          this.popupErrorMessage = err.message
          this.popupState = 'error'
        }
      },
      async rejectCall() {
        if (!this.call) return
        try {
          await apiFetch(`/api/calls/${this.call.id}/reject`, {
            method: 'POST',
            headers: authHeaders()
          })
        } catch (e) {
          console.error(e)
        } finally {
          this.clearCallUiState({ showEndedToast: false })
        }
      },
      async cancelCall() {
        if (!this.call) return
        try {
          await apiFetch(`/api/calls/${this.call.id}/cancel`, {
            method: 'POST',
            headers: authHeaders()
          })
        } catch (e) {
          console.error(e)
        } finally {
          this.clearCallUiState({ showEndedToast: false })
        }
      },
      reopenCallWindow() {
        if (!this.call) return
        const isMobile = window.innerWidth < 768
        const media = this.mediaModeFromCall(this.call, (() => {
          try {
            return sessionStorage.getItem('simlydent_preferred_media') || 'video'
          } catch {
            return 'video'
          }
        })())
        const callUrl = this.callUrlFor(this.call.id, media)
        if (isMobile) {
          window.location.href = callUrl
        } else {
          this.callWindowRef = window.open(callUrl, `Call_${this.call.id}`, 'width=960,height=680,scrollbars=no,resizable=yes')
          if (!this.callWindowRef) {
            this.popupState = 'popup_blocked'
          } else {
            this.popupState = 'active_window'
          }
        }
      },
      closePopup() {
        // Always release selection lock after terminal or dismiss
        if (!this.isCallActive) {
          this.clearCallUiState({ showEndedToast: false })
        } else {
          this.popupState = 'none'
        }
      }
    },
    template: `
      <div>
        <!-- LOGIN -->
        <div v-if="!isLoggedIn" class="login-overlay">
          <div class="login-card">
            <div class="login-brand">
              <div class="login-logo">S</div>
              <h1>SimlyDent</h1>
            </div>
            <p class="login-lead">Tư vấn video cho phòng khám</p>
            <p class="login-hint">Chọn tài khoản · mật khẩu <strong>Demo@123</strong></p>

            <div class="login-picker">
              <div class="demo-account-scroll" role="listbox" aria-label="Chọn tài khoản demo">
                <div
                  v-for="group in loginAccountGroups"
                  :key="group.clinicId"
                  class="login-account-group"
                >
                  <div class="login-group-label">{{ group.label }}</div>
                  <button
                    v-for="user in group.users"
                    :key="user.id"
                    type="button"
                    class="account-btn"
                    :class="{ selected: loginUserId === user.id }"
                    role="option"
                    :aria-selected="loginUserId === user.id ? 'true' : 'false'"
                    @click="selectLoginAccount(user)"
                  >
                    <div class="account-avatar">{{ userInitials(user) }}</div>
                    <div class="account-info">
                      <span class="account-name">{{ user.displayName }}</span>
                      <span class="account-id">{{ user.id }} · {{ roleLabel(user.role) }}</span>
                    </div>
                    <span
                      v-if="isManagerAccount(user)"
                      class="account-role-chip account-role-chip--manager"
                    >Quản lý</span>
                  </button>
                </div>
              </div>
              <p class="login-scroll-hint">Cuộn để xem thêm tài khoản</p>
            </div>

            <div class="login-footer-actions">
              <div class="login-password-field">
                <label for="login-password">Mật khẩu</label>
                <input
                  id="login-password"
                  v-model="loginPassword"
                  type="password"
                  autocomplete="current-password"
                  @keyup.enter="submitLogin"
                />
              </div>
              <p v-if="loginError" class="login-error">{{ loginError }}</p>
              <button
                type="button"
                class="start-call-btn login-submit"
                :disabled="loginBusy || !loginUserId"
                @click="submitLogin"
              >
                {{ loginBusy ? 'Đang đăng nhập…' : 'Đăng nhập' }}
              </button>
            </div>
          </div>
        </div>

        <!-- MAIN APP -->
        <main
          v-else
          class="app-shell"
          :class="{
            'has-detail': showDetailPanel && isCallNav,
            'nav-only': !isCallNav
          }"
        >
          <!-- Icon rail (SimlyDent-style app chrome) -->
          <nav class="nav-rail" aria-label="Menu chính">
            <div class="nav-rail-brand" title="SimlyDent">S</div>
            <div class="nav-rail-items">
              <button
                v-for="item in navRailItems"
                :key="item.id"
                type="button"
                class="nav-rail-btn"
                :class="{ active: activeNav === item.id }"
                :title="item.label"
                :aria-label="item.label"
                :aria-current="activeNav === item.id ? 'page' : null"
                @click="selectNav(item.id)"
              >
                <!-- phone / call -->
                <svg v-if="item.id === 'call'" viewBox="0 0 24 24" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.81.36 1.6.68 2.34a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.74.32 1.53.55 2.34.68A2 2 0 0 1 22 16.92z"/></svg>
                <!-- calendar -->
                <svg v-else-if="item.id === 'schedule'" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
                <!-- users -->
                <svg v-else-if="item.id === 'patients'" viewBox="0 0 24 24" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                <!-- message -->
                <svg v-else-if="item.id === 'chat'" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                <!-- chart -->
                <svg v-else-if="item.id === 'stats'" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3v18h18"/><path d="M7 16v-5M12 16V8M17 16v-3"/></svg>
                <!-- wallet -->
                <svg v-else-if="item.id === 'billing'" viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/><path d="M16 15h2"/></svg>
                <!-- settings -->
                <svg v-else viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
              </button>
            </div>
            <button type="button" class="nav-rail-btn nav-rail-logout" title="Đăng xuất" aria-label="Đăng xuất" @click="logout">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/></svg>
            </button>
          </nav>

          <aside class="sidebar" v-if="isCallNav">
            <header class="sidebar-header">
              <div>
                <h1>{{ isVisitor ? 'Tư vấn' : 'Đồng nghiệp' }}</h1>
                <p class="sidebar-kicker">{{ clinicLabel(currentUser.clinicId || currentUser.tenantId) }}</p>
              </div>
            </header>

            <div v-if="!isVisitor" class="search-container">
              <div class="search-input-wrapper">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
                <input v-model="searchQuery" type="search" placeholder="Tìm theo tên…" aria-label="Tìm đồng nghiệp" />
              </div>
            </div>

            <div class="contact-list">
              <div
                v-for="item in visibleContacts"
                :key="item.id"
                :class="['contact-item', targetId === item.id && 'selected', !isUserOnline(item.id) && sameTenant(item) && 'contact-offline']"
                @click="selectUser(item.id)"
              >
                <div class="user-avatar" :class="{ accent: item.id === targetId }">
                  {{ userInitials(item) }}
                  <div
                    v-if="sameTenant(item)"
                    :class="['status-dot', isUserOnline(item.id) ? 'online' : 'offline']"
                  ></div>
                </div>
                <div class="contact-details">
                  <div class="contact-name">{{ item.displayName }}</div>
                  <div class="contact-status">
                    <span v-if="sameTenant(item)" :class="agentBadgeClassFor(item.id)">{{ agentBadgeLabelFor(item.id) }}</span>
                    <span v-else>{{ contactStatusLabel(item) }}</span>
                  </div>
                </div>
              </div>
              <p v-if="!isVisitor && !visibleContacts.length" class="empty-list-hint">
                Chưa có đồng nghiệp cùng phòng khám.
              </p>
              <p v-if="isVisitor" class="empty-list-hint">
                Dùng nút giữa màn hình để gọi tư vấn.
              </p>
            </div>

            <footer class="sidebar-user-footer">
              <div class="current-user-info">
                <div class="current-user-avatar">{{ userInitials(currentUser) }}</div>
                <div>
                  <strong class="current-user-name">{{ currentUser.displayName }}</strong>
                  <span class="current-user-meta">{{ roleLabel(currentUser.role) }} · {{ clinicLabel(currentUser.clinicId || currentUser.tenantId) }}</span>
                  <span v-if="!isVisitor && !isManager" :class="[selfAgentBadgeClass, 'self-status-badge']">{{ selfAgentBadgeLabel }}</span>
                </div>
              </div>
            </footer>
          </aside>

          <section class="main-stage">
            <!-- Placeholder for non-call nav icons (no page yet) -->
            <div v-if="!isCallNav" class="main-body">
              <div class="idle-placeholder nav-placeholder">
                <div class="hero-avatar-large hero-logo">S</div>
                <h2 class="idle-title">{{ (navRailItems.find(i => i.id === activeNav) || {}).label || 'Mục' }}</h2>
                <p class="idle-desc">Mục này chỉ là khung giao diện — chưa mở trang chi tiết trong PoC.</p>
                <button type="button" class="btn-secondary-pill" @click="selectNav('call')">Về cuộc gọi</button>
              </div>
            </div>

            <template v-else>
            <header class="main-header" v-if="selectedIdentity && !isManager">
              <div class="target-info">
                <div class="user-avatar accent">
                  {{ userInitials(selectedIdentity) }}
                  <div :class="['status-dot', isUserOnline(selectedIdentity.id) ? 'online' : 'offline']"></div>
                </div>
                <div class="target-details">
                  <span class="target-name">{{ selectedIdentity.displayName }}</span>
                  <span class="target-status">
                    <span v-if="sameTenant(selectedIdentity)" :class="agentBadgeClassFor(selectedIdentity.id)">{{ agentBadgeLabelFor(selectedIdentity.id) }}</span>
                    <span v-else>{{ contactStatusLabel(selectedIdentity) }}</span>
                  </span>
                </div>
              </div>
              <div class="header-call-actions">
                <button
                  type="button"
                  class="header-call-btn"
                  :disabled="isCallActive || !isUserOnline(selectedIdentity.id) || !sameTenant(selectedIdentity)"
                  @click="startCall(selectedIdentity.id, 'video')"
                  title="Gọi video (camera + micro)"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m16 13 5 3V8l-5 3V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2z"/></svg>
                  <span>Gọi video</span>
                </button>
                <button
                  type="button"
                  class="header-call-btn header-call-btn--audio"
                  :disabled="isCallActive || !isUserOnline(selectedIdentity.id) || !sameTenant(selectedIdentity)"
                  @click="startCall(selectedIdentity.id, 'audio')"
                  title="Gọi thoại (chỉ micro)"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.81.36 1.6.68 2.34a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.74.32 1.53.55 2.34.68A2 2 0 0 1 22 16.92z"/></svg>
                  <span>Gọi thoại</span>
                </button>
              </div>
            </header>

            <div class="main-body">
              <div v-if="popupState === 'active_window'" class="active-window-banner">
                <span>Cuộc gọi đang mở ở cửa sổ riêng</span>
                <button type="button" @click="reopenCallWindow">Mở lại</button>
              </div>

              <!-- Visitor home -->
              <div v-if="isVisitor" class="idle-placeholder">
                <div class="hero-avatar-large hero-logo">S</div>
                <h2 class="idle-title">Gọi tư vấn</h2>
                <p class="idle-desc">
                  Bạn sẽ vào hàng chờ. Nhân viên rảnh của phòng khám sẽ nhận cuộc gọi.
                  Chọn video (camera + micro) hoặc chỉ thoại.
                </p>
                <p v-if="queueItems.length" class="idle-meta">
                  Hiện có {{ queueItems.length }} yêu cầu đang chờ
                </p>
                <div class="call-actions-row">
                  <button type="button" class="start-call-btn" :disabled="isCallActive" @click="startQueueCall('video')">
                    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="m16 13 5 3V8l-5 3V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2z"/></svg>
                    <span>{{ isCallActive ? ('Đang ' + callStatusVi(call && call.status).toLowerCase()) : 'Gọi video' }}</span>
                  </button>
                  <button type="button" class="start-call-btn start-call-btn--secondary" :disabled="isCallActive" @click="startQueueCall('audio')">
                    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.81.36 1.6.68 2.34a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.74.32 1.53.55 2.34.68A2 2 0 0 1 22 16.92z"/></svg>
                    <span>Gọi thoại</span>
                  </button>
                </div>
              </div>

              <!-- Manager: consultations + legacy recordings -->
              <div v-else-if="isManager" class="manager-library">
                <header class="library-header">
                  <div>
                    <p class="library-kicker">{{ clinicLabel(currentUser.clinicId || currentUser.tenantId) }} · Quản lý</p>
                    <h2 class="library-title">Thư viện tư vấn</h2>
                    <p class="library-desc">
                      Media theo phiên tư vấn (audio + clip răng + ảnh). Chỉ quản lý đúng phòng khám.
                    </p>
                  </div>
                  <div class="library-actions">
                    <button type="button" class="btn-secondary-pill" @click="queuePanelOpen = true">
                      Khách chờ{{ queueItems.length ? ' (' + queueItems.length + ')' : '' }}
                    </button>
                    <button
                      type="button"
                      class="btn-secondary-pill"
                      :disabled="consultationsLoading || recordingsLoading"
                      @click="loadConsultations(); loadRecordings()"
                    >
                      {{ (consultationsLoading || recordingsLoading) ? 'Đang tải…' : 'Làm mới' }}
                    </button>
                  </div>
                </header>

                <h3 class="library-section-title" style="margin: 16px 0 8px; font-size: 15px;">Consultations</h3>
                <p v-if="consultationsError" class="library-error">{{ consultationsError }}</p>
                <div v-if="consultationsLoading && !consultations.length" class="library-empty">
                  Đang tải consultations…
                </div>
                <div v-else-if="!consultations.length" class="library-empty">
                  <p class="library-empty-title">Chưa có phiên tư vấn</p>
                  <p class="library-empty-desc">Sau khi staff Accept + consent, phiên và media sẽ xuất hiện ở đây.</p>
                </div>
                <div v-else class="library-table-wrap">
                  <table class="library-table">
                    <thead>
                      <tr>
                        <th>Bệnh nhân</th>
                        <th>Nhân viên</th>
                        <th>Media</th>
                        <th>Thời gian</th>
                        <th class="col-actions">Thao tác</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="row in consultations" :key="row.sessionId">
                        <td>
                          <div class="library-primary">{{ row.patientDisplayName || row.patientId }}</div>
                          <div class="library-secondary mono" :title="row.callId">{{ String(row.callId).slice(0, 8) }}…</div>
                        </td>
                        <td class="library-secondary">{{ row.staffDisplayName || row.staffId || '—' }}</td>
                        <td class="library-secondary">
                          🔊{{ row.audioCount }} · 🎬{{ row.videoCount }} · 📷{{ row.photoCount }}
                        </td>
                        <td class="library-secondary">
                          {{ formatViDateTime(row.startedAt || row.endedAt) }}
                          <span v-if="row.durationSeconds"> · {{ Math.round(row.durationSeconds / 60) }}p</span>
                        </td>
                        <td class="col-actions">
                          <button type="button" class="row-btn row-btn--primary" @click="openConsultationDetail(row.sessionId)">
                            Xem
                          </button>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <!-- Consultation detail modal -->
                <div v-if="consultationDetail" class="library-modal-backdrop" @click.self="closeConsultationDetail" style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:80;display:flex;align-items:center;justify-content:center;padding:16px;">
                  <div class="library-modal" style="background:#fff;border-radius:12px;max-width:720px;width:100%;max-height:85vh;overflow:auto;padding:20px;">
                    <header style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:12px;">
                      <div>
                        <h3 style="margin:0;">{{ consultationDetail.patientDisplayName }}</h3>
                        <p class="library-secondary" style="margin:4px 0 0;">
                          NV: {{ consultationDetail.staffDisplayName || '—' }} ·
                          {{ formatViDateTime(consultationDetail.startedAt) }}
                        </p>
                      </div>
                      <button type="button" class="btn-secondary-pill" @click="closeConsultationDetail">Đóng</button>
                    </header>
                    <div v-if="consultationDetailLoading">Đang tải…</div>
                    <template v-else>
                      <section v-if="consultationDetail.audio" style="margin-bottom:14px;">
                        <h4 style="margin:0 0 6px;">Audio phiên</h4>
                        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                          <span class="status-pill">{{ consultationDetail.audio.status }}</span>
                          <button v-if="consultationDetail.audio.canDownload" type="button" class="row-btn row-btn--primary"
                            :disabled="mediaActionId === consultationDetail.audio.assetId"
                            @click="downloadMediaAsset(consultationDetail.audio.assetId, 'CallAudio')">Tải audio</button>
                          <button v-if="consultationDetail.audio.canMarkDelete" type="button" class="row-btn row-btn--danger"
                            @click="deleteMediaAsset(consultationDetail.audio.assetId)">Xóa</button>
                        </div>
                      </section>
                      <section style="margin-bottom:14px;">
                        <h4 style="margin:0 0 6px;">Clip răng ({{ (consultationDetail.videoClips || []).length }})</h4>
                        <div v-if="!(consultationDetail.videoClips || []).length" class="library-secondary">Chưa có clip</div>
                        <div v-for="clip in (consultationDetail.videoClips || [])" :key="clip.assetId" style="display:flex;gap:8px;align-items:center;margin:6px 0;flex-wrap:wrap;">
                          <span>Clip {{ clip.displayIndex }}</span>
                          <span class="status-pill">{{ clip.status }}</span>
                          <span class="library-secondary" v-if="clip.width">{{ clip.width }}×{{ clip.height }}</span>
                          <button v-if="clip.canDownload" type="button" class="row-btn row-btn--primary"
                            @click="downloadMediaAsset(clip.assetId, 'DentalVideoClip')">Tải</button>
                          <button v-if="clip.canMarkDelete" type="button" class="row-btn row-btn--danger"
                            @click="deleteMediaAsset(clip.assetId)">Xóa</button>
                        </div>
                      </section>
                      <section>
                        <h4 style="margin:0 0 6px;">Ảnh ({{ (consultationDetail.photos || []).length }})</h4>
                        <div v-if="!(consultationDetail.photos || []).length" class="library-secondary">Chưa có ảnh</div>
                        <div style="display:flex;flex-wrap:wrap;gap:10px;">
                          <div v-for="ph in (consultationDetail.photos || [])" :key="ph.assetId" style="border:1px solid #e5e7eb;border-radius:8px;padding:8px;min-width:120px;">
                            <div class="library-secondary">Ảnh {{ ph.displayIndex }} · {{ ph.status }}</div>
                            <div style="margin-top:6px;display:flex;gap:6px;">
                              <button v-if="ph.canDownload" type="button" class="row-btn row-btn--primary"
                                @click="downloadMediaAsset(ph.assetId, 'Snapshot')">Tải</button>
                              <button v-if="ph.canMarkDelete" type="button" class="row-btn row-btn--danger"
                                @click="deleteMediaAsset(ph.assetId)">Xóa</button>
                            </div>
                          </div>
                        </div>
                      </section>
                    </template>
                  </div>
                </div>

                <h3 class="library-section-title" style="margin: 28px 0 8px; font-size: 15px;">Legacy recordings (trước media catalog)</h3>
                <div class="library-filters" role="tablist" aria-label="Lọc bản ghi cũ">
                  <button
                    type="button"
                    role="tab"
                    :class="['filter-chip', recordingsFilter === 'all' && 'active']"
                    @click="recordingsFilter = 'all'"
                  >Tất cả ({{ recordings.length }})</button>
                  <button
                    type="button"
                    role="tab"
                    :class="['filter-chip', recordingsFilter === 'complete' && 'active']"
                    @click="recordingsFilter = 'complete'"
                  >Sẵn sàng tải ({{ completeRecordingsCount }})</button>
                  <button
                    type="button"
                    role="tab"
                    :class="['filter-chip', recordingsFilter === 'failed' && 'active']"
                    @click="recordingsFilter = 'failed'"
                  >Lỗi</button>
                  <button
                    type="button"
                    role="tab"
                    :class="['filter-chip', recordingsFilter === 'deleted' && 'active']"
                    @click="recordingsFilter = 'deleted'"
                  >Đã xóa</button>
                </div>

                <p v-if="recordingsError" class="library-error">{{ recordingsError }}</p>

                <div v-if="recordingsLoading && !recordings.length" class="library-empty">
                  Đang tải danh sách bản ghi cũ…
                </div>
                <div v-else-if="!filteredRecordings.length" class="library-empty">
                  <p class="library-empty-title">Không có legacy recording</p>
                </div>
                <div v-else class="library-table-wrap">
                  <table class="library-table">
                    <thead>
                      <tr>
                        <th>Khách / cuộc gọi</th>
                        <th>Chế độ</th>
                        <th>Trạng thái</th>
                        <th>Cập nhật</th>
                        <th class="col-actions">Thao tác</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="row in filteredRecordings" :key="row.callId">
                        <td>
                          <div class="library-primary">{{ row.callerLabel || row.callerId }}</div>
                          <div class="library-secondary">
                            {{ row.assignedStaffId ? ('NV: ' + row.assignedStaffId) : 'Chưa gán NV' }}
                            · <span class="mono" :title="row.callId">{{ String(row.callId).slice(0, 8) }}…</span>
                          </div>
                        </td>
                        <td>{{ recordingModeLabel(row.recordingMode) }}</td>
                        <td>
                          <span
                            class="status-pill"
                            :class="'status-pill--' + String(row.recordingStatus || '').toLowerCase()"
                          >{{ recordingStatusLabelVi(row.recordingStatus) }}</span>
                        </td>
                        <td class="library-secondary">{{ formatViDateTime(row.updatedAt) }}</td>
                        <td class="col-actions">
                          <button
                            v-if="row.canDownload"
                            type="button"
                            class="row-btn row-btn--primary"
                            :disabled="recordingActionId === row.callId"
                            @click="downloadRecordingByCallId(row.callId)"
                          >Tải</button>
                          <button
                            v-if="row.canDelete && row.recordingStatus !== 'Deleted'"
                            type="button"
                            class="row-btn row-btn--danger"
                            :disabled="recordingActionId === row.callId"
                            @click="deleteRecordingByCallId(row.callId)"
                          >Xóa</button>
                          <span v-if="!row.canDownload && row.recordingStatus === 'Deleted'" class="library-secondary">—</span>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>

              <!-- Staff: peer selected -->
              <div v-else-if="selectedIdentity" class="idle-placeholder">
                <div class="hero-avatar-large">{{ userInitials(selectedIdentity) }}</div>
                <h2 class="idle-title">{{ selectedIdentity.displayName }}</h2>
                <p class="idle-desc">
                  <span :class="agentBadgeClassFor(selectedIdentity.id)">{{ agentBadgeLabelFor(selectedIdentity.id) }}</span>
                </p>
                <ul class="idle-steps">
                  <li><span class="idle-step-num">1</span><span>Khách website vào <strong>Khách chờ</strong> (góc dưới phải) — hệ thống mời bạn nhận máy.</span></li>
                  <li><span class="idle-step-num">2</span><span>Hoặc gọi nội bộ đồng nghiệp khi cả hai đang trực tuyến (video hoặc chỉ thoại).</span></li>
                </ul>
                <div class="call-actions-row">
                  <button
                    type="button"
                    class="start-call-btn"
                    :disabled="isCallActive || !sameTenant(selectedIdentity) || !isUserOnline(selectedIdentity.id)"
                    @click="startCall(selectedIdentity.id, 'video')"
                  >
                    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="m16 13 5 3V8l-5 3V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2z"/></svg>
                    <span>Gọi video</span>
                  </button>
                  <button
                    type="button"
                    class="start-call-btn start-call-btn--secondary"
                    :disabled="isCallActive || !sameTenant(selectedIdentity) || !isUserOnline(selectedIdentity.id)"
                    @click="startCall(selectedIdentity.id, 'audio')"
                  >
                    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.81.36 1.6.68 2.34a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.74.32 1.53.55 2.34.68A2 2 0 0 1 22 16.92z"/></svg>
                    <span>Gọi thoại</span>
                  </button>
                </div>
              </div>

              <!-- Staff empty -->
              <div v-else class="idle-placeholder">
                <div class="hero-avatar-large hero-logo">S</div>
                <h2 class="idle-title">Sẵn sàng tư vấn</h2>
                <p class="idle-desc">Chọn đồng nghiệp bên trái, hoặc mở <strong>Khách chờ</strong> (góc dưới phải) khi có khách từ website.</p>
                <button type="button" class="btn-secondary-pill" @click="queuePanelOpen = true">
                  Mở khách chờ
                </button>
              </div>
            </div>
            </template>
          </section>

          <aside class="right-sidebar" v-if="showDetailPanel && isCallNav">
            <div class="profile-section">
              <div class="right-profile-avatar">{{ userInitials(selectedIdentity) }}</div>
              <div class="right-profile-name">{{ selectedIdentity.displayName }}</div>
              <div class="peer-status-block">
                <span :class="agentBadgeClassFor(selectedIdentity.id)">{{ agentBadgeLabelFor(selectedIdentity.id) }}</span>
              </div>
              <p class="peer-clinic-line">{{ clinicLabel(selectedIdentity.clinicId || selectedIdentity.tenantId) }}</p>
              <p class="peer-help-text">
                Gọi video hoặc thoại nội bộ giữa nhân viên cùng phòng. Khách từ website được phân công qua hàng chờ — không cần gọi tay.
              </p>
              <div class="call-actions-row" style="margin-top: 16px;">
                <button
                  type="button"
                  class="start-call-btn"
                  :disabled="isCallActive || !sameTenant(selectedIdentity) || !isUserOnline(selectedIdentity.id)"
                  @click="startCall(selectedIdentity.id, 'video')"
                >Gọi video</button>
                <button
                  type="button"
                  class="start-call-btn start-call-btn--secondary"
                  :disabled="isCallActive || !sameTenant(selectedIdentity) || !isUserOnline(selectedIdentity.id)"
                  @click="startCall(selectedIdentity.id, 'audio')"
                >Gọi thoại</button>
              </div>
            </div>
          </aside>
        </main>

        <!-- Queue dock (staff + manager) — only on Call workspace -->
        <div v-if="!isVisitor && isCallNav" class="queue-dock" :class="{ open: queuePanelOpen }">
          <button
            type="button"
            class="queue-dock-toggle"
            :aria-expanded="queuePanelOpen ? 'true' : 'false'"
            aria-controls="queue-dock-panel"
            @click="queuePanelOpen = !queuePanelOpen"
          >
            <span class="queue-dock-label">Khách chờ</span>
            <span class="queue-dock-badge" :class="{ hot: queueItems.length > 0 }">{{ queueItems.length }}</span>
            <span v-if="queueMineCount > 0" class="queue-dock-mine">{{ queueMineCount }} của bạn</span>
            <span class="queue-dock-chevron" aria-hidden="true">{{ queuePanelOpen ? '▾' : '▴' }}</span>
          </button>
          <div
            v-show="queuePanelOpen"
            id="queue-dock-panel"
            class="queue-panel queue-panel--dock"
            aria-label="Khách đang chờ tư vấn"
          >
            <div class="queue-panel-header">
              <span class="queue-panel-title">Khách đang chờ</span>
              <button type="button" class="queue-panel-close" @click="queuePanelOpen = false" aria-label="Thu gọn">✕</button>
            </div>
            <div v-if="!queueItems.length" class="queue-empty">
              {{ isManager ? 'Chưa có khách trong hàng chờ.' : 'Hiện không có khách chờ. Khi có, hệ thống sẽ mời bạn nhận máy.' }}
            </div>
            <div v-else class="queue-panel-list">
              <div v-for="item in queueItems" :key="item.id" class="queue-row">
                <div class="queue-row-avatar">
                  <img :src="guestAvatarUrl" alt="" />
                </div>
                <div class="queue-row-body">
                  <div class="queue-row-name">{{ formatQueueLabel(item) }}</div>
                  <div class="queue-row-meta">
                    {{ queueStatusVi(item.status) }}
                    · chờ {{ formatWaitSeconds(item.waitingSeconds) }}
                    <template v-if="item.assignedStaffId"> · phụ trách {{ item.assignedStaffId }}</template>
                    <template v-else> · chưa phân công</template>
                  </div>
                </div>
                <div class="queue-row-tags">
                  <span
                    :class="['queue-tag', item.status === 'Ringing' ? 'queue-tag--ringing' : 'queue-tag--queued']"
                  >{{ queueStatusVi(item.status) }}</span>
                  <span v-if="isQueueAssignedToMe(item)" class="queue-tag queue-tag--mine">Của bạn</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- POPUPS -->
        <div v-if="popupState === 'incoming'" class="modal-backdrop">
          <div class="call-popup-card">
            <div class="pulse-ring-avatar" :title="peerName">{{ peerAvatar }}</div>
            <h3 class="popup-title">{{ peerName }}</h3>
            <p class="popup-subtitle">{{ isEmbedPeer ? 'Khách từ website đang chờ — cuộc gọi dành cho bạn.' : 'Đang gọi video cho bạn…' }}</p>
            <div class="popup-action-buttons">
              <button type="button" class="popup-btn danger" @click="rejectCall">Từ chối</button>
              <button type="button" class="popup-btn success" @click="acceptCall">Nhận cuộc gọi</button>
            </div>
          </div>
        </div>

        <div v-if="popupState === 'ringing'" class="modal-backdrop">
          <div class="call-popup-card">
            <div class="pulse-ring-avatar" :title="peerName">{{ peerAvatar }}</div>
            <h3 class="popup-title">{{ peerName }}</h3>
            <p class="popup-subtitle">Đang đổ chuông…</p>
            <div class="popup-action-buttons">
              <button type="button" class="popup-btn danger" @click="cancelCall">Hủy cuộc gọi</button>
            </div>
          </div>
        </div>

        <div v-if="popupState === 'popup_blocked'" class="modal-backdrop">
          <div class="call-popup-card">
            <h3 class="popup-title">Trình duyệt chặn cửa sổ gọi</h3>
            <p class="popup-subtitle">Bấm nút bên dưới để mở cửa sổ video.</p>
            <div class="popup-action-buttons">
              <button type="button" class="popup-btn primary" @click="reopenCallWindow">Mở cuộc gọi</button>
              <button type="button" class="popup-btn secondary" @click="closePopup">Đóng</button>
            </div>
          </div>
        </div>

        <div v-if="popupState === 'rejected'" class="modal-backdrop">
          <div class="call-popup-card">
            <h3 class="popup-title">Cuộc gọi bị từ chối</h3>
            <p class="popup-subtitle">{{ peerName }} đã từ chối cuộc gọi.</p>
            <div class="popup-action-buttons">
              <button type="button" class="popup-btn primary" @click="closePopup">Đóng</button>
            </div>
          </div>
        </div>

        <div v-if="popupState === 'busy'" class="modal-backdrop">
          <div class="call-popup-card">
            <h3 class="popup-title">Đồng nghiệp đang bận</h3>
            <p class="popup-subtitle">Người này đang trong cuộc gọi khác. Thử lại sau.</p>
            <div class="popup-action-buttons">
              <button type="button" class="popup-btn primary" @click="closePopup">Đóng</button>
            </div>
          </div>
        </div>

        <div v-if="popupState === 'ended'" class="modal-backdrop">
          <div class="call-popup-card">
            <h3 class="popup-title">Cuộc gọi đã kết thúc</h3>
            <p class="popup-subtitle">Bạn có thể nhận khách mới từ hàng chờ.</p>
            <div class="popup-action-buttons">
              <button type="button" class="popup-btn primary" @click="closePopup">Đóng</button>
            </div>
          </div>
        </div>

        <div v-if="popupState === 'error'" class="modal-backdrop">
          <div class="call-popup-card">
            <h3 class="popup-title">Không thực hiện được</h3>
            <p class="popup-subtitle">{{ popupErrorMessage }}</p>
            <div class="popup-action-buttons">
              <button type="button" class="popup-btn primary" @click="closePopup">Đóng</button>
            </div>
          </div>
        </div>
      </div>
    `
  })
}
