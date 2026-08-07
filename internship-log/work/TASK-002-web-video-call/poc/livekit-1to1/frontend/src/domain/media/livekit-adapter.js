/**
 * @file domain/media/livekit-adapter.js
 * @description Thin adapter around the LiveKit JS SDK.
 *
 * Ownership: domain/media — LiveKit SDK-specific only
 * Dependencies: livekit-client SDK
 *
 * Rules:
 * - Contains ONLY LiveKit SDK calls and event forwarding
 * - No Vue dependencies
 * - No business logic (call status, consultation logic)
 * - No direct DOM manipulation beyond track.attach()
 * - Does NOT decide whether a Disconnected event ends a business call
 * - The adapter emits raw LiveKit events — consumers decide business meaning
 *
 * @module livekit-adapter
 */

import {
  createLocalTracks,
  Room,
  RoomEvent,
  Track,
  VideoPreset,
  VideoPresets
} from 'livekit-client'

export { RoomEvent, Track, VideoPreset, VideoPresets }

/**
 * Create a LiveKit Room instance with standard SimlyDent configuration.
 * Does not connect — call adapter.connect() next.
 *
 * @param {{ portraitPublish?: boolean, simulcastLayers?: VideoPreset[] }} [opts={}]
 * @returns {Room}
 */
export function createRoom(opts = {}) {
  const portraitPublish = opts.portraitPublish ?? false
  const simulcastLayers = opts.simulcastLayers ?? [VideoPresets.h540, VideoPresets.h216]
  return new Room({
    adaptiveStream: true,
    dynacast: true,
    publishDefaults: {
      simulcast: !portraitPublish,
      videoCodec: 'vp8',
      videoSimulcastLayers: portraitPublish ? [] : simulcastLayers
    }
  })
}

/**
 * Acquire local tracks with progressive fallback:
 *   1. Try requested mode (audio+video or audio-only)
 *   2. Fall back to audio-only on video failure
 *   3. Fall back to no local tracks if audio also fails
 *
 * @param {{ audioOnly?: boolean, captureResolution?: object }} [opts={}]
 * @returns {Promise<{ tracks: object[], cameraAvailable: boolean, micAvailable: boolean }>}
 */
export async function acquireLocalTracks(opts = {}) {
  const { audioOnly = false, captureResolution = VideoPresets.h720.resolution } = opts

  const audioConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true
  }

  let tracks = []
  let cameraAvailable = false
  let micAvailable = false

  try {
    if (audioOnly) {
      tracks = await createLocalTracks({ audio: audioConstraints, video: false })
      micAvailable = true
    } else {
      tracks = await createLocalTracks({
        audio: audioConstraints,
        video: { facingMode: 'user', resolution: captureResolution }
      })
      micAvailable = true
      cameraAvailable = true
    }
  } catch (videoErr) {
    if (!audioOnly) {
      // Video failed — try audio only
      console.warn('[livekit-adapter] Video track failed, trying audio only:', videoErr)
      try {
        tracks = await createLocalTracks({ audio: audioConstraints, video: false })
        micAvailable = true
      } catch (audioErr) {
        // Audio also failed — join receive-only
        console.warn('[livekit-adapter] Audio also failed; joining without local tracks:', audioErr)
        tracks = []
      }
    }
  }

  return { tracks, cameraAvailable, micAvailable }
}

/**
 * Connect a Room to a LiveKit server.
 *
 * @param {Room} room
 * @param {string} url
 * @param {string} token
 * @param {{ websocketTimeout?: number, peerConnectionTimeout?: number }} [opts={}]
 * @returns {Promise<void>}
 */
export async function connectRoom(room, url, token, opts = {}) {
  await room.connect(url, token, {
    websocketTimeout: opts.websocketTimeout ?? 15000,
    peerConnectionTimeout: opts.peerConnectionTimeout ?? 15000
  })
}

/**
 * Publish local tracks to the connected room with correct source annotations.
 * Failures per track are logged but do not abort the loop (best-effort).
 *
 * @param {Room} room
 * @param {object[]} localTracks
 * @returns {Promise<void>}
 */
export async function publishLocalTracks(room, localTracks) {
  for (const track of localTracks) {
    const source = track.kind === Track.Kind.Audio
      ? Track.Source.Microphone
      : track.kind === Track.Kind.Video
        ? Track.Source.Camera
        : undefined
    try {
      await room.localParticipant.publishTrack(track, source ? { source } : undefined)
    } catch (pubErr) {
      console.warn('[livekit-adapter] publishTrack failed', track.kind, pubErr)
    }
  }
}

/**
 * Subscribe all available remote tracks in a room.
 * Call after connect to catch tracks that arrived before event listeners were attached.
 *
 * @param {Room} room
 * @returns {void}
 */
export function subscribeAvailableRemoteTracks(room) {
  if (!room) return
  for (const participant of room.remoteParticipants.values()) {
    for (const publication of participant.trackPublications.values()) {
      try { publication.setSubscribed(true) } catch { /* ignore */ }
    }
  }
}

/**
 * Attach a remote track to a DOM element and return it.
 * For video: returns a <video> element.
 * For audio: returns a hidden <audio> element ready for playback.
 *
 * @param {object} track  LiveKit Track
 * @returns {HTMLMediaElement}
 */
export function attachTrackElement(track) {
  const element = track.attach()
  element.autoplay = true
  element.setAttribute('playsinline', '')
  element.setAttribute('webkit-playsinline', '')
  if (track.kind === Track.Kind.Video) {
    element.muted = true
    element.playsInline = true
  } else {
    // Audio: never muted; must stay unmuted for Safari to route audio.
    element.muted = false
    element.volume = 1
  }
  return element
}

/**
 * Attempt to start remote audio playback (Safari autoplay policy).
 * Errors are swallowed — caller should update UI state from room.canPlaybackAudio.
 *
 * @param {Room} room
 * @returns {Promise<boolean>} true if audio can play back
 */
export async function startRoomAudio(room) {
  try {
    await room.startAudio()
    return room.canPlaybackAudio
  } catch {
    return false
  }
}

/**
 * Re-kick all <audio> elements in the document (Safari one-time user gesture unlock).
 * Call only in response to a user interaction event.
 *
 * @returns {void}
 */
export function replayAllAudioElements() {
  document.querySelectorAll('audio').forEach(el => {
    try {
      el.muted = false
      el.volume = 1
      el.play().catch(() => {})
    } catch { /* ignore */ }
  })
}

/**
 * Read camera publication state from LocalParticipant.
 * Returns { cameraEnabled, micEnabled } based on actual publication mute state,
 * not on Vue boolean flags.
 *
 * @param {Room} room
 * @returns {{ cameraEnabled: boolean, micEnabled: boolean }}
 */
export function readLocalMediaState(room) {
  if (!room?.localParticipant) return { cameraEnabled: false, micEnabled: false }

  // Camera
  const videoPubs = [...room.localParticipant.videoTrackPublications.values()]
  const camPub = videoPubs[0] || null
  const cameraEnabled = !!(camPub && !camPub.isMuted && camPub.track && !camPub.track.isMuted)

  // Microphone
  const audioPubs = [...room.localParticipant.audioTrackPublications.values()]
  const micPub = audioPubs[0] || null
  const micEnabled = !!(micPub && !micPub.isMuted && micPub.track && !micPub.track.isMuted)

  return { cameraEnabled, micEnabled }
}

/**
 * Set camera enabled/disabled on the local participant.
 * Returns the actual state after the operation.
 *
 * @param {Room} room
 * @param {boolean} wantEnabled
 * @returns {Promise<boolean>} actual camera state after operation
 */
export async function setCameraEnabled(room, wantEnabled) {
  if (!room?.localParticipant) return false
  await room.localParticipant.setCameraEnabled(!!wantEnabled)
  return readLocalMediaState(room).cameraEnabled
}

/**
 * Set microphone enabled/disabled on the local participant.
 * Returns the actual state after the operation.
 *
 * @param {Room} room
 * @param {boolean} wantEnabled
 * @returns {Promise<boolean>} actual mic state after operation
 */
export async function setMicrophoneEnabled(room, wantEnabled) {
  if (!room?.localParticipant) return false
  await room.localParticipant.setMicrophoneEnabled(!!wantEnabled)
  return readLocalMediaState(room).micEnabled
}

/**
 * Resolve the remote participant identity that most likely belongs to the patient.
 * Priority: participant with an active camera track > identity match > first remote.
 *
 * @param {Room} room
 * @param {{ peerId?: string, clinicId?: string }} hints
 * @returns {string|null}
 */
export function resolveRemoteParticipantIdentity(room, hints = {}) {
  if (!room) return null
  const { peerId = '', clinicId = '' } = hints

  // Prefer participant with camera track
  for (const p of room.remoteParticipants.values()) {
    const id = p.identity || ''
    const pubs = [...(p.videoTrackPublications?.values?.() || p.trackPublications?.values?.() || [])]
    const hasCam = pubs.some(pub =>
      pub?.source === Track.Source.Camera
      || pub?.kind === Track.Kind.Video
      || pub?.track?.kind === Track.Kind.Video)
    if (hasCam && id) return id
  }

  // Identity match
  for (const p of room.remoteParticipants.values()) {
    const id = p.identity || ''
    if (id === peerId || id.endsWith(':' + peerId) || (peerId && id.includes(peerId))) {
      return id
    }
  }

  // Convention: {clinicId}:{userId}
  if (clinicId && peerId) return `${clinicId}:${peerId}`

  // Last resort: first remote
  const first = [...room.remoteParticipants.values()][0]
  return first?.identity || peerId || null
}

/**
 * Resolve the camera track SID of the remote patient participant.
 *
 * @param {Room} room
 * @returns {string|null}
 */
export function resolveRemoteVideoTrackSid(room) {
  if (!room) return null
  for (const p of room.remoteParticipants.values()) {
    for (const pub of (p.videoTrackPublications?.values?.() || p.trackPublications?.values?.() || [])) {
      if (pub?.source === Track.Source.Camera || pub?.kind === Track.Kind.Video || pub?.track?.kind === Track.Kind.Video) {
        return pub.trackSid || pub.track?.sid || null
      }
    }
  }
  return null
}
