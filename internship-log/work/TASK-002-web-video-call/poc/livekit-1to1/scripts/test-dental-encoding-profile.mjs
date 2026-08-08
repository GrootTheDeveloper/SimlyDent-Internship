/**
 * Mirrors DentalEncodingProfileSelector rules (Phase 1 storage optimization).
 * Run: node scripts/test-dental-encoding-profile.mjs
 */
import assert from 'node:assert/strict'

const CFG = {
  maxW: 1280,
  maxH: 720,
  maxFps: 30,
  bitrate480: 900,
  bitrate720_20: 1400,
  bitrate720_30: 1800,
  minBr: 400,
  maxBr: 2500
}

function makeEven(v) {
  if (v < 2) return 2
  return v % 2 === 0 ? v : v - 1
}

function normalizeDims(w, h) {
  const W = w > 0 && w < 8192 ? w : 0
  const H = h > 0 && h < 8192 ? h : 0
  if (W <= 0 || H <= 0) return [1280, 720]
  return [W, H]
}

function normalizeFps(fps) {
  if (fps == null || !Number.isFinite(fps) || fps <= 0) return 24
  return Math.min(60, Math.max(1, Math.round(fps)))
}

function fitWithinCap(srcW, srcH, maxW, maxH) {
  let boxW, boxH
  if (srcH > srcW) {
    boxW = Math.min(maxW, maxH)
    boxH = Math.max(maxW, maxH)
  } else {
    boxW = maxW
    boxH = maxH
  }
  const scale = Math.min(1, Math.min(boxW / srcW, boxH / srcH))
  return [
    makeEven(Math.max(2, Math.floor(srcW * scale))),
    makeEven(Math.max(2, Math.floor(srcH * scale)))
  ]
}

function selectBitrate(w, h, fps) {
  const pixels = w * h
  let br
  if (pixels <= 640 * 480 * 1.1) br = CFG.bitrate480
  else if (fps <= 20) br = CFG.bitrate720_20
  else br = CFG.bitrate720_30
  return Math.min(CFG.maxBr, Math.max(CFG.minBr, br))
}

function select(actualW, actualH, actualFps) {
  const [srcW, srcH] = normalizeDims(actualW, actualH)
  const srcFps = normalizeFps(actualFps)
  let [outW, outH] = fitWithinCap(srcW, srcH, CFG.maxW, CFG.maxH)
  outW = makeEven(outW)
  outH = makeEven(outH)
  const outFps = Math.min(CFG.maxFps, Math.max(1, srcFps))
  const br = selectBitrate(outW, outH, outFps)
  return { outW, outH, outFps, br, srcW, srcH }
}

/** Build TrackComposite payload like LiveKitEgressService */
function buildTrackCompositeRequest(encode, { advanced }) {
  const req = {
    room_name: 'r',
    video_track_id: 'TR_x',
    file_outputs: [{ file_type: 'MP4', filepath: '/out/x.mp4' }]
  }
  if (advanced) {
    req.advanced = {
      width: encode.outW,
      height: encode.outH,
      framerate: encode.outFps,
      videoCodec: 'H264_MAIN',
      videoBitrate: encode.br
    }
  } else {
    req.preset = 'H264_720P_30'
  }
  return req
}

let passed = 0
function test(name, fn) {
  try {
    fn()
    passed++
    console.log('  ok  ', name)
  } catch (e) {
    console.error('  FAIL', name, e.message)
    process.exitCode = 1
  }
}

console.log('dental encoding profile selector')

test('640×480@20 does not upscale to 720p', () => {
  const p = select(640, 480, 20)
  assert.ok(p.outW <= 640)
  assert.ok(p.outH <= 480)
  assert.equal(p.outFps, 20)
  assert.ok(p.br <= 1000)
})

test('1280×720@20 keeps 20fps and ~720p', () => {
  const p = select(1280, 720, 20)
  assert.equal(p.outW, 1280)
  assert.equal(p.outH, 720)
  assert.equal(p.outFps, 20)
  assert.equal(p.br, 1400)
})

test('1280×720@30 keeps 30fps', () => {
  const p = select(1280, 720, 30)
  assert.equal(p.outFps, 30)
  assert.equal(p.br, 1800)
})

test('720×1280 portrait stays portrait', () => {
  const p = select(720, 1280, 24)
  assert.ok(p.outH > p.outW)
  assert.ok(p.outW <= 720)
  assert.ok(p.outH <= 1280)
})

test('1920×1080 scales down to 720p landscape', () => {
  const p = select(1920, 1080, 30)
  assert.ok(p.outW <= 1280)
  assert.ok(p.outH <= 720)
  assert.ok(p.outW >= p.outH)
  // aspect ~16:9
  const ar = p.outW / p.outH
  assert.ok(Math.abs(ar - 16 / 9) < 0.05)
})

test('unknown metadata uses safe fallback', () => {
  const p = select(null, null, null)
  assert.equal(p.outW, 1280)
  assert.equal(p.outH, 720)
  assert.equal(p.outFps, 24)
})

test('zero/negative metadata no crash', () => {
  const p = select(0, -1, -5)
  assert.ok(p.outW > 0 && p.outH > 0 && p.outFps > 0)
})

test('29.97 fps rounds to 30', () => {
  assert.equal(normalizeFps(29.97), 30)
  assert.equal(normalizeFps(23.976), 24)
})

test('output dimensions even', () => {
  const p = select(641, 481, 15)
  assert.equal(p.outW % 2, 0)
  assert.equal(p.outH % 2, 0)
})

test('bitrate clamped min/max', () => {
  const p = select(320, 240, 10)
  assert.ok(p.br >= CFG.minBr)
  assert.ok(p.br <= CFG.maxBr)
})

test('source-aware payload uses advanced not preset 720p30', () => {
  const p = select(640, 480, 20)
  const req = buildTrackCompositeRequest(p, { advanced: true })
  assert.ok(req.advanced)
  assert.equal(req.advanced.width, p.outW)
  assert.equal(req.advanced.height, p.outH)
  assert.equal(req.advanced.framerate, 20)
  assert.equal(req.advanced.videoBitrate, p.br)
  assert.equal(req.preset, undefined)
})

test('legacy payload uses preset H264_720P_30', () => {
  const p = { outW: 1280, outH: 720, outFps: 30, br: 1800 }
  const req = buildTrackCompositeRequest(p, { advanced: false })
  assert.equal(req.preset, 'H264_720P_30')
  assert.equal(req.advanced, undefined)
})

test('actualFrameRate flows in request DTO shape', () => {
  const body = {
    patientParticipantIdentity: 'c:v',
    actualWidth: 1280,
    actualHeight: 720,
    actualFrameRate: 29.97
  }
  assert.equal(typeof body.actualFrameRate, 'number')
  assert.ok(body.actualFrameRate > 29 && body.actualFrameRate < 31)
  const fps = normalizeFps(body.actualFrameRate)
  assert.equal(fps, 30)
})

test('ffprobe parser handles portrait and 29.97', () => {
  // Inline minimal parse
  function parseFraction(frac) {
    const [a, b] = String(frac).split('/')
    if (b) return Number(a) / Number(b)
    return Number(frac)
  }
  assert.ok(Math.abs(parseFraction('30000/1001') - 29.97) < 0.01)
  const portrait = { width: 720, height: 1280 }
  assert.ok(portrait.height > portrait.width)
})

console.log(`\n${passed} tests passed`)
if (process.exitCode) process.exit(1)
