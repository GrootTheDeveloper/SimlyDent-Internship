/**
 * @file domain/media/media-primitives.js
 * Shared media helpers for staff SPA and embed widget (logic parity).
 * Embed consumes the IIFE build at public/widget/media-primitives.js
 * (same algorithms; keep both in sync — @shared-pair).
 *
 * Rules:
 * - No Vue
 * - LiveKit client injected as parameter (CDN UMD or ESM import)
 * - Disconnected is NEVER business call end (caller decides)
 */

/** @param {unknown} value @returns {'audio'|'video'} */
export function normalizeMediaModeValue(value) {
  const v = String(value || '').toLowerCase()
  return v === 'audio' ? 'audio' : 'video'
}

export function defaultAudioConstraints() {
  return {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true
  }
}

/**
 * Progressive local track acquisition.
 * @param {any} LivekitClient window.LivekitClient or ESM namespace
 * @param {{ preferredMedia?: string, videoResolution?: object }} [opts]
 * @returns {Promise<{ tracks: any[], note: string, cameraAvailable: boolean, micAvailable: boolean }>}
 */
export async function acquireLocalTracks(LivekitClient, opts = {}) {
  const createLocalTracks = LivekitClient.createLocalTracks
  const videoRes =
    opts.videoResolution ||
    (LivekitClient.VideoPresets
      ? LivekitClient.VideoPresets.h720.resolution
      : { width: 1280, height: 720, frameRate: 30 })
  const wantAudioOnly = normalizeMediaModeValue(opts.preferredMedia) === 'audio'
  const audio = defaultAudioConstraints()

  let tracks = []
  let cameraAvailable = false
  let micAvailable = false
  let note = 'receive-only'

  if (wantAudioOnly) {
    try {
      tracks = await createLocalTracks({ audio, video: false })
      micAvailable = true
      note = 'audio-only'
      return { tracks, note, cameraAvailable, micAvailable }
    } catch (e) {
      console.warn('[media-primitives] preferred audio-only failed', e)
    }
  } else {
    try {
      tracks = await createLocalTracks({
        audio,
        video: { facingMode: 'user', resolution: videoRes }
      })
      micAvailable = true
      cameraAvailable = true
      note = 'av'
      return { tracks, note, cameraAvailable, micAvailable }
    } catch (e) {
      console.warn('[media-primitives] AV failed, trying audio-only', e)
    }
  }

  try {
    tracks = await createLocalTracks({ audio, video: false })
    micAvailable = true
    note = 'audio-only'
    return { tracks, note, cameraAvailable, micAvailable }
  } catch (e2) {
    console.warn('[media-primitives] audio-only failed', e2)
  }

  return { tracks: [], note: 'receive-only', cameraAvailable: false, micAvailable: false }
}

/**
 * Attach remote track to DOM (video host element or hidden audio).
 * @param {any} LivekitClient
 * @param {any} track
 * @param {{ remoteVideoEl?: HTMLVideoElement|null, onAudioBlocked?: () => void }} [opts]
 */
export function attachRemoteTrack(LivekitClient, track, opts = {}) {
  if (!track) return null
  const kind = track.kind
  const Track = LivekitClient.Track
  const isVideo =
    kind === 'video' || (Track && kind === Track.Kind.Video)

  if (isVideo) {
    const host = opts.remoteVideoEl
    if (host) {
      try {
        track.attach(host)
      } catch (e) {
        console.warn('[media-primitives] attach video failed', e)
      }
    }
    return host || null
  }

  const audioEl = track.attach()
  audioEl.autoplay = true
  audioEl.muted = false
  audioEl.volume = 1
  audioEl.setAttribute('playsinline', '')
  audioEl.setAttribute('webkit-playsinline', '')
  audioEl.style.display = 'none'
  audioEl.setAttribute('data-lk-remote', '1')
  try {
    document.querySelectorAll('audio[data-lk-remote="1"]').forEach((n) => {
      if (n !== audioEl) n.remove()
    })
  } catch { /* ignore */ }
  document.body.appendChild(audioEl)
  audioEl.play().catch(() => {
    if (typeof opts.onAudioBlocked === 'function') opts.onAudioBlocked()
  })
  return audioEl
}

/**
 * Publish local tracks with Microphone/Camera sources when available.
 * @param {any} room
 * @param {any[]} tracks
 * @param {any} LivekitClient
 */
export async function publishLocalTracksWithSources(room, tracks, LivekitClient) {
  if (!room?.localParticipant || !tracks?.length) return
  const Track = LivekitClient.Track
  const TrackSource = Track && Track.Source
  for (const t of tracks) {
    let pubOpts
    if (TrackSource) {
      if (t.kind === 'audio' || (Track && t.kind === Track.Kind.Audio)) {
        pubOpts = { source: TrackSource.Microphone }
      } else if (t.kind === 'video' || (Track && t.kind === Track.Kind.Video)) {
        pubOpts = { source: TrackSource.Camera }
      }
    }
    try {
      await room.localParticipant.publishTrack(t, pubOpts)
    } catch (e) {
      console.warn('[media-primitives] publish failed', t?.kind, e)
    }
  }
}

/**
 * Subscribe + attach existing remote publications (after connect).
 */
export function attachExistingRemoteTracks(room, LivekitClient, attachOpts) {
  if (!room) return
  try {
    room.remoteParticipants.forEach((p) => {
      p.trackPublications.forEach((pub) => {
        try {
          pub.setSubscribed(true)
        } catch { /* ignore */ }
        if (pub.track) attachRemoteTrack(LivekitClient, pub.track, attachOpts)
      })
    })
  } catch (e) {
    console.warn('[media-primitives] attach existing remotes failed', e)
  }
}

/**
 * Safari autoplay unlock after user gesture / join click.
 * @returns {Promise<boolean>} canPlaybackAudio
 */
export async function unlockRemoteAudio(room) {
  if (!room) return false
  try {
    await room.startAudio()
  } catch { /* ignore */ }
  try {
    document.querySelectorAll('audio').forEach((el) => {
      try {
        el.muted = false
        el.volume = 1
        el.play().catch(() => {})
      } catch { /* ignore */ }
    })
  } catch { /* ignore */ }
  return !!room.canPlaybackAudio
}

/**
 * One-time (or repeated) click on container to unlock audio.
 */
export function bindTapToUnlockAudio(containerEl, room, onUnlocked) {
  if (!containerEl || containerEl._sdAudioUnlockBound) return
  containerEl._sdAudioUnlockBound = true
  containerEl.addEventListener(
    'click',
    function () {
      unlockRemoteAudio(room).then((ok) => {
        if (ok && typeof onUnlocked === 'function') onUnlocked()
      })
    },
    { passive: true }
  )
}