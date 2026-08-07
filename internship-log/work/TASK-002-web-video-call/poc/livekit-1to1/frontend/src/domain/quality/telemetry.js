/**
 * @file domain/quality/telemetry.js
 * @description Extracts and normalizes WebRTC stats for quality telemetry reporting.
 *
 * Ownership: domain/quality
 * Dependencies: None (browser standard RTCStatsReport only)
 *
 * Rules:
 * - No Vue dependencies
 * - No LiveKit SDK specific objects except standard tracks
 * - Functions are pure or state-contained (using a previous state object)
 *
 * @module telemetry
 */

/**
 * Calculate the delta between the current and previous value for a cumulative metric.
 *
 * @param {object} previous  The state object holding previous values
 * @param {string} key       The metric key
 * @param {number} current   The current metric value
 * @returns {number|null}
 */
export function cumulativeDelta(previous, key, current) {
  if (!Number.isFinite(current)) return null
  const oldValue = previous[key]
  previous[key] = current
  return Number.isFinite(oldValue) && current >= oldValue ? current - oldValue : 0
}

/**
 * Safely parse a finite number, returning null for non-finite values.
 *
 * @param {any} val
 * @returns {number|null}
 */
function finiteOrNull(val) {
  return Number.isFinite(val) ? val : null
}

/**
 * Extract ICE connection stats from an RTCStatsReport.
 *
 * @param {Map} report RTCStatsReport Map
 * @returns {object|null}
 */
export function readConnectionStats(report) {
  let transport = null
  let selectedPair = null
  report.forEach(stat => {
    if (stat.type === 'transport' && stat.selectedCandidatePairId) transport = stat
    if (stat.type === 'candidate-pair' && stat.state === 'succeeded' && stat.nominated) selectedPair = stat
  })
  if (transport?.selectedCandidatePairId) {
    selectedPair = report.get(transport.selectedCandidatePairId) || selectedPair
  }
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

/**
 * Extract detailed video track stats (bitrate, loss, jitter, fps) from an RTCStatsReport.
 * Statefully tracks deltas using the `previous` object.
 *
 * @param {object} track      LiveKit Track or standard MediaStreamTrack
 * @param {string} direction  'inbound' or 'outbound'
 * @param {object} previous   State object across calls
 * @returns {Promise<object|null>}
 */
export async function readTrackStats(track, direction, previous) {
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

/**
 * Clean up stats payload for the backend telemetry endpoint.
 *
 * @param {object} stats
 * @returns {object|null}
 */
export function toTelemetryVideoStats(stats) {
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

/**
 * Capture static environment information (network type, device specs) for telemetry.
 *
 * @param {object} localVideoTrack
 * @returns {object}
 */
export function clientEnvironment(localVideoTrack) {
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
