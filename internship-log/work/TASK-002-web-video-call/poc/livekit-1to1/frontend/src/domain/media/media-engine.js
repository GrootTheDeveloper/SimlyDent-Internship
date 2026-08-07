/**
 * @file domain/media/media-engine.js
 * @description Browser-side media lifecycle engine for a LiveKit call session.
 *
 * Ownership: domain/media
 * Dependencies: domain/media/livekit-adapter.js, livekit-client (via adapter)
 *
 * Rules:
 * - No Vue imports (framework-agnostic)
 * - No business call lifecycle (no CallStatus, no hangup logic)
 * - A MediaEngine.Disconnected event is NOT a business call end
 * - UI reads engine state; engine does NOT read Vue reactive data
 * - One engine per active call window; destroy on intentional leave
 *
 * Usage:
 *   const engine = createMediaEngine({ onEvent: (ev) => { ... } })
 *   await engine.connect(url, token, { audioOnly: false, portraitHint: false })
 *   await engine.ensureCameraEnabled(true)
 *   engine.destroy()
 *
 * @module media-engine
 */

import {
  createRoom,
  acquireLocalTracks,
  connectRoom,
  publishLocalTracks,
  subscribeAvailableRemoteTracks,
  attachTrackElement,
  startRoomAudio,
  replayAllAudioElements,
  readLocalMediaState,
  setCameraEnabled,
  setMicrophoneEnabled,
  resolveRemoteParticipantIdentity,
  resolveRemoteVideoTrackSid,
  formatCameraError,
  VideoPresets
} from './livekit-adapter.js'
import { RoomEvent, Track } from './livekit-adapter.js'
import { isPortraitCapturePreferred, preferredSimulcastLayers } from './media-utils.js'

// ---------------------------------------------------------------------------
// Event types emitted by MediaEngine
// ---------------------------------------------------------------------------

/** @enum {string} */
export const MediaEngineEvent = Object.freeze({
  /** Media successfully connected to LiveKit room. */
  Connected: 'Connected',
  /** Media reconnection in progress (network blip). NOT a business call end. */
  Reconnecting: 'Reconnecting',
  /** Media reconnection succeeded. */
  Reconnected: 'Reconnected',
  /**
   * Media permanently disconnected.
   * CRITICAL: This is NOT a business call end.
   * The call window must check intentionalLeave / business call status separately.
   */
  Disconnected: 'Disconnected',
  /** A remote track was subscribed and attached to a DOM element. */
  RemoteTrackAttached: 'RemoteTrackAttached',
  /** A remote track was unsubscribed and detached. */
  RemoteTrackDetached: 'RemoteTrackDetached',
  /** A local track was published. */
  LocalTrackPublished: 'LocalTrackPublished',
  /** A local track was unpublished. */
  LocalTrackUnpublished: 'LocalTrackUnpublished',
  /** Local camera/mic state changed — read getLocalMediaState() after this. */
  LocalMediaStateChanged: 'LocalMediaStateChanged',
  /** Remote video track was muted (camera off on far side). */
  RemoteVideoMuted: 'RemoteVideoMuted',
  /** Remote video track was unmuted (camera on on far side). */
  RemoteVideoUnmuted: 'RemoteVideoUnmuted',
  /** Browser audio autoplay is blocked — show tap-to-unmute UI. */
  AudioPlaybackBlocked: 'AudioPlaybackBlocked',
  /** Browser audio autoplay is now allowed. */
  AudioPlaybackAllowed: 'AudioPlaybackAllowed',
  /** A data message was received from a remote participant. */
  DataReceived: 'DataReceived',
  /** Connection error occurred (join failed). */
  Error: 'Error',
})

// ---------------------------------------------------------------------------
// Connection state enum
// ---------------------------------------------------------------------------

/** @enum {string} */
export const MediaConnectionState = Object.freeze({
  Idle: 'idle',
  Joining: 'joining',
  Connected: 'connected',
  Reconnecting: 'reconnecting',
  Disconnected: 'disconnected',
  Error: 'error',
})

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a new MediaEngine instance.
 *
 * @param {{ onEvent?: (type: string, payload?: any) => void }} [opts={}]
 * @returns {MediaEngine}
 */
export function createMediaEngine(opts = {}) {
  return new MediaEngine(opts)
}

// ---------------------------------------------------------------------------
// MediaEngine class
// ---------------------------------------------------------------------------

class MediaEngine {
  constructor({ onEvent } = {}) {
    /** @type {(type: string, payload?: any) => void} */
    this._emit = typeof onEvent === 'function' ? onEvent : () => {}
    /** @type {import('livekit-client').Room|null} */
    this.room = null
    /** @type {object[]} */
    this._localTracks = []
    /** @type {Function|null} */
    this._localMediaCleanup = null
    /** @type {MediaConnectionState} */
    this.connectionState = MediaConnectionState.Idle
    /** @type {boolean} */
    this._cameraToggleBusy = false
  }

  // ---------------------------------------------------------------------------
  // Connection
  // ---------------------------------------------------------------------------

  /**
   * Connect to a LiveKit room.
   * Acquires local media, creates room, registers events, connects, publishes.
   *
   * @param {string} url     LiveKit server URL
   * @param {string} token   LiveKit participant token
   * @param {{ audioOnly?: boolean }} [opts={}]
   * @returns {Promise<void>}
   */
  async connect(url, token, opts = {}) {
    if (this.room || this.connectionState === MediaConnectionState.Joining) {
      console.warn('[media-engine] connect() called while already connected/joining')
      return
    }

    this.connectionState = MediaConnectionState.Joining
    this._localTracks = []

    try {
      const portraitHint = isPortraitCapturePreferred()
      const simulcastLayers = preferredSimulcastLayers()

      // Acquire local media (progressive fallback; may be audio-only if cam fails)
      const {
        tracks,
        cameraAvailable,
        micAvailable,
        note,
        lastError
      } = await acquireLocalTracks({
        audioOnly: opts.audioOnly ?? false,
        captureResolution: VideoPresets.h720.resolution
      })

      // Apply portrait orientation normalization if needed
      let preparedTracks = tracks
      let cleanup = null
      if (!opts.audioOnly && cameraAvailable) {
        try {
          const { prepareLocalTracksForOrientation } = await import('./media-utils.js')
          const prepared = await prepareLocalTracksForOrientation(tracks)
          preparedTracks = prepared.tracks
          cleanup = prepared.cleanup
        } catch (e) {
          console.warn('[media-engine] portrait normalization failed, using raw tracks:', e)
        }
      }

      this._localTracks = preparedTracks
      if (typeof this._localMediaCleanup === 'function') this._localMediaCleanup()
      this._localMediaCleanup = cleanup

      this._emit(MediaEngineEvent.LocalMediaStateChanged, {
        cameraAvailable,
        micAvailable,
        note: note || (cameraAvailable ? 'av' : micAvailable ? 'audio-only' : 'receive-only'),
        lastError: lastError || '',
        tracks: preparedTracks
      })

      // Create room and attach events
      const room = createRoom({ portraitPublish: portraitHint, simulcastLayers })
      this._attachRoomEvents(room)

      // Connect
      await connectRoom(room, url, token)
      this.room = room

      // Subscribe existing remote tracks
      subscribeAvailableRemoteTracks(room)

      // Publish local tracks
      await publishLocalTracks(room, preparedTracks)
      this._emit(MediaEngineEvent.LocalMediaStateChanged, this.getLocalMediaState())

      // Unlock remote audio (Safari autoplay)
      const canPlay = await startRoomAudio(room)
      if (!canPlay) {
        this._emit(MediaEngineEvent.AudioPlaybackBlocked)
      } else {
        this._emit(MediaEngineEvent.AudioPlaybackAllowed)
      }

      this.connectionState = MediaConnectionState.Connected
      this._emit(MediaEngineEvent.Connected)
    } catch (err) {
      if (this.room) {
        await this.room.disconnect().catch(() => {})
        this.room = null
      }
      this._cleanupLocalMedia()
      this.connectionState = MediaConnectionState.Error
      this._emit(MediaEngineEvent.Error, err)
      throw err
    }
  }

  /**
   * Cleanly disconnect from the room.
   * Call this ONLY for intentional media disconnect (not to signal business hangup).
   *
   * @returns {Promise<void>}
   */
  async disconnectMedia() {
    if (this.room) {
      try {
        await this.room.disconnect()
      } catch (e) {
        console.warn('[media-engine] disconnect error', e)
      }
      this.room = null
    }
    this._cleanupLocalMedia()
    this.connectionState = MediaConnectionState.Idle
  }

  /**
   * Destroy the engine — stop all local tracks, disconnect if connected.
   * Call when the call window is being torn down.
   *
   * @returns {Promise<void>}
   */
  async destroy() {
    await this.disconnectMedia()
  }

  // ---------------------------------------------------------------------------
  // Media control
  // ---------------------------------------------------------------------------

  /**
   * Ensure camera is in the desired enabled/disabled state.
   * Operates on LiveKit LocalParticipant, then reconciles UI state.
   * NEVER flips a boolean optimistically before the operation completes.
   *
   * @param {boolean} wantEnabled
   * @returns {Promise<boolean>} actual camera state after operation
   */
  async ensureCameraEnabled(wantEnabled) {
    if (!this.room?.localParticipant) return false
    if (this._cameraToggleBusy) return this.getLocalMediaState().cameraEnabled

    this._cameraToggleBusy = true
    try {
      const { cameraEnabled: before } = this.getLocalMediaState()
      if (before === !!wantEnabled) {
        return before
      }

      await setCameraEnabled(this.room, !!wantEnabled)
      const state = this.getLocalMediaState()
      this._emit(MediaEngineEvent.LocalMediaStateChanged, state)
      return state.cameraEnabled
    } catch (e) {
      console.warn('[media-engine] ensureCameraEnabled failed', e)
      const state = this.getLocalMediaState()
      this._emit(MediaEngineEvent.LocalMediaStateChanged, state)
      const err = new Error(formatCameraError(e))
      err.cause = e
      throw err
    } finally {
      this._cameraToggleBusy = false
    }
  }

  /**
   * Toggle microphone.
   *
   * @param {boolean} [wantEnabled]  If omitted, toggles current state
   * @returns {Promise<boolean>} actual mic state after operation
   */
  async ensureMicrophoneEnabled(wantEnabled) {
    if (!this.room?.localParticipant) return false
    const current = this.getLocalMediaState().micEnabled
    const target = wantEnabled !== undefined ? wantEnabled : !current
    try {
      await setMicrophoneEnabled(this.room, target)
      const state = this.getLocalMediaState()
      this._emit(MediaEngineEvent.LocalMediaStateChanged, state)
      return state.micEnabled
    } catch (e) {
      console.warn('[media-engine] ensureMicrophoneEnabled failed', e)
      const state = this.getLocalMediaState()
      this._emit(MediaEngineEvent.LocalMediaStateChanged, state)
      throw e
    }
  }

  /**
   * Attempt to unlock remote audio playback (call after user gesture).
   * @returns {Promise<void>}
   */
  async unlockAudioPlayback() {
    if (this.room) {
      const canPlay = await startRoomAudio(this.room)
      if (canPlay) {
        this._emit(MediaEngineEvent.AudioPlaybackAllowed)
      } else {
        this._emit(MediaEngineEvent.AudioPlaybackBlocked)
      }
    }
    replayAllAudioElements()
  }

  // ---------------------------------------------------------------------------
  // State readers
  // ---------------------------------------------------------------------------

  /**
   * Read actual camera/mic state from LiveKit publications.
   * This is the authoritative source — not Vue reactive flags.
   *
   * @returns {{ cameraEnabled: boolean, micEnabled: boolean }}
   */
  getLocalMediaState() {
    return readLocalMediaState(this.room)
  }

  /**
   * Resolve the remote participant identity most likely belonging to the patient.
   *
   * @param {{ peerId?: string, clinicId?: string }} hints
   * @returns {string|null}
   */
  resolveRemoteParticipantIdentity(hints = {}) {
    return resolveRemoteParticipantIdentity(this.room, hints)
  }

  /**
   * Resolve the remote patient camera track SID.
   *
   * @returns {string|null}
   */
  resolveRemoteVideoTrackSid() {
    return resolveRemoteVideoTrackSid(this.room)
  }

  // ---------------------------------------------------------------------------
  // Internal — Room event attachment
  // ---------------------------------------------------------------------------

  _attachRoomEvents(room) {
    room.on(RoomEvent.TrackSubscribed, (track) => {
      const element = attachTrackElement(track)
      this._emit(MediaEngineEvent.RemoteTrackAttached, { track, element })
    })

    room.on(RoomEvent.TrackPublished, (publication) => {
      publication.setSubscribed(true)
    })

    room.on(RoomEvent.TrackSubscriptionFailed, () => {
      this._emit(MediaEngineEvent.RemoteVideoMuted)
    })

    room.on(RoomEvent.TrackUnsubscribed, (track) => {
      track.detach().forEach(node => node.remove())
      if (track.kind === Track.Kind.Video) {
        this._emit(MediaEngineEvent.RemoteVideoMuted)
      }
      this._emit(MediaEngineEvent.RemoteTrackDetached, { track })
    })

    room.on(RoomEvent.TrackMuted, (publication, participant) => {
      if (participant?.isLocal) {
        this._emit(MediaEngineEvent.LocalMediaStateChanged, this.getLocalMediaState())
        return
      }
      if (publication?.kind === Track.Kind.Video || publication?.track?.kind === Track.Kind.Video) {
        this._emit(MediaEngineEvent.RemoteVideoMuted)
      }
    })

    room.on(RoomEvent.TrackUnmuted, (publication, participant) => {
      if (participant?.isLocal) {
        this._emit(MediaEngineEvent.LocalMediaStateChanged, this.getLocalMediaState())
        return
      }
      if (publication?.kind === Track.Kind.Video || publication?.track?.kind === Track.Kind.Video) {
        if (publication.track) {
          const element = attachTrackElement(publication.track)
          this._emit(MediaEngineEvent.RemoteVideoUnmuted, { track: publication.track, element })
        } else {
          this._emit(MediaEngineEvent.RemoteVideoUnmuted, { track: null, element: null })
        }
      }
    })

    room.on(RoomEvent.LocalTrackPublished, (publication) => {
      this._emit(MediaEngineEvent.LocalTrackPublished, { publication })
      this._emit(MediaEngineEvent.LocalMediaStateChanged, this.getLocalMediaState())
    })

    room.on(RoomEvent.LocalTrackUnpublished, (publication) => {
      this._emit(MediaEngineEvent.LocalTrackUnpublished, { publication })
      this._emit(MediaEngineEvent.LocalMediaStateChanged, this.getLocalMediaState())
    })

    room.on(RoomEvent.AudioPlaybackStatusChanged, () => {
      if (room.canPlaybackAudio) {
        this._emit(MediaEngineEvent.AudioPlaybackAllowed)
      } else {
        this._emit(MediaEngineEvent.AudioPlaybackBlocked)
      }
    })

    // CRITICAL INVARIANT: Reconnecting/Reconnected/Disconnected are MEDIA events.
    // They are NOT business call lifecycle events.
    // The business call remains alive across WebRTC reconnection events.
    room.on(RoomEvent.Reconnecting, () => {
      this.connectionState = MediaConnectionState.Reconnecting
      this._emit(MediaEngineEvent.Reconnecting)
    })

    room.on(RoomEvent.Reconnected, () => {
      this.connectionState = MediaConnectionState.Connected
      subscribeAvailableRemoteTracks(room)
      this._emit(MediaEngineEvent.LocalMediaStateChanged, this.getLocalMediaState())
      this._emit(MediaEngineEvent.Reconnected)
    })

    room.on(RoomEvent.Disconnected, (reason) => {
      const reasonStr = reason != null ? String(reason) : 'unknown'
      this.connectionState = MediaConnectionState.Disconnected
      // NOTE: Engine emits Disconnected — the CALLER decides if this ends the business call.
      // Engine has no knowledge of intentionalLeave or business call status.
      this._emit(MediaEngineEvent.Disconnected, { reason: reasonStr })
    })

    room.on(RoomEvent.DataReceived, (payload, participant, kind) => {
      this._emit(MediaEngineEvent.DataReceived, { payload, participant, kind })
    })

    room.on(RoomEvent.ParticipantConnected, (p) => {
      // Forward — callers may log or update UI
    })

    room.on(RoomEvent.ParticipantDisconnected, (p) => {
      // Forward — callers may log or update UI
    })
  }

  _cleanupLocalMedia() {
    if (typeof this._localMediaCleanup === 'function') {
      this._localMediaCleanup()
      this._localMediaCleanup = null
    }
    this._localTracks.forEach(t => { try { t.stop() } catch { /* ignore */ } })
    this._localTracks = []
  }
}
