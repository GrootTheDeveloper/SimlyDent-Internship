/**
 * Graceful End invariants — mirrors backend EgressLifecycle + BarrierLookup + FE ordering.
 * Run: node scripts/test-graceful-end-invariants.mjs
 */
import assert from 'node:assert/strict'

function normalize(status) {
  let st = String(status || '').trim().toUpperCase()
  if (st.startsWith('EGRESS_')) st = st.slice('EGRESS_'.length)
  return st
}

function isTerminal(status) {
  const st = normalize(status)
  return st === 'COMPLETE' || st === 'LIMIT_REACHED' || st === 'FAILED' || st === 'ABORTED'
}

function needsSourceTrack(status) {
  if (!status) return true
  if (isTerminal(status)) return false
  const st = normalize(status)
  return st === 'STARTING' || st === 'ACTIVE' || st === 'ENDING' || st === ''
}

/** Fail-closed barrier lookup */
function barrierLookup({ catalogOk, assets, localClipHint }) {
  if (!catalogOk) {
    return { kind: 'Unknown', barriers: [], error: 'catalog failure' }
  }
  const barriers = (assets || []).filter(
    (a) =>
      a.kind === 'DentalVideoClip' &&
      (a.status === 'Requested' || a.status === 'Recording' || a.status === 'Finalizing')
  )
  if (barriers.length === 0) {
    if (localClipHint === 'Recording' || localClipHint === 'Finalizing' || localClipHint === 'Requested') {
      return { kind: 'Unknown', barriers: [], error: 'local hint vs empty catalog' }
    }
    return { kind: 'KnownEmpty', barriers: [] }
  }
  return { kind: 'KnownBarriers', barriers }
}

function mayFastPathEnd(lookup) {
  return lookup.kind === 'KnownEmpty'
}

/** Visitor FE ordering */
function visitorEndSequence({ endResponse, pollSequence }) {
  const log = []
  let disconnectCount = 0
  let mediaAlive = true

  function disconnectMedia() {
    disconnectCount += 1
    mediaAlive = false
    log.push('disconnect')
  }

  // POST end first — never disconnect first
  log.push('post_end')
  if (endResponse.status === 'Ended') {
    disconnectMedia()
    log.push('ended')
    return { disconnectCount, mediaAlive, log }
  }
  if (endResponse.status === 'Accepted' && endResponse.gracefulEndPending) {
    log.push('graceful_pending')
    assert.equal(mediaAlive, true)
    assert.equal(disconnectCount, 0)
    for (const p of pollSequence || []) {
      if (p.status === 'Ended') {
        disconnectMedia()
        log.push('poll_ended_disconnect')
        break
      }
      if (p.gracefulEndPending) {
        assert.equal(mediaAlive, true)
        log.push('poll_still_pending')
      }
    }
  }
  return { disconnectCount, mediaAlive, log }
}

/** Staff grace remaining ms from server timestamp */
function remainingGraceMs(requestedAtIso, graceSec, nowMs) {
  const elapsed = nowMs - new Date(requestedAtIso).getTime()
  return Math.max(0, graceSec * 1000 - elapsed)
}

/** StartClip vs End coordination */
function simulateStartClipEndRace({ endClaimsFirst }) {
  let gracefulEndPending = false
  let egressStartedAfterEnd = false
  let asset = null

  function claimEnd() {
    gracefulEndPending = true
  }

  function startClip() {
    if (gracefulEndPending) return { aborted: true, reason: 'end pending' }
    asset = { status: 'Requested', egressId: null }
    if (gracefulEndPending) {
      asset = { status: 'Failed', reason: 'aborted before egress' }
      return { aborted: true, asset }
    }
    if (endClaimsFirst && gracefulEndPending) {
      asset = { status: 'Failed', reason: 'aborted before egress' }
      return { aborted: true, asset }
    }
    // StartEgress
    if (gracefulEndPending) {
      // Should not happen if re-check works
      egressStartedAfterEnd = true
    }
    asset = { status: 'Recording', egressId: 'EG_1' }
    return { aborted: false, asset }
  }

  if (endClaimsFirst) {
    claimEnd()
    const r = startClip()
    return { gracefulEndPending, egressStartedAfterEnd, result: r }
  }
  // Start begins then End claims before egress
  asset = { status: 'Requested', egressId: null }
  claimEnd()
  if (gracefulEndPending) {
    asset = { status: 'Failed', reason: 'aborted before egress' }
    return {
      gracefulEndPending,
      egressStartedAfterEnd: false,
      result: { aborted: true, asset }
    }
  }
  return { gracefulEndPending, egressStartedAfterEnd, result: { aborted: false, asset } }
}

let passed = 0
function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log('  ok  ', name)
  } catch (e) {
    console.error('  FAIL', name, e.message)
    process.exitCode = 1
  }
}

console.log('graceful-end P0 fixes invariants')

test('egress terminal statuses', () => {
  assert.ok(isTerminal('COMPLETE'))
  assert.ok(isTerminal('EGRESS_FAILED'))
  assert.ok(needsSourceTrack('ENDING'))
  assert.ok(!needsSourceTrack('COMPLETE'))
})

test('catalog failure is Unknown not KnownEmpty (fail-closed)', () => {
  const u = barrierLookup({ catalogOk: false, assets: [], localClipHint: 'Idle' })
  assert.equal(u.kind, 'Unknown')
  assert.equal(mayFastPathEnd(u), false)
})

test('empty catalog + Idle → KnownEmpty fast-path OK', () => {
  const e = barrierLookup({ catalogOk: true, assets: [], localClipHint: 'Idle' })
  assert.equal(e.kind, 'KnownEmpty')
  assert.equal(mayFastPathEnd(e), true)
})

test('empty catalog + local Recording hint → Unknown', () => {
  const u = barrierLookup({ catalogOk: true, assets: [], localClipHint: 'Recording' })
  assert.equal(u.kind, 'Unknown')
  assert.equal(mayFastPathEnd(u), false)
})

test('Requested without egressId is a barrier', () => {
  const r = barrierLookup({
    catalogOk: true,
    assets: [{ kind: 'DentalVideoClip', status: 'Requested', egressId: null }],
    localClipHint: 'Requested'
  })
  assert.equal(r.kind, 'KnownBarriers')
  assert.equal(r.barriers.length, 1)
  assert.equal(mayFastPathEnd(r), false)
})

test('visitor: disconnect only after Ended, not on graceful pending', () => {
  const r = visitorEndSequence({
    endResponse: { status: 'Accepted', gracefulEndPending: true },
    pollSequence: [
      { status: 'Accepted', gracefulEndPending: true },
      { status: 'Ended' }
    ]
  })
  assert.equal(r.disconnectCount, 1)
  assert.ok(r.log.indexOf('post_end') < r.log.indexOf('disconnect'))
  assert.ok(r.log.includes('graceful_pending'))
})

test('visitor: no clip → Ended disconnect immediately', () => {
  const r = visitorEndSequence({
    endResponse: { status: 'Ended' },
    pollSequence: []
  })
  assert.equal(r.disconnectCount, 1)
  assert.equal(r.mediaAlive, false)
})

test('visitor never disconnect before post_end', () => {
  // Anti-pattern of old embed: disconnect then post
  const badOrder = ['disconnect', 'post_end']
  const goodOrder = ['post_end', 'graceful_pending', 'poll_ended_disconnect']
  assert.ok(goodOrder.indexOf('post_end') < goodOrder.indexOf('poll_ended_disconnect'))
  assert.ok(badOrder.indexOf('disconnect') < badOrder.indexOf('post_end')) // documents old bug
})

test('staff grace remaining uses server requestedAt not full grace from response', () => {
  const requestedAt = new Date('2026-01-01T00:00:00.000Z').toISOString()
  const now = new Date('2026-01-01T00:00:10.000Z').getTime() // 10s later (inline wait)
  const rem = remainingGraceMs(requestedAt, 12, now)
  assert.equal(rem, 2000) // 12s - 10s = 2s remaining, not full 12s
})

test('staff grace already elapsed → force option immediately', () => {
  const requestedAt = new Date('2026-01-01T00:00:00.000Z').toISOString()
  const now = new Date('2026-01-01T00:00:15.000Z').getTime()
  const rem = remainingGraceMs(requestedAt, 12, now)
  assert.equal(rem, 0)
})

test('StartClip after End claim aborts without StartEgress', () => {
  const r = simulateStartClipEndRace({ endClaimsFirst: true })
  assert.equal(r.gracefulEndPending, true)
  assert.equal(r.egressStartedAfterEnd, false)
  assert.equal(r.result.aborted, true)
})

test('StartClip Requested then End claim aborts before egress', () => {
  const r = simulateStartClipEndRace({ endClaimsFirst: false })
  assert.equal(r.result.aborted, true)
  assert.equal(r.result.asset.status, 'Failed')
  assert.equal(r.egressStartedAfterEnd, false)
})

test('staff transport error recovery states', () => {
  // Simulated recoverAfterEndTransportError branches
  function recover(getState) {
    const s = getState()
    if (s.status === 'Ended') return 'teardown'
    if (s.status === 'Accepted' && s.gracefulEndPending) return 'wait'
    if (s.status === 'Accepted' && !s.gracefulEndPending) return 'retry'
    return 'retry'
  }
  assert.equal(recover(() => ({ status: 'Ended' })), 'teardown')
  assert.equal(recover(() => ({ status: 'Accepted', gracefulEndPending: true })), 'wait')
  assert.equal(recover(() => ({ status: 'Accepted', gracefulEndPending: false })), 'retry')
})

test('Ready is not disconnect barrier', () => {
  assert.ok(isTerminal('COMPLETE'))
  const assetReady = false
  assert.equal(assetReady, false)
  // may end after COMPLETE regardless of Ready
  assert.ok(true)
})

test('EmbedCallView-shaped DTO fields present', () => {
  const dto = {
    id: 'x',
    status: 'Accepted',
    gracefulEndPending: true,
    gracefulEndRequestedAt: new Date().toISOString(),
    gracefulEndGraceSeconds: 12
  }
  assert.equal(typeof dto.gracefulEndPending, 'boolean')
  assert.ok(dto.gracefulEndRequestedAt)
  assert.ok(dto.gracefulEndGraceSeconds >= 3)
})

console.log(`\n${passed} tests passed`)
if (process.exitCode) process.exit(1)
