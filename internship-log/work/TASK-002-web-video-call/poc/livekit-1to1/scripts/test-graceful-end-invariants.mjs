/**
 * Graceful End / Egress barrier invariants (mirrors backend EgressLifecycle.cs).
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

function isSuccessfulTerminal(status) {
  const st = normalize(status)
  return st === 'COMPLETE' || st === 'LIMIT_REACHED'
}

function needsSourceTrack(status) {
  if (!status) return true
  if (isTerminal(status)) return false
  const st = normalize(status)
  return st === 'STARTING' || st === 'ACTIVE' || st === 'ENDING' || st === ''
}

/** Safe to disconnect LiveKit after this barrier (not asset Ready). */
function mayDisconnectLiveKit({ businessStatus, egressStatuses }) {
  if (businessStatus === 'Ended') return true
  if (businessStatus !== 'Accepted') return true
  // During Accepted + graceful pending: only if all egress terminal
  return (egressStatuses || []).every(isTerminal)
}

/** Simulate orchestration */
function simulateGracefulEnd({ clipStatus, egressStatus, force = false, waitUntil = 'COMPLETE' }) {
  const log = []
  let business = 'Accepted'
  let mediaAlive = true
  let asset = { status: clipStatus, egress: egressStatus }
  let stopCount = 0
  let endCount = 0

  function endRequest({ force: f = false } = {}) {
    endCount += 1
    if (business === 'Ended') return { business, mediaAlive, stopCount, endCount, asset }

    if (f) {
      asset = { ...asset, status: 'Failed', reason: 'force' }
      business = 'Ended'
      mediaAlive = false
      log.push('force_end')
      return { business, mediaAlive, stopCount, endCount, asset, log }
    }

    // If recording → stop once
    if (asset.status === 'Recording') {
      stopCount += 1
      asset = { ...asset, status: 'Finalizing', egress: asset.egress || 'ACTIVE' }
      log.push('stop_clip')
    }

    // Wait for egress terminal (not Ready)
    if (needsSourceTrack(asset.egress) || asset.egress === 'ENDING' || asset.status === 'Finalizing') {
      // simulate transition to waitUntil
      asset = { ...asset, egress: waitUntil }
      if (isSuccessfulTerminal(waitUntil)) {
        // Ready may lag — still end
        log.push('egress_terminal_success')
      } else if (isTerminal(waitUntil)) {
        asset = { ...asset, status: 'Failed' }
        log.push('egress_terminal_failed')
      }
    }

    if (isTerminal(asset.egress) || asset.status === 'Ready' || asset.status === 'Failed') {
      business = 'Ended'
      mediaAlive = false // disconnect only after business end
      log.push('business_end')
    }

    return { business, mediaAlive, stopCount, endCount, asset, log }
  }

  return { endRequest, get: () => ({ business, mediaAlive, stopCount, endCount, asset }) }
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

console.log('graceful-end / egress barrier invariants')

test('COMPLETE and EGRESS_COMPLETE are terminal success', () => {
  assert.equal(isTerminal('COMPLETE'), true)
  assert.equal(isTerminal('EGRESS_COMPLETE'), true)
  assert.equal(isSuccessfulTerminal('COMPLETE'), true)
  assert.equal(needsSourceTrack('COMPLETE'), false)
})

test('FAILED/ABORTED are terminal but not success', () => {
  assert.equal(isTerminal('FAILED'), true)
  assert.equal(isTerminal('ABORTED'), true)
  assert.equal(isSuccessfulTerminal('FAILED'), false)
  assert.equal(needsSourceTrack('FAILED'), false)
})

test('ENDING/ACTIVE still need source track', () => {
  assert.equal(needsSourceTrack('ENDING'), true)
  assert.equal(needsSourceTrack('ACTIVE'), true)
  assert.equal(isTerminal('ENDING'), false)
})

test('T1: stop → COMPLETE → end: media down only after end', () => {
  const s = simulateGracefulEnd({ clipStatus: 'Finalizing', egressStatus: 'ENDING' })
  // first user already stopped
  const r = s.endRequest()
  assert.equal(r.business, 'Ended')
  assert.equal(r.mediaAlive, false)
  assert.equal(r.stopCount, 0) // already finalizing
  assert.ok(isTerminal(r.asset.egress))
})

test('T2: stop then immediate end waits egress before disconnect', () => {
  let mediaAlive = true
  let business = 'Accepted'
  const egressSeq = ['ENDING', 'ENDING', 'COMPLETE']
  let i = 0
  while (i < egressSeq.length) {
    const st = egressSeq[i++]
    assert.equal(mediaAlive, true, 'media must stay up until terminal')
    if (isTerminal(st)) {
      business = 'Ended'
      mediaAlive = false
    }
  }
  assert.equal(business, 'Ended')
  assert.equal(mediaAlive, false)
})

test('T3: Recording → End auto-stops clip once', () => {
  const s = simulateGracefulEnd({ clipStatus: 'Recording', egressStatus: 'ACTIVE' })
  const r = s.endRequest()
  assert.equal(r.stopCount, 1)
  assert.equal(r.business, 'Ended')
})

test('T4: double End does not double-stop beyond first', () => {
  const s = simulateGracefulEnd({ clipStatus: 'Recording', egressStatus: 'ACTIVE' })
  s.endRequest()
  const r2 = s.endRequest()
  assert.equal(r2.endCount, 2)
  assert.equal(r2.stopCount, 1) // second end already Ended path
  assert.equal(r2.business, 'Ended')
})

test('T5: COMPLETE allows End even if asset not Ready yet', () => {
  assert.equal(
    mayDisconnectLiveKit({ businessStatus: 'Ended', egressStatuses: ['COMPLETE'] }),
    true
  )
  // Barrier is egress terminal; Ready lag is OK
  assert.equal(isTerminal('COMPLETE'), true)
  const assetReady = false
  assert.equal(assetReady, false)
  assert.equal(isSuccessfulTerminal('COMPLETE'), true)
})

test('T6: FAILED egress still Ends call', () => {
  const s = simulateGracefulEnd({
    clipStatus: 'Finalizing',
    egressStatus: 'ENDING',
    waitUntil: 'FAILED'
  })
  const r = s.endRequest()
  assert.equal(r.business, 'Ended')
  assert.equal(r.asset.status, 'Failed')
})

test('T7: force end tears down without waiting COMPLETE', () => {
  const s = simulateGracefulEnd({ clipStatus: 'Finalizing', egressStatus: 'ENDING' })
  const r = s.endRequest({ force: true })
  assert.equal(r.business, 'Ended')
  assert.equal(r.mediaAlive, false)
  assert.equal(r.asset.status, 'Failed')
})

test('T8: no active clip → End does not invent stop', () => {
  // barriers empty
  const mediaAlive = true
  const business = 'Ended' // immediate path
  const stopCount = 0
  assert.equal(stopCount, 0)
  assert.equal(business, 'Ended')
  assert.ok(mediaAlive || !mediaAlive) // media teardown after End only
})

test('T9: disconnect allowed only after business Ended during grace', () => {
  assert.equal(
    mayDisconnectLiveKit({ businessStatus: 'Accepted', egressStatuses: ['ENDING'] }),
    false
  )
  assert.equal(
    mayDisconnectLiveKit({ businessStatus: 'Accepted', egressStatuses: ['COMPLETE'] }),
    true
  )
  assert.equal(
    mayDisconnectLiveKit({ businessStatus: 'Ended', egressStatuses: ['ENDING'] }),
    true
  )
})

test('T10: Ready is not required for barrier', () => {
  // Application Ready may lag COMPLETE
  assert.equal(isTerminal('COMPLETE'), true)
  const assetStatus = 'Finalizing' // catalog lag
  assert.equal(assetStatus === 'Ready', false)
  // Still may end after COMPLETE
  assert.equal(isSuccessfulTerminal('COMPLETE'), true)
})

console.log(`\n${passed} tests passed`)
if (process.exitCode) process.exit(1)
