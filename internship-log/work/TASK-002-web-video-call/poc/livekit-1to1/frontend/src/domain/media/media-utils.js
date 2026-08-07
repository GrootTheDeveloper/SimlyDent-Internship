/**
 * @file domain/media/media-utils.js
 * @description Browser media utility functions for portrait normalization,
 * video display fitting, and orientation detection.
 *
 * Ownership: domain/media
 * Dependencies: livekit-client (LocalVideoTrack, Track)
 *
 * Rules:
 * - DOM access is allowed (ResizeObserver, canvas, video elements)
 * - No Vue imports
 * - No business call logic
 * - No auth or API calls
 *
 * These utilities encapsulate the multi-layer camera orientation complexity
 * described in the ROOT CAUSE comment block (landscape sensor → portrait UI).
 */

import { LocalVideoTrack, Track, VideoPreset, VideoPresets } from 'livekit-client'

// ---------------------------------------------------------------------------
// Orientation detection
// ---------------------------------------------------------------------------

/**
 * Determine if the current device UI is portrait-oriented.
 * Uses screen.orientation API, matchMedia, and visualViewport as fallbacks.
 *
 * @returns {boolean}
 */
export function isPortraitCapturePreferred() {
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
 * Preferred video capture resolution.
 * Capture at sensor-friendly 1280×720. Do NOT request 720×1280 / aspectRatio 9:16
 * on portrait phones — browsers crop the sensor FOV to match, which feels "zoomed".
 * Portrait layout is handled later by contain-letterbox (publish + remote display).
 *
 * @returns {object} LiveKit resolution constraint
 */
export function preferredVideoCaptureResolution() {
  return VideoPresets.h720.resolution
}

/**
 * Portrait simulcast layers (height-major) when publishing from a vertical device.
 *
 * @returns {VideoPreset[]}
 */
export function preferredSimulcastLayers() {
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

// ---------------------------------------------------------------------------
// Portrait normalization pipeline
//
// ROOT CAUSE summary (camera dọc nhưng remote ngang):
//   Layer 1 — Sensor vs UI: phone is portrait but sensor delivers landscape frames.
//   Layer 2 — Local preview lies: browser applies display rotation for local <video>.
//   Layer 3 — WebRTC/SFU drop rotation metadata: remote sees raw buffer orientation.
//   Layer 4 — Our previous bug: we ctx.rotate(±90°) based on screen.orientation,
//             but Chromium already gives upright pixels to drawImage(video) →
//             double rotation (portrait box + sideways person).
//
// Correct approach:
//   1) Prefer VideoFrame.rotation via MediaStreamTrackProcessor — apply ONCE.
//   2) Fallback: drawImage(video) with NO guessed rotation, center-CONTAIN into 9:16.
//   3) Never use screen.orientation.angle alone to invent a 90° turn.
// ---------------------------------------------------------------------------

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
              console.info('[media-utils] VideoFrame portrait bake', {
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
          try { frame.close() } catch { /* ignore */ }
          console.warn('[media-utils] VideoFrame bake frame error', e)
        }
      }
    } catch (e) {
      if (!stopped) console.warn('[media-utils] VideoFrame pump ended', e)
    } finally {
      try { await writer.close() } catch { /* ignore */ }
      try { reader.releaseLock() } catch { /* ignore */ }
    }
  }

  pump()

  const normalizedTrack = new LocalVideoTrack(generator, undefined, true)
  normalizedTrack.source = Track.Source.Camera

  const cleanup = () => {
    stopped = true
    try { reader.cancel() } catch { /* ignore */ }
    try { generator.stop() } catch { /* ignore */ }
    try { sourceTrack.stop() } catch { /* ignore */ }
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
    console.warn('[media-utils] canvas cover: video.play failed', e)
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

  console.info('[media-utils] canvas contain portrait (full FOV, no zoom crop)', `${vw}x${vh}`, '→', `${outW}x${outH}`)

  const cleanup = () => {
    stopped = true
    cancelAnimationFrame(raf)
    try { outMst.stop() } catch { /* ignore */ }
    try { sourceTrack.stop() } catch { /* ignore */ }
    video.srcObject = null
  }

  return { track: normalizedTrack, cleanup, normalized: true }
}

/**
 * Normalize a single video track for portrait publishing.
 * Tries MediaStreamTrackProcessor first, falls back to canvas loop.
 *
 * @param {import('livekit-client').LocalVideoTrack} sourceTrack
 * @returns {Promise<{ track, cleanup, normalized: boolean }>}
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
      console.warn('[media-utils] VideoFrame path failed, canvas cover fallback', e)
    }
  }
  return normalizePortraitViaCanvasCover(sourceTrack)
}

/**
 * If UI is portrait, ensure published camera track is portrait-sized + upright.
 * Returns { tracks, cleanup }.
 *
 * @param {object[]} localTracks  Array of LiveKit local tracks
 * @returns {Promise<{ tracks: object[], cleanup: () => void }>}
 */
export async function prepareLocalTracksForOrientation(localTracks) {
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
      console.info('[media-utils] native portrait track', settings.width, 'x', settings.height)
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

// ---------------------------------------------------------------------------
// Video display layout helpers
// ---------------------------------------------------------------------------

/**
 * Local PiP: size <video> to stream aspect within max box; host is fit-content
 * (no oversized grey frame — border is on the video itself).
 *
 * @param {HTMLVideoElement} element
 * @param {HTMLElement|null} hostEl
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
    element.style.removeProperty('width')
    element.style.removeProperty('height')
    element.style.setProperty('width', 'auto', 'important')
    element.style.setProperty('height', 'auto', 'important')
    element.style.setProperty('object-fit', 'contain', 'important')
    element.style.setProperty('object-position', 'center center', 'important')

    if (vw > 0 && vh > 0 && hostEl) {
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
 *   width:100% + height:100% makes the <video> element fill the landscape stage.
 *   We size the element to the largest rect that fits stream aspect — black bars
 *   are the host background.
 *
 * @param {HTMLVideoElement} element
 * @param {HTMLElement|null} [hostEl=null]
 */
export function applyVideoDisplayFit(element, hostEl = null) {
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
      try { element._letterboxRO.disconnect() } catch { /* ignore */ }
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
