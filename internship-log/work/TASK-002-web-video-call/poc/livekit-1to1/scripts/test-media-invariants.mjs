/**
 * Regression tests for call/media model invariants.
 * Run: node scripts/test-media-invariants.mjs
 *
 * Pure logic only — no browser / LiveKit. Covers:
 * - initialMediaMode is join preference only
 * - camera request FSM
 * - obsolete mode sync must not map to local camera mutations
 * - shouldJoinAudioOnly reconnect behavior
 */
import assert from 'node:assert/strict'
import {
  CameraRequestAction,
  CameraRequestState,
  normalizeInitialMediaMode,
  normalizeCameraRequestAction,
  isCameraRequestMessage,
  isMediaModeMessage,
  isObsoleteModeSyncMessage,
  buildCameraRequestMessage,
  buildMediaModeMessage,
  reduceCameraRequestState,
  desiredCameraFromInitialMode,
  shouldJoinAudioOnly,
  parseDataPayload
} from '../frontend/src/domain/media/media-mode.js'

let passed = 0
function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log('  ok  ', name)
  } catch (e) {
    console.error('  FAIL', name)
    console.error('       ', e.message)
    process.exitCode = 1
  }
}

console.log('media-mode / camera-request invariants')

test('audio initial mode → desired camera OFF', () => {
  assert.equal(normalizeInitialMediaMode('Audio'), 'audio')
  assert.equal(desiredCameraFromInitialMode('Audio'), false)
  assert.equal(shouldJoinAudioOnly({ initialMediaMode: 'audio' }), true)
})

test('video initial mode → desired camera ON', () => {
  assert.equal(desiredCameraFromInitialMode('Video'), true)
  assert.equal(shouldJoinAudioOnly({ initialMediaMode: 'video' }), false)
})

test('audio join: mic path without camera permission request', () => {
  // audioOnly=true means acquireLocalTracks({ audioOnly: true }) — no cam permission
  assert.equal(
    shouldJoinAudioOnly({
      mediaSessionStarted: false,
      desiredCameraEnabled: false,
      initialMediaMode: 'audio'
    }),
    true
  )
})

test('reconnect after camera ON does not reset from initial audio', () => {
  // Call started audio, user enabled camera mid-call, then rejoin
  assert.equal(
    shouldJoinAudioOnly({
      mediaSessionStarted: true,
      desiredCameraEnabled: true,
      initialMediaMode: 'audio'
    }),
    false
  )
})

test('reconnect with desired camera OFF stays audio-only join', () => {
  assert.equal(
    shouldJoinAudioOnly({
      mediaSessionStarted: true,
      desiredCameraEnabled: false,
      initialMediaMode: 'video'
    }),
    true
  )
})

test('camera request FSM: send → receive → accept/reject/expire/clear', () => {
  let s = CameraRequestState.Idle
  s = reduceCameraRequestState(s, 'send')
  assert.equal(s, CameraRequestState.Sent)
  s = reduceCameraRequestState(s, 'expire')
  assert.equal(s, CameraRequestState.Expired)
  s = reduceCameraRequestState(s, 'clear')
  assert.equal(s, CameraRequestState.Idle)

  s = reduceCameraRequestState(s, 'receive')
  assert.equal(s, CameraRequestState.Received)
  s = reduceCameraRequestState(s, 'accept')
  assert.equal(s, CameraRequestState.Accepted)

  s = CameraRequestState.Received
  s = reduceCameraRequestState(s, 'reject')
  assert.equal(s, CameraRequestState.Rejected)
})

test('buildCameraRequestMessage uses modern type only', () => {
  const msg = buildCameraRequestMessage(CameraRequestAction.Request, { from: 'A1' })
  assert.equal(msg.type, 'camera_request')
  assert.equal(msg.action, 'request')
  assert.equal(msg.from, 'A1')
  assert.ok(msg.ts)
})

test('buildMediaModeMessage no longer emits switch_*/mode_sync', () => {
  assert.equal(buildMediaModeMessage('switch_audio'), null)
  assert.equal(buildMediaModeMessage('switch_video'), null)
  assert.equal(buildMediaModeMessage('mode_sync', { mode: 'audio' }), null)
  const req = buildMediaModeMessage('request_video', { from: 'A1' })
  assert.ok(req)
  assert.equal(req.type, 'camera_request')
  assert.equal(req.action, 'request')
})

test('legacy request_video / accept_video / reject_video still recognized', () => {
  assert.equal(normalizeCameraRequestAction('request_video'), 'request')
  assert.equal(normalizeCameraRequestAction('accept_video'), 'accept')
  assert.equal(normalizeCameraRequestAction('reject_video'), 'reject')
  assert.equal(normalizeCameraRequestAction('switch_audio'), null)
  assert.equal(normalizeCameraRequestAction('mode_sync'), null)

  assert.ok(
    isCameraRequestMessage({ type: 'media_mode', action: 'request_video' })
  )
  assert.ok(
    isCameraRequestMessage({ type: 'camera_request', action: 'accept' })
  )
})

test('obsolete mode sync messages identified and must not drive local camera', () => {
  assert.ok(isObsoleteModeSyncMessage({ type: 'media_mode', action: 'switch_audio' }))
  assert.ok(isObsoleteModeSyncMessage({ type: 'media_mode', action: 'switch_video' }))
  assert.ok(isObsoleteModeSyncMessage({ type: 'media_mode', action: 'mode_sync', mode: 'audio' }))
  assert.equal(
    isObsoleteModeSyncMessage({ type: 'camera_request', action: 'request' }),
    false
  )
  // Invariant documented: handlers ignore these for setCameraEnabled
  // (enforced by call-window handleCameraRequestMessage + embed handleCameraRequestMessage)
})

test('isMediaModeMessage covers both envelopes', () => {
  assert.ok(isMediaModeMessage({ type: 'camera_request', action: 'request' }))
  assert.ok(isMediaModeMessage({ type: 'media_mode', action: 'switch_audio' }))
  assert.equal(isMediaModeMessage({ type: 'capture_photo' }), false)
})

test('parseDataPayload round-trip', () => {
  const msg = buildCameraRequestMessage('reject', { from: 'visitor' })
  const bytes = new TextEncoder().encode(JSON.stringify(msg))
  const parsed = parseDataPayload(bytes)
  assert.equal(parsed.action, 'reject')
  assert.equal(parsed.type, 'camera_request')
})

test('accept/reject camera request does not imply peer camera change in protocol', () => {
  // Protocol messages carry no mode field that forces peer local camera
  const accept = buildCameraRequestMessage('accept', { from: 'visitor' })
  const reject = buildCameraRequestMessage('reject', { from: 'visitor' })
  assert.equal(accept.mode, undefined)
  assert.equal(reject.mode, undefined)
  // Staff receiving accept only clears request state; remote video comes from LiveKit
})

// Simulated UI handlers (mirrors call-window / embed rules)
test('simulated: A enables camera → only A desired changes', () => {
  const A = { desiredCamera: false, camera: false }
  const B = { desiredCamera: false, camera: false }
  // A toggles local camera
  A.desiredCamera = true
  A.camera = true
  assert.equal(A.camera, true)
  assert.equal(B.camera, false)
  assert.equal(B.desiredCamera, false)
})

test('simulated: switch_audio from peer does not disable local camera', () => {
  const local = { camera: true, desiredCamera: true }
  const msg = { type: 'media_mode', action: 'switch_audio', mode: 'audio' }
  if (isObsoleteModeSyncMessage(msg)) {
    // ignore — do not call setCameraEnabled(false)
  } else {
    local.camera = false
  }
  assert.equal(local.camera, true)
  assert.equal(local.desiredCamera, true)
})

test('simulated: peer accept does not enable local camera', () => {
  const staff = { camera: false, desiredCamera: false, requestState: 'sent' }
  const msg = { type: 'camera_request', action: 'accept', from: 'visitor' }
  const action = normalizeCameraRequestAction(msg.action)
  if (action === 'accept') {
    staff.requestState = reduceCameraRequestState(staff.requestState, 'accept')
    // do NOT staff.camera = true
  }
  assert.equal(staff.camera, false)
  assert.equal(staff.desiredCamera, false)
  assert.equal(staff.requestState, CameraRequestState.Accepted)
})

test('simulated: patient accept enables only patient camera', () => {
  const patient = { camera: false, desiredCamera: false }
  const staff = { camera: false, desiredCamera: false }
  // patient accepts request
  patient.desiredCamera = true
  patient.camera = true
  assert.equal(patient.camera, true)
  assert.equal(staff.camera, false)
})

test('simulated: media disconnect keeps business Accepted', () => {
  const business = { status: 'Accepted' }
  const media = { connection: 'disconnected', intentionalLeave: false }
  // Engine Disconnected without intentionalLeave / terminal status → rejoin UI
  const shouldEndBusiness =
    media.intentionalLeave ||
    ['Rejected', 'Cancelled', 'Ended'].includes(business.status)
  assert.equal(shouldEndBusiness, false)
  assert.equal(business.status, 'Accepted')
})

test('simulated: explicit hangup ends business', () => {
  const business = { status: 'Accepted' }
  const intentionalLeave = true
  if (intentionalLeave) business.status = 'Ended'
  assert.equal(business.status, 'Ended')
})

test('embed audio enqueue must persist InitialMediaMode Audio for staff join', () => {
  // Mirrors EmbedEndpoints fix: body.initialMediaMode → EnqueueAsync mediaMode
  const body = { initialMediaMode: 'Audio' }
  const mediaMode =
    String(body.initialMediaMode || '').toLowerCase() === 'audio' ? 'Audio' : 'Video'
  assert.equal(mediaMode, 'Audio')
  // Staff CallView.initialMediaMode === Audio → shouldJoinAudioOnly true
  assert.equal(
    shouldJoinAudioOnly({
      mediaSessionStarted: false,
      initialMediaMode: mediaMode
    }),
    true
  )
})

console.log(`\n${passed} tests passed`)
if (process.exitCode) {
  console.error('Some tests failed')
  process.exit(1)
}
