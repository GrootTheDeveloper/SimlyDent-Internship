/**
 * Unit tests for visitor local media control helpers (no browser).
 * Run: node scripts/test-local-media-controls.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Load UMD as classic script (frontend package is "type":"module")
const src = fs.readFileSync(
  path.join(__dirname, '../frontend/public/widget/local-media-controls.js'),
  'utf8'
)
const sandbox = {
  module: { exports: {} },
  exports: {},
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval
}
sandbox.module.exports = sandbox.exports
sandbox.globalThis = sandbox
vm.runInNewContext(src, sandbox, { filename: 'local-media-controls.js' })
const LMC = sandbox.module.exports || sandbox.SimlyDentLocalMediaControls
if (!LMC || typeof LMC.getActualMicEnabled !== 'function') {
  throw new Error('Failed to load SimlyDentLocalMediaControls')
}

function mockParticipant({ mic, cam, micMuted, camMuted, noGetter } = {}) {
  const audioPub = mic == null
    ? null
    : { kind: 'audio', isMuted: !!micMuted, track: mic ? { kind: 'audio' } : null }
  const videoPub = cam == null
    ? null
    : { kind: 'video', isMuted: !!camMuted, track: cam ? { kind: 'video' } : null }

  const p = {
    audioTrackPublications: new Map(audioPub ? [['a', audioPub]] : []),
    videoTrackPublications: new Map(videoPub ? [['v', videoPub]] : []),
    trackPublications: new Map(
      [
        audioPub && ['a', audioPub],
        videoPub && ['v', videoPub]
      ].filter(Boolean)
    ),
    getTrackPublication(src) {
      if (String(src).toLowerCase().includes('micro') || src === 2) return audioPub
      if (String(src).toLowerCase().includes('camera') || src === 1) return videoPub
      return null
    }
  }
  if (!noGetter) {
    Object.defineProperty(p, 'isMicrophoneEnabled', {
      get() { return !!mic && !micMuted }
    })
    Object.defineProperty(p, 'isCameraEnabled', {
      get() { return !!cam && !camMuted }
    })
  }
  return p
}

let passed = 0
function ok(name, fn) {
  fn()
  console.log('  ok  ', name)
  passed++
}

console.log('local media controls')

ok('getActualMicEnabled uses isMicrophoneEnabled', () => {
  const p = mockParticipant({ mic: true })
  assert.equal(LMC.getActualMicEnabled(p), true)
  const p2 = mockParticipant({ mic: false })
  assert.equal(LMC.getActualMicEnabled(p2), false)
})

ok('getActualMicEnabled respects muted publication without getter', () => {
  const p = mockParticipant({ mic: true, micMuted: true, noGetter: true })
  assert.equal(LMC.getActualMicEnabled(p), false)
  const p2 = mockParticipant({ mic: true, micMuted: false, noGetter: true })
  assert.equal(LMC.getActualMicEnabled(p2), true)
})

ok('getActualCameraEnabled uses isCameraEnabled', () => {
  assert.equal(LMC.getActualCameraEnabled(mockParticipant({ cam: true })), true)
  assert.equal(LMC.getActualCameraEnabled(mockParticipant({ cam: false })), false)
})

ok('planToggle busy/not ready/run', () => {
  assert.equal(LMC.planToggle({ busy: true }).action, 'busy')
  assert.equal(LMC.planToggle({ roomConnected: false, participant: {} }).action, 'disable')
  const run = LMC.planToggle({
    roomConnected: true,
    participant: {},
    current: false
  })
  assert.equal(run.action, 'run')
  assert.equal(run.want, true)
  assert.equal(run.current, false)
})

ok('micButtonUi busy disables', () => {
  const u = LMC.micButtonUi({ busy: true, roomReady: true, enabled: false })
  assert.equal(u.disabled, true)
  assert.match(u.text, /…|\.\.\./)
})

ok('camButtonUi room not ready disabled', () => {
  const u = LMC.camButtonUi({ roomReady: false, enabled: false })
  assert.equal(u.disabled, true)
  assert.match(u.title, /chưa sẵn sàng/i)
})

ok('micButtonUi reflects off state', () => {
  const on = LMC.micButtonUi({ roomReady: true, enabled: true, busy: false })
  assert.equal(on.off, false)
  assert.equal(on.disabled, false)
  const off = LMC.micButtonUi({ roomReady: true, enabled: false, busy: false })
  assert.equal(off.off, true)
})

// Simulate async setMicrophoneEnabled reject → UI must not flip optimistically
ok('reject path: state only from actual after await', async () => {
  let actual = true
  const participant = {
    get isMicrophoneEnabled() { return actual },
    async setMicrophoneEnabled(want) {
      throw new Error('Permission denied')
    }
  }
  // Caller pattern used by frame.js
  const before = LMC.getActualMicEnabled(participant)
  let ui = before
  try {
    await participant.setMicrophoneEnabled(!before)
    ui = !before // would only run on success
  } catch {
    ui = LMC.getActualMicEnabled(participant) // rollback to actual
  }
  assert.equal(ui, true)
  assert.equal(ui, before)
})

ok('success path: state updates only after resolve', async () => {
  let actual = false
  const participant = {
    get isMicrophoneEnabled() { return actual },
    async setMicrophoneEnabled(want) {
      await new Promise((r) => setTimeout(r, 5))
      actual = !!want
    }
  }
  let ui = LMC.getActualMicEnabled(participant)
  assert.equal(ui, false)
  const want = true
  await participant.setMicrophoneEnabled(want)
  ui = LMC.getActualMicEnabled(participant)
  assert.equal(ui, true)
})

ok('double-click plan: second busy while first in flight', () => {
  const p1 = LMC.planToggle({ busy: false, roomConnected: true, participant: {}, current: true })
  assert.equal(p1.action, 'run')
  const p2 = LMC.planToggle({ busy: true, roomConnected: true, participant: {}, current: true })
  assert.equal(p2.action, 'busy')
})

ok('roomIsConnected', () => {
  assert.equal(LMC.roomIsConnected(null), false)
  assert.equal(LMC.roomIsConnected({ state: 'connected', localParticipant: {} }), true)
  assert.equal(LMC.roomIsConnected({ state: 'disconnected' }), false)
})

// waitForMediaState
await (async () => {
  let v = false
  setTimeout(() => { v = true }, 40)
  const res = await LMC.waitForMediaState(() => v, true, { timeoutMs: 500, intervalMs: 20 })
  assert.equal(res.ok, true)
  assert.equal(res.actual, true)
  console.log('  ok   waitForMediaState resolves when actual matches')
  passed++

  const res2 = await LMC.waitForMediaState(() => false, true, { timeoutMs: 80, intervalMs: 20 })
  assert.equal(res2.ok, false)
  console.log('  ok   waitForMediaState timeout')
  passed++
})()

console.log('\n' + passed + ' tests passed')
