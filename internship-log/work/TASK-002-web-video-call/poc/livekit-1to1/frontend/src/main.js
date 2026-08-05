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

// Determine route mode
const path = window.location.pathname
const isCallRoute = path.startsWith('/call/')

if (isCallRoute) {
  // =========================================================================
  // 1. STANDALONE CALL WINDOW APP (/call/{callId})
  // =========================================================================
  const callId = path.replace('/call/', '').trim()
  const userId = new URLSearchParams(window.location.search).get('user') || 'A1'

  new Vue({
    el: '#app',
    data: {
      callId,
      userId,
      identities: [],
      call: null,
      hub: null,
      room: null,
      localTracks: [],
      /** Stops canvas portrait pipeline (if used) */
      localMediaCleanup: null,
      connected: false,
      joining: false,
      mediaPermissionState: 'idle',
      cameraEnabled: true,
      microphoneEnabled: true,
      remoteVideoConnected: false,
      needsAudioPermission: false,
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
      broadcastChannel: null
    },
    computed: {
      peerId() {
        if (!this.call) return ''
        return this.call.callerId === this.userId ? this.call.calleeId : this.call.callerId
      },
      peerName() {
        const p = this.identities.find(i => i.id === this.peerId)
        return p?.displayName || this.peerId
      },
      mediaSetupLabel() {
        if (this.mediaPermissionState === 'requesting') return 'Đang xin quyền camera và microphone…'
        if (this.mediaPermissionState === 'connecting') return 'Đang kết nối vào phòng media…'
        if (this.mediaPermissionState === 'error') return this.error || 'Không thể kết nối media'
        if (this.mediaPermissionState === 'connected' && !this.remoteVideoConnected) return 'Đang chờ video từ người còn lại…'
        return 'Đang chuẩn bị thiết bị…'
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
        return this.call?.recordingAvailable === true
      }
    },
    async mounted() {
      // Init BroadcastChannel
      if ('BroadcastChannel' in window) {
        this.broadcastChannel = new BroadcastChannel('livekit_call_channel')
        this.broadcastChannel.postMessage({ type: 'CALL_WINDOW_OPENED', callId: this.callId })
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
          const res = await fetch(`${API_URL}/api/identities`)
          this.identities = await res.json()
        } catch (e) {
          console.error(e)
        }
      },
      async verifyAndConnect() {
        try {
          // Connect SignalR first for realtime updates
          await this.connectRealtime()

          // Verify Call with Backend
          const res = await fetch(`${API_URL}/api/calls/${this.callId}`, {
            headers: { 'X-User-Id': this.userId }
          })
          if (!res.ok) {
            throw new Error('Cuộc gọi không tồn tại hoặc bạn không có quyền truy cập.')
          }
          this.call = await res.json()

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
          .withUrl(`${API_URL}/hubs/calls?userId=${encodeURIComponent(this.userId)}`)
          .withAutomaticReconnect()
          .build()

        this.hub.on('CallUpdated', async call => {
          if (call.id !== this.callId) return
          const prevStatus = this.call?.status
          this.call = call

          if (call.status === 'Accepted' && prevStatus !== 'Accepted') {
            await this.joinRoom()
          } else if (['Rejected', 'Cancelled', 'Ended'].includes(call.status)) {
            this.handleCallEnded()
          }
        })
        await this.hub.start()
        this.connected = true
      },
      async joinRoom() {
        if (this.room || this.joining) return
        this.joining = true
        try {
          // Fetch Media Token
          const res = await fetch(`${API_URL}/api/calls/${this.callId}/token`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-User-Id': this.userId
            }
          })
          if (!res.ok) {
            const errData = await res.json().catch(() => ({}))
            throw new Error(errData.error || 'Không thể lấy Token kết nối media')
          }
          const credentials = await res.json()

          this.mediaPermissionState = 'requesting'
          let localTracks = []
          try {
            const captureResolution = preferredVideoCaptureResolution()
            localTracks = await createLocalTracks({
              audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
              },
              video: {
                facingMode: 'user',
                // Native-ish 1280×720 FOV only — no forced 9:16 (that zooms/crops).
                resolution: captureResolution
              }
            })
            const prepared = await prepareLocalTracksForOrientation(localTracks)
            localTracks = prepared.tracks
            if (typeof this.localMediaCleanup === 'function') this.localMediaCleanup()
            this.localMediaCleanup = prepared.cleanup
          } catch (e) {
            console.warn('Could not start video, falling back to audio only:', e)
            try {
              localTracks = await createLocalTracks({ audio: true, video: false })
              this.cameraEnabled = false
            } catch (e2) {
              throw e
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
          room.on(RoomEvent.TrackSubscribed, track => this.attachRemoteTrack(track))
          room.on(RoomEvent.TrackPublished, publication => {
            publication.setSubscribed(true)
          })
          room.on(RoomEvent.TrackSubscriptionFailed, () => {
            this.remoteVideoConnected = false
            this.error = 'Không thể nhận video từ người còn lại.'
          })
          room.on(RoomEvent.TrackUnsubscribed, track => {
            track.detach().forEach(node => node.remove())
            if (track.kind === Track.Kind.Video) this.remoteVideoConnected = false
          })
          room.on(RoomEvent.AudioPlaybackStatusChanged, () => {
            this.needsAudioPermission = !room.canPlaybackAudio
          })
          room.on(RoomEvent.Disconnected, () => {
            this.handleCallEnded()
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
        const publication = this.room
          ? [...this.room.localParticipant.videoTrackPublications.values()][0]
          : null
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
      async toggleCamera() {
        if (!this.room) return
        this.cameraEnabled = !this.cameraEnabled
        await this.room.localParticipant.setCameraEnabled(this.cameraEnabled)
        if (this.cameraEnabled) this.attachLocalVideo()
        else if (this.$refs.localMedia) this.$refs.localMedia.replaceChildren()
      },
      async toggleMicrophone() {
        if (!this.room) return
        this.microphoneEnabled = !this.microphoneEnabled
        await this.room.localParticipant.setMicrophoneEnabled(this.microphoneEnabled)
      },
      async enableAudioPlayback() {
        if (this.room) {
          await this.room.startAudio()
          this.needsAudioPermission = !this.room.canPlaybackAudio
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
            `${url}?userId=${encodeURIComponent(this.userId)}`,
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
              headers: {
                'Content-Type': 'application/json',
                'X-User-Id': this.userId
              },
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
          const res = await fetch(`${API_URL}/api/calls/${this.callId}/quality/export?format=${format}`, {
            headers: { 'X-User-Id': this.userId }
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
        } catch (err) {
          this.error = err.message
        }
      },
      async toggleRecording() {
        if (this.recordingBusy || this.recordingInProgress) return
        if (!this.isRecording && !window.confirm('Bắt đầu ghi hình cuộc gọi? Cả hai bên sẽ thấy trạng thái Đang ghi.')) return
        this.recordingBusy = true
        this.error = ''
        try {
          const action = this.isRecording ? 'stop' : 'start'
          const res = await fetch(`${API_URL}/api/calls/${this.callId}/recording/${action}`, {
            method: 'POST',
            headers: { 'X-User-Id': this.userId }
          })
          const body = await res.json().catch(() => ({}))
          if (!res.ok) throw new Error(body.error || 'Không thể thay đổi trạng thái ghi hình.')
          this.call = body
        } catch (err) {
          this.error = err.message
        } finally {
          this.recordingBusy = false
        }
      },
      async downloadRecording() {
        try {
          const res = await fetch(`${API_URL}/api/calls/${this.callId}/recording/file`, {
            headers: { 'X-User-Id': this.userId }
          })
          if (!res.ok) {
            const body = await res.json().catch(() => ({}))
            throw new Error(body.error || 'File ghi hình chưa sẵn sàng.')
          }
          const blob = await res.blob()
          const url = URL.createObjectURL(blob)
          const link = document.createElement('a')
          link.href = url
          link.download = this.call.recordingFileName || `call-${this.callId}.mp4`
          link.click()
          URL.revokeObjectURL(url)
        } catch (err) {
          this.error = err.message
        }
      },
      async endCall() {
        // Prevent double-tap / concurrent hangup paths hanging the UI
        if (this._endingCall) return
        this._endingCall = true
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

          await fetch(`${API_URL}/api/calls/${this.callId}/${action}`, {
            method: 'POST',
            headers: { 'X-User-Id': this.userId },
            keepalive: true
          }).catch(err => console.warn('end/cancel API', err))
        } catch (e) {
          console.error(e)
        } finally {
          this.handleCallEnded()
          this._endingCall = false
        }
      },
      handleCallEnded() {
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
        this.flushQualityLog(true)
        if (this.call && ['Accepted', 'Ringing'].includes(this.call.status)) {
          const action = this.call.status === 'Accepted' ? 'end' : 'cancel'
          navigator.sendBeacon(`${API_URL}/api/calls/${this.callId}/${action}?userId=${encodeURIComponent(this.userId)}`)
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
            <div class="call-header-avatar">{{ peerId || '?' }}</div>
            <div>
              <div class="call-header-title">{{ peerName }}</div>
              <div class="call-header-status">{{ call ? call.status : 'Đang tải...' }}</div>
            </div>
          </div>
          <div class="call-header-actions">
            <span v-if="isRecording" class="recording-indicator"><span></span> Đang ghi</span>
            <button v-if="mediaPermissionState === 'connected'" class="quality-badge" @click="showQualityPanel = !showQualityPanel" title="Xem chất lượng đường truyền">{{ qualityBadge }}</button>
            <button v-if="needsAudioPermission" class="audio-fallback-btn" @click="enableAudioPlayback">Bật âm thanh</button>
          </div>
        </header>

        <main class="call-window-body">
          <!-- Connecting / Waiting State -->
          <div v-if="!call || call.status !== 'Accepted'" class="call-connecting-state">
            <div class="pulse-ring-avatar">{{ peerId || '?' }}</div>
            <h2>{{ peerName }}</h2>
            <p v-if="call && call.status === 'Ringing'">{{ call.callerId === userId ? 'Đang đổ chuông...' : 'Đang nhận cuộc gọi...' }}</p>
            <p v-else-if="call">{{ call.status }}</p>
            <p v-else>Đang kết nối tới máy chủ...</p>
          </div>

          <!-- Video Grid inside Call Window -->
          <div v-else class="call-video-grid">
            <div class="remote-video-container" ref="remoteMedia">
              <span v-if="mediaPermissionState !== 'connected' || !remoteVideoConnected" class="remote-video-status">{{ mediaSetupLabel }}</span>
            </div>
            <div class="local-video-container" ref="localMedia"></div>
            <div ref="remoteAudio"></div>

            <section v-if="showQualityPanel" class="quality-panel" aria-label="Chất lượng cuộc gọi">
              <div class="quality-panel-title">Chất lượng thực tế</div>
              <dl>
                <div><dt>Nhận</dt><dd>{{ qualityStats.incomingResolution }} · {{ qualityStats.incomingFps }} fps</dd></div>
                <div><dt>Tốc độ nhận</dt><dd>{{ qualityStats.incomingBitrateKbps }} kbps</dd></div>
                <div><dt>Gửi</dt><dd>{{ qualityStats.outgoingResolution }} · {{ qualityStats.outgoingFps }} fps</dd></div>
                <div><dt>Tốc độ gửi</dt><dd>{{ qualityStats.outgoingBitrateKbps }} kbps</dd></div>
                <div><dt>Mất gói</dt><dd>{{ qualityStats.packetLossPercent }}%</dd></div>
                <div><dt>Độ trễ</dt><dd>{{ qualityStats.roundTripTimeMs }} ms</dd></div>
                <div><dt>Codec</dt><dd>{{ qualityStats.codec }}</dd></div>
                <div><dt>Giới hạn</dt><dd>{{ qualityStats.qualityLimitationReason }}</dd></div>
              </dl>
              <div class="quality-export-actions">
                <button @click="downloadQualityLog('json')">Tải JSON</button>
                <button @click="downloadQualityLog('csv')">Tải CSV</button>
              </div>
            </section>

            <div class="call-window-controls">
              <button v-if="mediaPermissionState === 'connected'" :class="['ctrl-btn', !microphoneEnabled && 'off']" @click="toggleMicrophone" :title="microphoneEnabled ? 'Tắt Mic' : 'Bật Mic'">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3M8 22h8"/></svg>
              </button>
              <button v-if="mediaPermissionState === 'connected'" :class="['ctrl-btn', !cameraEnabled && 'off']" @click="toggleCamera" :title="cameraEnabled ? 'Tắt Cam' : 'Bật Cam'">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m16 13 5 3V8l-5 3V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2z"/></svg>
              </button>
              <button v-if="mediaPermissionState === 'connected'" :class="['ctrl-btn', 'record-btn', isRecording && 'recording']" :disabled="recordingBusy || recordingInProgress" @click="toggleRecording" :title="isRecording ? 'Dừng ghi hình' : 'Bắt đầu ghi hình'">
                <span class="record-dot"></span>
              </button>
              <button v-if="recordingAvailable" class="ctrl-btn download-btn" @click="downloadRecording" title="Tải file ghi hình">
                <svg viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>
              </button>
              <button v-if="mediaPermissionState === 'error'" class="start-call-btn" style="padding: 8px 16px; font-size: 13px;" @click="joinRoom">
                Thử lại
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
      /** userId -> online bool (same tenant only) */
      onlineMap: {},
      showOtherTenants: false
    },
    computed: {
      identityId() {
        return this.currentUser?.id || ''
      },
      isCallActive() {
        return !!(this.call && ['Ringing', 'Accepted'].includes(this.call.status))
      },
      selectedIdentity() {
        return this.identities.find(i => i.id === this.targetId)
          || this.visibleContacts[0]
          || null
      },
      visibleContacts() {
        const query = this.searchQuery.trim().toLowerCase()
        const tenant = this.currentUser?.tenantId
        return this.identities.filter(i => {
          if (i.id === this.identityId) return false
          // Default: only same clinic/tenant (demo B1 is other clinic)
          if (!this.showOtherTenants && tenant && i.tenantId !== tenant) return false
          if (!query) return true
          return `${i.id} ${i.displayName} ${i.tenantId}`.toLowerCase().includes(query)
        })
      },
      peerIdentity() {
        if (!this.call) return this.selectedIdentity
        const peerId = this.call.callerId === this.identityId ? this.call.calleeId : this.call.callerId
        return this.identities.find(i => i.id === peerId) || { id: peerId, displayName: peerId }
      },
      peerName() {
        return this.peerIdentity?.displayName || this.peerIdentity?.id || ''
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

      await this.loadIdentities()
      const urlUser = new URLSearchParams(window.location.search).get('user')
      if (urlUser) {
        const user = this.identities.find(i => i.id === urlUser)
        if (user) {
          this.login(user)
        }
      }
    },
    beforeDestroy() {
      if (this.hub) this.hub.stop()
      if (this.broadcastChannel) this.broadcastChannel.close()
    },
    methods: {
      async loadIdentities() {
        try {
          const res = await fetch(`${API_URL}/api/identities`)
          this.identities = await res.json()
        } catch (err) {
          this.popupErrorMessage = 'Không thể tải danh sách tài khoản: ' + err.message
          this.popupState = 'error'
        }
      },
      async login(user) {
        this.currentUser = user
        this.isLoggedIn = true
        this.onlineMap = {}
        history.replaceState(null, '', `?user=${user.id}`)
        const sameTenantPeers = this.identities.filter(
          i => i.id !== user.id && i.tenantId === user.tenantId
        )
        this.targetId = sameTenantPeers[0]?.id || ''
        await this.connectRealtime()
      },
      async logout() {
        if (this.hub) await this.hub.stop()
        this.currentUser = null
        this.isLoggedIn = false
        this.call = null
        this.popupState = 'none'
        this.onlineMap = {}
        history.replaceState(null, '', location.pathname)
      },
      isUserOnline(userId) {
        return !!this.onlineMap[userId]
      },
      applyPresenceSnapshot(snapshot) {
        if (!snapshot?.users) return
        const next = { ...this.onlineMap }
        for (const u of snapshot.users) {
          next[u.userId] = !!u.online
        }
        // Self is online while this page is connected
        if (this.identityId) next[this.identityId] = true
        this.onlineMap = next
      },
      clearCallUiState({ showEndedToast = false } = {}) {
        this.call = null
        this.popupState = showEndedToast ? 'ended' : 'none'
        this.callWindowRef = null
      },
      async connectRealtime() {
        if (this.hub) await this.hub.stop()
        this.hub = new signalR.HubConnectionBuilder()
          .withUrl(`${API_URL}/hubs/calls?userId=${encodeURIComponent(this.identityId)}`)
          .withAutomaticReconnect()
          .build()

        this.hub.on('CallUpdated', call => {
          // Ignore events for other users' calls (shouldn't happen, but be safe)
          if (call.callerId !== this.identityId && call.calleeId !== this.identityId) return

          this.call = call

          if (call.status === 'Ringing') {
            this.popupState = call.calleeId === this.identityId ? 'incoming' : 'ringing'
          } else if (call.status === 'Accepted') {
            this.popupState = 'active_window'
          } else if (call.status === 'Rejected') {
            this.popupState = 'rejected'
          } else if (call.status === 'Cancelled' || call.status === 'Ended') {
            // Keep toast, but allow selecting users again immediately
            this.popupState = 'ended'
            // Soft-clear after showing toast — call object kept for peerName in modal
            // selectUser uses isCallActive (terminal statuses are not active)
          }
        })

        this.hub.on('PresenceUpdated', snapshot => {
          this.applyPresenceSnapshot(snapshot)
        })

        this.hub.onreconnected(async () => {
          await this.refreshPresence()
        })

        await this.hub.start()
        await this.refreshPresence()

        // Check if there is an active call already
        try {
          const res = await fetch(`${API_URL}/api/calls/active`, {
            headers: { 'X-User-Id': this.identityId }
          })
          if (res.ok && res.status !== 204) {
            const activeCall = await res.json()
            this.call = activeCall
            if (activeCall.status === 'Accepted') {
              this.popupState = 'active_window'
            } else if (activeCall.status === 'Ringing') {
              this.popupState = activeCall.callerId === this.identityId ? 'ringing' : 'incoming'
            }
          }
        } catch (e) {
          console.error(e)
        }
      },
      async refreshPresence() {
        try {
          const res = await fetch(`${API_URL}/api/presence`, {
            headers: { 'X-User-Id': this.identityId }
          })
          if (res.ok) {
            this.applyPresenceSnapshot(await res.json())
          }
        } catch (e) {
          console.warn('presence fetch failed', e)
        }
      },
      selectUser(userId) {
        if (userId === this.identityId) return
        // Only block while call is truly active (was: !this.call → stuck after end)
        if (this.isCallActive) return
        const peer = this.identities.find(i => i.id === userId)
        if (!peer) return
        if (!this.sameTenant(peer) && !this.showOtherTenants) return
        this.targetId = userId
      },
      sameTenant(item) {
        return item.tenantId === this.currentUser?.tenantId
      },
      contactStatusLabel(item) {
        if (!this.sameTenant(item)) return 'Phòng khám / tenant khác'
        return this.isUserOnline(item.id) ? 'Đang online' : 'Offline'
      },
      async startCall(targetId) {
        if (this.isCallActive) return
        const peer = this.identities.find(i => i.id === targetId)
        if (!peer) return
        if (!this.sameTenant(peer)) {
          this.popupErrorMessage = 'Không thể gọi user thuộc phòng khám / tenant khác.'
          this.popupState = 'error'
          return
        }
        if (!this.isUserOnline(targetId)) {
          this.popupErrorMessage = 'User đang offline (chưa mở app / mất kết nối realtime). Chỉ gọi được khi họ online.'
          this.popupState = 'error'
          return
        }
        this.targetId = targetId
        const isMobile = window.innerWidth < 768

        // Open blank popup immediately to avoid popup blocker on Desktop
        let popupWin = null
        if (!isMobile) {
          popupWin = window.open('about:blank', `Call_${targetId}`, 'width=960,height=680,scrollbars=no,resizable=yes')
        }

        try {
          const res = await fetch(`${API_URL}/api/calls`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-User-Id': this.identityId
            },
            body: JSON.stringify({ calleeId: targetId })
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

          const callUrl = `/call/${call.id}?user=${this.identityId}`
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

        let popupWin = null
        if (!isMobile) {
          popupWin = window.open('about:blank', `Call_${this.call.id}`, 'width=960,height=680,scrollbars=no,resizable=yes')
        }

        try {
          const res = await fetch(`${API_URL}/api/calls/${this.call.id}/accept`, {
            method: 'POST',
            headers: { 'X-User-Id': this.identityId }
          })

          if (!res.ok) {
            if (popupWin) popupWin.close()
            const errData = await res.json().catch(() => ({}))
            this.popupErrorMessage = errData.error || 'Không thể chấp nhận cuộc gọi'
            this.popupState = 'error'
            return
          }

          const call = await res.json()
          this.call = call
          this.popupState = 'active_window'

          const callUrl = `/call/${call.id}?user=${this.identityId}`
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
          await fetch(`${API_URL}/api/calls/${this.call.id}/reject`, {
            method: 'POST',
            headers: { 'X-User-Id': this.identityId }
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
          await fetch(`${API_URL}/api/calls/${this.call.id}/cancel`, {
            method: 'POST',
            headers: { 'X-User-Id': this.identityId }
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
        const callUrl = `/call/${this.call.id}?user=${this.identityId}`
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
        <!-- LOGIN SCREEN -->
        <div v-if="!isLoggedIn" class="login-overlay">
          <div class="login-card">
            <div class="login-brand">
              <div class="login-logo">S</div>
              <h1>SimlyDent Call</h1>
            </div>
            <p>Chọn tài khoản thử nghiệm để đăng nhập</p>
            <div class="demo-account-list">
              <button
                v-for="user in identities"
                :key="user.id"
                class="account-btn"
                @click="login(user)"
              >
                <div class="account-avatar">{{ user.id }}</div>
                <div class="account-info">
                  <span class="account-name">{{ user.displayName }}</span>
                  <span class="account-id">ID: {{ user.id }} · Tenant: {{ user.tenantId }}</span>
                </div>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg>
              </button>
            </div>
          </div>
        </div>

        <!-- MAIN APP (3 COLUMNS) -->
        <main v-else class="app-shell">
          <!-- LEFT COLUMN: Contact / People Sidebar -->
          <aside class="sidebar">
            <header class="sidebar-header">
              <h1>Đoạn chat</h1>
              <div class="header-actions">
                <button class="action-circle-btn" title="Menu">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>
                </button>
                <button class="action-circle-btn" title="Tạo mới">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                </button>
              </div>
            </header>

            <div class="search-container">
              <div class="search-input-wrapper">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
                <input v-model="searchQuery" type="search" placeholder="Tìm kiếm trên SimlyDent" />
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
                  {{ item.id }}
                  <div
                    v-if="sameTenant(item)"
                    :class="['status-dot', isUserOnline(item.id) ? 'online' : 'offline']"
                  ></div>
                </div>
                <div class="contact-details">
                  <div class="contact-name">{{ item.displayName }}</div>
                  <div class="contact-status">{{ contactStatusLabel(item) }}</div>
                </div>
              </div>
              <p v-if="!visibleContacts.length" style="padding: 16px; color: #65676b; font-size: 13px;">
                Không có đồng nghiệp cùng phòng khám trong danh sách demo.
              </p>
            </div>

            <footer class="sidebar-user-footer">
              <div class="current-user-info">
                <div class="current-user-avatar">{{ currentUser.id }}</div>
                <div>
                  <strong style="font-size: 14px; display: block;">{{ currentUser.displayName }}</strong>
                  <span style="font-size: 11px; color: #65676b;">ID: {{ currentUser.id }}</span>
                </div>
              </div>
              <button class="logout-btn" @click="logout">Đăng xuất</button>
            </footer>
          </aside>

          <!-- MIDDLE COLUMN: Conversation Main Stage -->
          <section class="main-stage">
            <header class="main-header" v-if="selectedIdentity">
              <div class="target-info">
                <div class="user-avatar accent">
                  {{ selectedIdentity.id }}
                  <div :class="['status-dot', isUserOnline(selectedIdentity.id) ? 'online' : 'offline']"></div>
                </div>
                <div class="target-details">
                  <span class="target-name">{{ selectedIdentity.displayName }}</span>
                  <span class="target-status">{{ contactStatusLabel(selectedIdentity) }}</span>
                </div>
              </div>
              <button
                class="header-call-btn"
                :disabled="isCallActive || !isUserOnline(selectedIdentity.id) || !sameTenant(selectedIdentity)"
                @click="startCall(selectedIdentity.id)"
              >
                <svg viewBox="0 0 24 24"><path d="m16 13 5 3V8l-5 3V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2z"/></svg>
                <span>Gọi video</span>
              </button>
            </header>

            <div class="main-body">
              <!-- Active window status banner -->
              <div v-if="popupState === 'active_window'" class="active-window-banner">
                <span>🎥 Cuộc gọi đang diễn ra trong cửa sổ riêng</span>
                <button @click="reopenCallWindow">Mở lại cửa sổ</button>
              </div>

              <!-- Idle Placeholder -->
              <div v-if="selectedIdentity" class="idle-placeholder">
                <div class="hero-avatar-large">{{ selectedIdentity.id }}</div>
                <h2 style="margin: 0; font-size: 22px;">{{ selectedIdentity.displayName }}</h2>
                <p style="margin: 0; color: #65676b; font-size: 14px;">Thực hiện cuộc gọi video 1:1 trong cửa sổ riêng</p>
                <button
                  class="start-call-btn"
                  :disabled="isCallActive || !isUserOnline(selectedIdentity.id) || !sameTenant(selectedIdentity)"
                  @click="startCall(selectedIdentity.id)"
                >
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="m16 13 5 3V8l-5 3V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2z"/></svg>
                  <span>{{ isUserOnline(selectedIdentity.id) ? 'Bắt đầu cuộc gọi video' : 'User offline — không gọi được' }}</span>
                </button>
              </div>
            </div>
          </section>

          <!-- RIGHT COLUMN: Messenger Details Sidebar -->
          <aside class="right-sidebar" v-if="selectedIdentity">
            <div class="profile-section">
              <div class="right-profile-avatar">{{ selectedIdentity.id }}</div>
              <div class="right-profile-name">{{ selectedIdentity.displayName }}</div>
              <div class="encryption-badge">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                <span>Được mã hóa đầu cuối</span>
              </div>

              <div class="action-buttons-group">
                <div class="icon-action-item">
                  <div class="icon-action-circle">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                  </div>
                  <span>Trang cá n...</span>
                </div>
                <div class="icon-action-item">
                  <div class="icon-action-circle">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
                  </div>
                  <span>Tắt thông báo</span>
                </div>
                <div class="icon-action-item">
                  <div class="icon-action-circle">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
                  </div>
                  <span>Tìm kiếm</span>
                </div>
              </div>
            </div>

            <div class="accordion-section">
              <div class="accordion-item">
                <span>Thông tin về đoạn chat</span>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>
              </div>
              <div class="accordion-item">
                <span>Tùy chỉnh đoạn chat</span>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>
              </div>
              <div class="accordion-item">
                <span>File phương tiện và file</span>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>
              </div>
              <div class="accordion-item">
                <span>Quyền riêng tư và hỗ trợ</span>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>
              </div>
            </div>
          </aside>
        </main>

        <!-- POPUPS ON MAIN PAGE -->
        <!-- 1. Incoming Call Popup -->
        <div v-if="popupState === 'incoming'" class="modal-backdrop">
          <div class="call-popup-card">
            <div class="pulse-ring-avatar">{{ peerIdentity.id }}</div>
            <h3 class="popup-title">{{ peerName }}</h3>
            <p class="popup-subtitle">đang gọi video cho bạn...</p>
            <div class="popup-action-buttons">
              <button class="popup-btn danger" @click="rejectCall">Từ chối</button>
              <button class="popup-btn success" @click="acceptCall">Chấp nhận</button>
            </div>
          </div>
        </div>

        <!-- 2. Outgoing Call Ringing Popup -->
        <div v-if="popupState === 'ringing'" class="modal-backdrop">
          <div class="call-popup-card">
            <div class="pulse-ring-avatar">{{ peerIdentity.id }}</div>
            <h3 class="popup-title">{{ peerName }}</h3>
            <p class="popup-subtitle">Đang đổ chuông...</p>
            <div class="popup-action-buttons">
              <button class="popup-btn danger" @click="cancelCall">Hủy cuộc gọi</button>
            </div>
          </div>
        </div>

        <!-- 3. Popup Blocked Alert -->
        <div v-if="popupState === 'popup_blocked'" class="modal-backdrop">
          <div class="call-popup-card">
            <h3 class="popup-title">Trình duyệt đã chặn cửa sổ gọi</h3>
            <p class="popup-subtitle">Vui lòng bấm nút bên dưới để mở cửa sổ cuộc gọi video.</p>
            <div class="popup-action-buttons">
              <button class="popup-btn primary" @click="reopenCallWindow">Mở cuộc gọi</button>
              <button class="popup-btn secondary" @click="closePopup">Hủy</button>
            </div>
          </div>
        </div>

        <!-- 4. Rejected Alert -->
        <div v-if="popupState === 'rejected'" class="modal-backdrop">
          <div class="call-popup-card">
            <h3 class="popup-title">Bị từ chối</h3>
            <p class="popup-subtitle">{{ peerName }} đã từ chối cuộc gọi.</p>
            <div class="popup-action-buttons">
              <button class="popup-btn primary" @click="closePopup">Đóng</button>
            </div>
          </div>
        </div>

        <!-- 5. Busy Alert -->
        <div v-if="popupState === 'busy'" class="modal-backdrop">
          <div class="call-popup-card">
            <h3 class="popup-title">Người nhận bận</h3>
            <p class="popup-subtitle">Người dùng này đang trong một cuộc gọi khác.</p>
            <div class="popup-action-buttons">
              <button class="popup-btn primary" @click="closePopup">Đóng</button>
            </div>
          </div>
        </div>

        <!-- 6. Ended Alert -->
        <div v-if="popupState === 'ended'" class="modal-backdrop">
          <div class="call-popup-card">
            <h3 class="popup-title">Đã kết thúc</h3>
            <p class="popup-subtitle">Cuộc gọi video đã kết thúc.</p>
            <div class="popup-action-buttons">
              <button class="popup-btn primary" @click="closePopup">Đóng</button>
            </div>
          </div>
        </div>

        <!-- 7. Error Alert -->
        <div v-if="popupState === 'error'" class="modal-backdrop">
          <div class="call-popup-card">
            <h3 class="popup-title" style="color: var(--color-danger);">Có lỗi xảy ra</h3>
            <p class="popup-subtitle">{{ popupErrorMessage }}</p>
            <div class="popup-action-buttons">
              <button class="popup-btn primary" @click="closePopup">Thử lại</button>
            </div>
          </div>
        </div>
      </div>
    `
  })
}
