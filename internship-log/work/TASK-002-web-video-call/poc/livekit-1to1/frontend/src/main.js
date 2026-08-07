import Vue from 'vue/dist/vue.esm.js'
import * as signalR from '@microsoft/signalr'
import {
  LocalVideoTrack,
  Track,
  VideoPresets
} from 'livekit-client'
import './style.css'

// Phase 2 refactor: import media domain modules
import {
  isPortraitCapturePreferred,
  preferredVideoCaptureResolution,
  preferredSimulcastLayers,
  prepareLocalTracksForOrientation,
  applyVideoDisplayFit,
} from './domain/media/media-utils.js'
import {
  MediaEngineEvent,
  MediaConnectionState,
  createMediaEngine,
} from './domain/media/media-engine.js'
import {
  readLocalMediaState,
  resolveRemoteParticipantIdentity,
  resolveRemoteVideoTrackSid,
  attachTrackElement,
  startRoomAudio,
  replayAllAudioElements,
  subscribeAvailableRemoteTracks,
} from './domain/media/livekit-adapter.js'
import {
  readConnectionStats,
  readTrackStats,
  toTelemetryVideoStats,
  clientEnvironment
} from './domain/quality/telemetry.js'

// ---------------------------------------------------------------------------
// Phase 1 refactor: import from shared modules
// Canonical owners: shared/auth.js, shared/api-client.js, shared/call-helpers.js
// shared/constants.js, shared/storage-helpers.js
// ---------------------------------------------------------------------------
import {
  AUTH_TOKEN_KEY,
  AUTH_USER_KEY,
  DEMO_PASSWORD_HINT,
  SESSION_PREFERRED_MEDIA_KEY,
  API_URL,
  CallStatus,
  TERMINAL_CALL_STATUSES,
  MediaMode,
  HUB_PATH,
} from './shared/constants.js'
import {
  getAccessToken,
  setAuthSession,
  clearAuthSession,
  readCachedUser,
  authHeaders,
} from './shared/auth.js'
import { apiFetch } from './shared/api-client.js'
import {
  clinicIdOf,
  isEmbedVisitorId,
  visitorShortCode,
  peerLabel,
  peerAvatarText,
  initialsFromDisplayName,
  userInitials,
  isTerminalCallStatus,
  normalizeMediaMode,
  agentBadgeClass,
  agentBadgeLabel,
  callStatusVi,
  formatQueueLabel,
  queueStatusVi,
  clinicDisplayName,
  roleDisplayName,
  recordingModeLabel,
  recordingStatusLabelVi,
  formatViDateTime,
  formatWaitSeconds,
  finiteOrNull,
  createClientSessionId,
} from './shared/call-helpers.js'
import {
  readPreferredMediaHint,
  writePreferredMediaHint,
  clearPreferredMediaHint,
} from './shared/storage-helpers.js'

const GUEST_AVATAR_URL = '/assets/guest-avatar.svg'

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



// isPortraitCapturePreferred, preferredVideoCaptureResolution, preferredSimulcastLayers,
// prepareLocalTracksForOrientation, applyVideoDisplayFit are now in domain/media/media-utils.js

// cumulativeDelta is also telemetry-local below; readConnectionStats, readTrackStats below.





// Telemetry functions (cumulativeDelta, readConnectionStats, readTrackStats, toTelemetryVideoStats, clientEnvironment)
// are now imported from domain/quality/telemetry.js

/**
 * Download recording via catalog-backed download-url (presign or proxy).
 * Shared by call window + main portal (two separate Vue apps).
 */
async function fetchAndSaveRecording(callId) {
  const metaRes = await apiFetch(`/api/calls/${callId}/recording/download-url`, {
    headers: authHeaders()
  })
  if (!metaRes.ok) {
    const body = await metaRes.json().catch(() => ({}))
    throw new Error(body.error || `Không lấy được link tải (HTTP ${metaRes.status})`)
  }
  const meta = await metaRes.json()
  const mode = meta.mode || 'proxy'
  const fileName = `recording-${String(callId).replace(/-/g, '')}.mp4`

  if (mode === 'presign' && meta.url) {
    // Browser hits Object Storage directly — no Bearer on storage host.
    const link = document.createElement('a')
    link.href = meta.url
    link.download = fileName
    link.rel = 'noopener'
    document.body.appendChild(link)
    link.click()
    link.remove()
    return
  }

  // Proxy: authenticated stream through API.
  const path = meta.url || `/api/calls/${callId}/recording/file`
  const res = await apiFetch(path, { headers: authHeaders() })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || `Không tải được file (HTTP ${res.status})`)
  }
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

/** Download consultation media asset (audio / clip / photo) via Manager endpoint. */
async function fetchAndSaveMediaAsset(assetId, kindHint = '') {
  const metaRes = await apiFetch(`/api/media/${assetId}/download-url`, {
    headers: authHeaders()
  })
  if (!metaRes.ok) {
    const body = await metaRes.json().catch(() => ({}))
    throw new Error(body.error || `Không lấy được link media (HTTP ${metaRes.status})`)
  }
  const meta = await metaRes.json()
  const ext = kindHint === 'CallAudio' || meta.kind === 'CallAudio'
    ? 'mp3'
    : (kindHint === 'Snapshot' || meta.kind === 'Snapshot' ? 'jpg' : 'mp4')
  const fileName = `media-${String(assetId).replace(/-/g, '')}.${ext}`

  if ((meta.mode || '') === 'presign' && meta.url) {
    const link = document.createElement('a')
    link.href = meta.url
    link.download = fileName
    link.rel = 'noopener'
    document.body.appendChild(link)
    link.click()
    link.remove()
    return
  }

  const path = meta.url || `/api/media/${assetId}/file`
  const res = await apiFetch(path, { headers: authHeaders() })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || `Không tải được media (HTTP ${res.status})`)
  }
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

/**
 * Patient-side: capture photo from local camera and PUT to presigned URL.
 * Invoked when RoomEvent.DataReceived carries type=capture_photo.
 */
async function captureLocalPhotoBlob(room) {
  const localVideoTrack = room?.localParticipant
    ?.getTrackPublication?.(Track.Source.Camera)?.track
    || room?.localParticipant
      ?.getTrackPublication?.(Track.Source.Camera)?.videoTrack
  const mst = localVideoTrack?.mediaStreamTrack
  if (!mst) {
    throw new Error('No local camera track for photo capture')
  }

  const settings = mst.getSettings?.() || {}
  let blob = null
  let actualWidth = settings.width || null
  let actualHeight = settings.height || null

  if (typeof ImageCapture !== 'undefined') {
    try {
      const capture = new ImageCapture(mst)
      const photoBlob = await capture.takePhoto()
      if (photoBlob instanceof Blob) blob = photoBlob
    } catch (e) {
      console.warn('ImageCapture.takePhoto failed, canvas fallback', e)
    }
  }

  if (!blob) {
    const canvas = document.createElement('canvas')
    canvas.width = settings.width || 1280
    canvas.height = settings.height || 720
    actualWidth = canvas.width
    actualHeight = canvas.height
    const videoEl = document.createElement('video')
    videoEl.muted = true
    videoEl.playsInline = true
    videoEl.srcObject = new MediaStream([mst])
    await videoEl.play()
    await new Promise(r => setTimeout(r, 50))
    canvas.getContext('2d').drawImage(videoEl, 0, 0, canvas.width, canvas.height)
    videoEl.pause()
    videoEl.srcObject = null
    blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.95))
  }

  if (!blob) throw new Error('Không chụp được ảnh')
  return { blob, actualWidth, actualHeight }
}

async function handleCapturePhotoCommand(room, msg) {
  if (!msg?.assetId) return
  const { blob, actualWidth, actualHeight } = await captureLocalPhotoBlob(room)
  const mode = msg.uploadMode || (msg.uploadUrl ? 'presign' : 'api')

  if (mode === 'presign' && msg.uploadUrl) {
    const putRes = await fetch(msg.uploadUrl, {
      method: 'PUT',
      body: blob,
      headers: { 'Content-Type': 'image/jpeg' }
    })
    if (!putRes.ok) {
      throw new Error(`Upload ảnh thất bại HTTP ${putRes.status}`)
    }
    // Notify backend (retry up to 3 times)
    let lastErr = null
    for (let i = 0; i < 3; i++) {
      try {
        const res = await apiFetch(`/api/media/${msg.assetId}/upload-complete`, {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            actualWidth,
            actualHeight,
            bytes: blob.size
          })
        })
        if (res.ok || res.status === 202) return
        const body = await res.json().catch(() => ({}))
        lastErr = new Error(body.error || `upload-complete HTTP ${res.status}`)
        await new Promise(r => setTimeout(r, 800 * (i + 1)))
      } catch (e) {
        lastErr = e
        await new Promise(r => setTimeout(r, 800 * (i + 1)))
      }
    }
    if (lastErr) throw lastErr
    return
  }

  // Local / API path: POST bytes to backend (Bearer JWT)
  const path = msg.uploadPath || `/api/media/${msg.assetId}/upload`
  const q = new URLSearchParams()
  if (actualWidth) q.set('w', String(actualWidth))
  if (actualHeight) q.set('h', String(actualHeight))
  const url = q.toString() ? `${path}?${q}` : path
  const res = await apiFetch(url, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'image/jpeg' }),
    body: blob
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || `API upload HTTP ${res.status}`)
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
  // Identity comes from JWT session (not spoofable query alone).
  const cached = readCachedUser()
  const callQuery = new URLSearchParams(window.location.search)
  const userId = cached?.id || callQuery.get('user') || ''
  let preferredMediaHint = normalizeMediaMode(callQuery.get('media') || 'video')
  const storedHint = readPreferredMediaHint()
  if (storedHint && !callQuery.get('media')) preferredMediaHint = storedHint


  function rtLog(event, detail) {
    const ts = new Date().toISOString()
    const extra = detail !== undefined ? ` ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''
    console.info(`[rt ${ts}] ${event}${extra}`)
  }

  new Vue({
    el: '#app',
    data: {
      callId,
      userId,
      /** Resolved authoritative mode: audio | video — prefer server call.initialMediaMode */
      preferredMediaMode: preferredMediaHint,
      currentUser: cached || null,
      identities: [],
      call: null,
      recordingCaps: { canStart: false, canStop: false, canDownload: false, canDelete: false },
      hub: null,
      room: null,
      /** @type {import('./domain/media/media-engine.js').MediaEngine|null} */
      mediaEngine: null,
      localTracks: [],
      /** Stops canvas portrait pipeline (if used) */
      localMediaCleanup: null,
      connected: false,
      joining: false,
      mediaPermissionState: 'idle',
      cameraEnabled: preferredMediaHint !== 'audio',
      microphoneEnabled: true,
      cameraToggleBusy: false,
      intentionalLeave: false,
      reconnectNotice: '',
      remoteVideoConnected: false,
      needsAudioPermission: false,
      /** Consultation media (M2–M4) */
      dentalClipBusy: false,
      dentalClipStatus: 'Idle',
      dentalClipAssetId: null,
      photoBusy: false,
      photoStatus: '',
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
      broadcastChannel: null,
      guestAvatarUrl: GUEST_AVATAR_URL
    },
    computed: {
      peerId() {
        if (!this.call) return ''
        return this.call.callerId === this.userId ? this.call.calleeId : this.call.callerId
      },
      peerKnown() {
        return this.identities.find(i => i.id === this.peerId) || null
      },
      peerName() {
        return peerLabel(this.peerId, this.peerKnown)
      },
      peerAvatar() {
        return peerAvatarText(this.peerId, this.peerKnown)
      },
      isEmbedPeer() {
        return isEmbedVisitorId(this.peerId)
      },
      showRemotePlaceholder() {
        return this.mediaPermissionState === 'connected' && !this.remoteVideoConnected
      },
      remotePlaceholderText() {
        if (this.isEmbedPeer) return 'Khách đang tắt camera'
        return 'Đối phương đang tắt camera'
      },
      mediaSetupLabel() {
        if (this.mediaPermissionState === 'requesting') {
          return this.preferredMediaMode === 'audio'
            ? 'Đang xin quyền micro (thoại)…'
            : 'Đang xin quyền camera và micro…'
        }
        if (this.mediaPermissionState === 'connecting') {
          return this.preferredMediaMode === 'audio'
            ? 'Đang kết nối thoại…'
            : 'Đang kết nối video…'
        }
        if (this.mediaPermissionState === 'reconnecting') {
          return this.reconnectNotice || 'Đang kết nối lại media…'
        }
        if (this.mediaPermissionState === 'error') return this.error || 'Không kết nối được hình ảnh / âm thanh'
        if (this.mediaPermissionState === 'connected' && !this.remoteVideoConnected) {
          return this.isEmbedPeer
            ? 'Khách đang tắt camera (vẫn nghe được tiếng).'
            : 'Đối phương đang tắt camera.'
        }
        return this.preferredMediaMode === 'audio'
          ? 'Đang chuẩn bị micro…'
          : 'Đang chuẩn bị camera và micro…'
      },
      callStatusLabel() {
        if (!this.call) return 'Đang tải…'
        return callStatusVi(this.call.status)
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
        // Download is Manager-only; never offer staff default download.
        return this.isManagerRole && (this.recordingCaps?.canDownload || this.call?.recordingAvailable === true)
      },
      isManagerRole() {
        return String(this.currentUser?.role || this.userRole || '').toLowerCase() === 'manager'
      },
      recordingStatusLabel() {
        const s = this.call?.recordingStatus
        if (s === 'Recording') {
          return this.call?.recordingMode === 'AudioOnly' ? 'Đang ghi âm' : 'Đang ghi hình'
        }
        if (s === 'Starting') return 'Đang bắt đầu ghi…'
        if (s === 'Stopping') return 'Đang dừng ghi…'
        if (s === 'Complete') return 'Đã có bản ghi'
        if (s === 'Failed') return 'Ghi không thành công'
        if (s === 'Deleted') return 'Đã xóa bản ghi'
        return ''
      }
    },
    async mounted() {
      // Init BroadcastChannel
      if ('BroadcastChannel' in window) {
        this.broadcastChannel = new BroadcastChannel('livekit_call_channel')
        this.broadcastChannel.postMessage({ type: 'CALL_WINDOW_OPENED', callId: this.callId })
      }

      if (!getAccessToken()) {
        this.error = 'Chưa đăng nhập. Hãy mở trang chính và login trước.'
        return
      }
      // Resolve identity from JWT (source of truth)
      try {
        const meRes = await apiFetch('/api/auth/me')
        if (meRes.ok) {
          const me = await meRes.json()
          this.userId = me.id
        } else {
          this.error = 'Phiên đăng nhập hết hạn. Hãy login lại trên trang chính.'
          return
        }
      } catch (e) {
        this.error = 'Không xác thực được phiên: ' + e.message
        return
      }

      await this.loadIdentities()
      await this.verifyAndConnect()

      window.addEventListener('beforeunload', this.handleBeforeUnload)
    },
    beforeDestroy() {
      this.disconnectRoom()
      if (this.hub) this.hub.stop()
      if (this.broadcastChannel) {
        try {
          this.broadcastChannel.postMessage({
            type: 'CALL_WINDOW_CLOSED',
            callId: this.callId,
            intentional: !!this.intentionalLeave
          })
        } catch { /* ignore */ }
        this.broadcastChannel.close()
      }
      window.removeEventListener('beforeunload', this.handleBeforeUnload)
    },
    methods: {
      async loadIdentities() {
        try {
          const res = await apiFetch(`/api/identities`)
          this.identities = await res.json()
        } catch (e) {
          console.error(e)
        }
      },
      /**
       * Authoritative initial media from server CallView.
       * URL/sessionStorage is only a fallback when older backend lacks the field.
       */
      applyAuthoritativeMediaMode(call) {
        const serverMode = call?.initialMediaMode || call?.InitialMediaMode
        if (serverMode) {
          this.preferredMediaMode = normalizeMediaMode(serverMode)
        } else if (this.preferredMediaMode) {
          // keep URL/session hint
        } else {
          this.preferredMediaMode = 'video'
        }
        // Only seed cameraEnabled before join; after connect LiveKit is truth.
        if (!this.room && !this.mediaEngine?.room) {
          this.cameraEnabled = this.preferredMediaMode !== 'audio'
        }
        try {
          sessionStorage.setItem('simlydent_preferred_media', this.preferredMediaMode)
        } catch { /* ignore */ }
        rtLog('media_mode_resolved', {
          preferred: this.preferredMediaMode,
          server: serverMode || null,
          urlHint: preferredMediaHint
        })
      },
      async verifyAndConnect() {
        try {
          // Connect SignalR first for realtime updates
          await this.connectRealtime()

          // Verify Call with Backend
          const res = await apiFetch(`/api/calls/${this.callId}`, {
            headers: authHeaders()
          })
          if (!res.ok) {
            throw new Error('Cuộc gọi không tồn tại hoặc bạn không có quyền truy cập.')
          }
          this.call = await res.json()
          this.applyAuthoritativeMediaMode(this.call)

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
          .withUrl(`${API_URL}/hubs/calls`, {
            accessTokenFactory: () => getAccessToken()
          })
          .withAutomaticReconnect()
          .build()

        this.hub.on('CallUpdated', async call => {
          if (call.id !== this.callId) return
          const prevStatus = this.call?.status
          this.call = call
          this.applyAuthoritativeMediaMode(call)
          rtLog('CallUpdated', { status: call.status, initialMediaMode: call.initialMediaMode })

          if (call.status === 'Accepted' && prevStatus !== 'Accepted') {
            await this.joinRoom()
          } else if (['Rejected', 'Cancelled', 'Ended'].includes(call.status)) {
            // Business call terminal — not the same as WebRTC blip
            this.intentionalLeave = true
            this.handleCallEnded()
          }
        })
        await this.hub.start()
        this.connected = true
      },
      /**
       * Handle MediaEngine events → Vue UI state.
       * Media disconnect is NEVER auto business hangup (intentionalLeave check).
       */
      onMediaEngineEvent(type, payload) {
        rtLog('media_engine', { type, payload: payload && (payload.reason || payload.message || typeof payload) })
        switch (type) {
          case MediaEngineEvent.Connected:
            this.mediaPermissionState = 'connected'
            this.reconnectNotice = ''
            this.syncRoomFromEngine()
            this.reconcileLocalMediaUi()
            this.attachAvailableRemoteTracks()
            this.$nextTick(() => this.attachLocalVideo())
            this.startQualityMonitoring()
            break
          case MediaEngineEvent.Reconnecting:
            this.mediaPermissionState = 'reconnecting'
            this.reconnectNotice = 'Mạng media đang reconnect… cuộc gọi business vẫn mở.'
            break
          case MediaEngineEvent.Reconnected:
            this.mediaPermissionState = 'connected'
            this.reconnectNotice = ''
            this.syncRoomFromEngine()
            this.reconcileLocalMediaUi()
            this.attachAvailableRemoteTracks()
            break
          case MediaEngineEvent.Disconnected: {
            const reasonStr = payload?.reason || 'unknown'
            if (this.intentionalLeave || this._endingCall) {
              this.handleCallEnded()
              break
            }
            if (this.call && ['Rejected', 'Cancelled', 'Ended'].includes(this.call.status)) {
              this.handleCallEnded()
              break
            }
            this.room = null
            this.mediaEngine = null
            this.mediaPermissionState = 'error'
            this.error = `Mất kết nối media (${reasonStr}). Cuộc gọi chưa kết thúc — bấm Tham gia lại.`
            this.stopQualityMonitoring?.()
            break
          }
          case MediaEngineEvent.Error: {
            const message = String(payload?.message || payload || 'media error')
            this.mediaPermissionState = 'error'
            this.error = /peer connection|pc connection|ice/i.test(message)
              ? 'Không thể thiết lập đường truyền media. Wi-Fi đang chặn kết nối trực tiếp hoặc hệ thống chưa có TURN.'
              : message
            break
          }
          case MediaEngineEvent.RemoteTrackAttached: {
            const { track, element } = payload || {}
            if (!track || !element) break
            if (track.kind === Track.Kind.Video) {
              const host = this.$refs.remoteMedia
              applyVideoDisplayFit(element, host)
              if (host) {
                host.querySelectorAll('video').forEach(n => n.remove())
                host.appendChild(element)
                this.remoteVideoConnected = true
                element.play().catch(() => {})
              }
            } else {
              const host = this.$refs.remoteAudio
              if (host) {
                host.querySelectorAll('audio').forEach(n => n.remove())
                host.appendChild(element)
              } else {
                element.style.display = 'none'
                document.body.appendChild(element)
              }
              element.play().catch(() => { this.needsAudioPermission = true })
            }
            break
          }
          case MediaEngineEvent.RemoteTrackDetached:
            if (payload?.track?.kind === Track.Kind.Video) this.remoteVideoConnected = false
            break
          case MediaEngineEvent.RemoteVideoMuted:
            this.remoteVideoConnected = false
            break
          case MediaEngineEvent.RemoteVideoUnmuted: {
            if (payload?.track && payload?.element) {
              const host = this.$refs.remoteMedia
              applyVideoDisplayFit(payload.element, host)
              if (host) {
                host.querySelectorAll('video').forEach(n => n.remove())
                host.appendChild(payload.element)
                this.remoteVideoConnected = true
                payload.element.play().catch(() => {})
              }
            } else {
              this.remoteVideoConnected = true
            }
            break
          }
          case MediaEngineEvent.LocalTrackPublished:
          case MediaEngineEvent.LocalMediaStateChanged:
            this.reconcileLocalMediaUi()
            if (this.cameraEnabled) this.$nextTick(() => this.attachLocalVideo())
            else if (this.$refs.localMedia) this.$refs.localMedia.replaceChildren()
            break
          case MediaEngineEvent.LocalTrackUnpublished:
            this.reconcileLocalMediaUi()
            if (payload?.publication?.kind === Track.Kind.Video && this.$refs.localMedia) {
              this.$refs.localMedia.replaceChildren()
            }
            break
          case MediaEngineEvent.AudioPlaybackBlocked:
            this.needsAudioPermission = true
            break
          case MediaEngineEvent.AudioPlaybackAllowed:
            this.needsAudioPermission = false
            break
          case MediaEngineEvent.DataReceived: {
            let msg
            try {
              msg = JSON.parse(new TextDecoder().decode(payload.payload))
            } catch {
              break
            }
            if (msg?.type !== 'capture_photo') break
            ;(async () => {
              try {
                this.photoStatus = 'Đang chụp…'
                await handleCapturePhotoCommand(this.room, msg)
                this.photoStatus = 'Đã gửi ảnh'
              } catch (e) {
                console.warn('capture_photo failed', e)
                this.photoStatus = e.message || 'Chụp ảnh thất bại'
                this.error = this.photoStatus
              }
            })()
            break
          }
          default:
            break
        }
      },
      syncRoomFromEngine() {
        this.room = this.mediaEngine?.room || null
        this.localTracks = this.mediaEngine?._localTracks || this.localTracks || []
      },
      async joinRoom() {
        if (this.joining) return
        if (this.mediaEngine?.room || this.room) return
        this.joining = true
        this.intentionalLeave = false
        this.reconnectNotice = ''
        this.error = ''
        try {
          if (this.call) this.applyAuthoritativeMediaMode(this.call)

          const res = await apiFetch(`/api/calls/${this.callId}/token`, {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' })
          })
          if (!res.ok) {
            const errData = await res.json().catch(() => ({}))
            throw new Error(errData.error || 'Không thể lấy Token kết nối media')
          }
          const credentials = await res.json()

          this.mediaPermissionState = 'requesting'
          const audioOnly = this.preferredMediaMode === 'audio'
          rtLog('joinRoom_media', { audioOnly, preferredMediaMode: this.preferredMediaMode, via: 'MediaEngine' })

          if (this.mediaEngine) {
            try { await this.mediaEngine.destroy() } catch { /* ignore */ }
            this.mediaEngine = null
          }

          this.mediaEngine = createMediaEngine({
            onEvent: (type, payload) => this.onMediaEngineEvent(type, payload)
          })

          this.mediaPermissionState = 'connecting'
          await this.mediaEngine.connect(credentials.url, credentials.token, { audioOnly })
          this.syncRoomFromEngine()
          this.reconcileLocalMediaUi()
          // Connected event also sets state; ensure UI settled
          if (this.mediaPermissionState !== 'error') {
            this.mediaPermissionState = 'connected'
          }
          this.$nextTick(() => this.attachLocalVideo())
        } catch (err) {
          try {
            if (this.mediaEngine) await this.mediaEngine.destroy()
          } catch { /* ignore */ }
          this.mediaEngine = null
          this.room = null
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
        // Legacy helper: route through adapter attach for dental/quality edge paths
        const element = attachTrackElement(track)
        this.onMediaEngineEvent(MediaEngineEvent.RemoteTrackAttached, { track, element })
      },
      attachAvailableRemoteTracks() {
        if (!this.room) return
        subscribeAvailableRemoteTracks(this.room)
        for (const participant of this.room.remoteParticipants.values()) {
          for (const publication of participant.trackPublications.values()) {
            if (publication.track) this.attachRemoteTrack(publication.track)
          }
        }
      },
      attachLocalVideo() {
        if (!this.$refs.localMedia) return
        const room = this.mediaEngine?.room || this.room
        const pubs = room?.localParticipant
          ? [...room.localParticipant.videoTrackPublications.values()]
          : []
        const publication = pubs[0] || null
        const track = (this.mediaEngine?._localTracks || this.localTracks || [])
          .find(item => item.kind === Track.Kind.Video) || publication?.track
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
      getLocalCameraPublication() {
        const room = this.mediaEngine?.room || this.room
        if (!room?.localParticipant) return null
        const pubs = [...room.localParticipant.videoTrackPublications.values()]
        return pubs[0] || null
      },
      reconcileLocalMediaUi() {
        const room = this.mediaEngine?.room || this.room
        if (!room?.localParticipant) {
          if (this.mediaEngine) {
            const s = this.mediaEngine.getLocalMediaState()
            this.cameraEnabled = s.cameraEnabled
            this.microphoneEnabled = s.micEnabled
          }
          return
        }
        const state = this.mediaEngine
          ? this.mediaEngine.getLocalMediaState()
          : readLocalMediaState(room)
        this.cameraEnabled = state.cameraEnabled
        this.microphoneEnabled = state.micEnabled
      },
      async ensureCameraEnabled(wantEnabled) {
        if (!this.mediaEngine?.room) return false
        try {
          rtLog('ensureCameraEnabled', { want: !!wantEnabled, via: 'MediaEngine' })
          const after = await this.mediaEngine.ensureCameraEnabled(!!wantEnabled)
          this.reconcileLocalMediaUi()
          if (this.cameraEnabled) this.attachLocalVideo()
          else if (this.$refs.localMedia) this.$refs.localMedia.replaceChildren()
          return after
        } catch (e) {
          console.warn('ensureCameraEnabled failed', e)
          this.reconcileLocalMediaUi()
          this.error = wantEnabled
            ? (e?.message || 'Không bật được camera — đã giữ trạng thái thoại.')
            : (e?.message || 'Không tắt được camera.')
          return this.cameraEnabled
        }
      },
      async toggleCamera() {
        if (!this.mediaEngine?.room) return
        await this.ensureCameraEnabled(!this.cameraEnabled)
      },
      async toggleMicrophone() {
        if (!this.mediaEngine?.room) return
        try {
          await this.mediaEngine.ensureMicrophoneEnabled(!this.microphoneEnabled)
          this.reconcileLocalMediaUi()
        } catch (e) {
          console.warn('toggleMicrophone failed', e)
          this.reconcileLocalMediaUi()
        }
      },
      async enableAudioPlayback() {
        try {
          if (this.mediaEngine) {
            await this.mediaEngine.unlockAudioPlayback()
          } else if (this.room) {
            await startRoomAudio(this.room)
            replayAllAudioElements()
          }
          this.needsAudioPermission = this.mediaEngine?.room
            ? !this.mediaEngine.room.canPlaybackAudio
            : this.needsAudioPermission
          this.attachAvailableRemoteTracks()
        } catch (e) {
          console.warn('enableAudioPlayback', e)
          this.needsAudioPermission = true
        }
      },
      /** LiveKit participant identity for remote patient (clinicId:userId). */
      resolvePatientParticipantIdentity() {
        if (!this.room || !this.call) return null
        const peerId = this.call.callerId === this.userId ? this.call.calleeId : this.call.callerId
        const clinic = clinicIdOf(this.currentUser) || this.call.clinicId || ''
        // Prefer remote participant that actually has a camera track
        for (const p of this.room.remoteParticipants.values()) {
          const id = p.identity || ''
          const pubs = [...(p.videoTrackPublications?.values?.() || p.trackPublications?.values?.() || [])]
          const hasCam = pubs.some(pub =>
            pub?.source === Track.Source.Camera
            || pub?.kind === Track.Kind.Video
            || pub?.track?.kind === Track.Kind.Video)
          if (hasCam && id) return id
        }
        for (const p of this.room.remoteParticipants.values()) {
          const id = p.identity || ''
          if (id === peerId || id.endsWith(':' + peerId) || (peerId && id.includes(peerId))) {
            return id
          }
        }
        // Fallback: convention {clinicId}:{userId}
        if (clinic && peerId) return `${clinic}:${peerId}`
        // Last resort: first remote identity
        const first = [...this.room.remoteParticipants.values()][0]
        return first?.identity || peerId || null
      },
      resolvePatientVideoTrackSid() {
        if (!this.room) return null
        for (const p of this.room.remoteParticipants.values()) {
          for (const pub of p.videoTrackPublications?.values?.() || p.trackPublications?.values?.() || []) {
            if (pub?.source === Track.Source.Camera || pub?.kind === Track.Kind.Video || pub?.track?.kind === Track.Kind.Video) {
              return pub.trackSid || pub.track?.sid || null
            }
          }
        }
        return null
      },
      async toggleDentalClip() {
        if (!this.callId || this.dentalClipBusy) return
        this.dentalClipBusy = true
        try {
          if (this.dentalClipStatus === 'Recording' && this.dentalClipAssetId) {
            const res = await apiFetch(
              `/api/calls/${this.callId}/video-clips/${this.dentalClipAssetId}/stop`,
              { method: 'POST', headers: authHeaders() }
            )
            const body = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(body.error || `Stop clip HTTP ${res.status}`)
            this.dentalClipStatus = 'Finalizing'
          } else {
            const patientIdentity = this.resolvePatientParticipantIdentity()
            if (!patientIdentity) throw new Error('Chưa thấy bệnh nhân trong room')
            const trackHint = this.resolvePatientVideoTrackSid()
            const remotePub = this.room
              ? [...this.room.remoteParticipants.values()][0]
              : null
            const settings = remotePub
              ? [...(remotePub.videoTrackPublications?.values?.() || [])][0]
                ?.track?.mediaStreamTrack?.getSettings?.()
              : null
            const res = await apiFetch(`/api/calls/${this.callId}/video-clips/start`, {
              method: 'POST',
              headers: authHeaders({ 'Content-Type': 'application/json' }),
              body: JSON.stringify({
                patientParticipantIdentity: patientIdentity,
                patientVideoTrackSidHint: trackHint,
                actualWidth: settings?.width || null,
                actualHeight: settings?.height || null,
                actualFrameRate: settings?.frameRate || null
              })
            })
            const body = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(body.error || `Start clip HTTP ${res.status}`)
            this.dentalClipAssetId = body.assetId
            this.dentalClipStatus = body.status || 'Recording'
          }
        } catch (e) {
          this.error = e.message
        } finally {
          this.dentalClipBusy = false
        }
      },
      async requestPhoto() {
        if (!this.callId || this.photoBusy) return
        this.photoBusy = true
        this.photoStatus = ''
        try {
          const patientIdentity = this.resolvePatientParticipantIdentity()
          if (!patientIdentity) throw new Error('Chưa thấy bệnh nhân trong room')
          const res = await apiFetch(`/api/calls/${this.callId}/photos/request`, {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ patientParticipantIdentity: patientIdentity })
          })
          const body = await res.json().catch(() => ({}))
          if (!res.ok) throw new Error(body.error || `Request photo HTTP ${res.status}`)
          this.photoStatus = 'Đã gửi lệnh chụp'
        } catch (e) {
          this.error = e.message
          this.photoStatus = e.message
        } finally {
          this.photoBusy = false
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
            `${url}?access_token=${encodeURIComponent(getAccessToken())}`,
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
              headers: authHeaders({ 'Content-Type': 'application/json' }),
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
          const res = await apiFetch(`/api/calls/${this.callId}/quality/export?format=${format}`, {
            headers: authHeaders()
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
          return true
        } catch (err) {
          this.error = err.message
          return false
        }
      },
      /**
       * Flush telemetry, download CSV report, then hang up.
       * Use after a timed real-device test so metrics are not lost.
       */
      async endCallAndExport() {
        if (this._endingCall) return
        try {
          await this.flushQualityLog()
          // Prefer CSV for spreadsheets; fall back quietly if no samples yet
          const ok = await this.downloadQualityLog('csv')
          if (!ok) {
            // Still allow hangup; user may export later via API if samples arrive late
            console.warn('Quality CSV export skipped or failed before hangup')
          }
        } catch (e) {
          console.warn(e)
        }
        await this.endCall()
      },
      copyCallId() {
        const id = this.callId || this.call?.id
        if (!id) return
        const text = String(id)
        if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(text).then(() => {
            this.error = ''
            // brief non-blocking hint via title swap
            console.info('Call ID copied:', text)
          }).catch(() => {
            window.prompt('Copy Call ID:', text)
          })
        } else {
          window.prompt('Copy Call ID:', text)
        }
      },
      applyRecordingView(body) {
        if (!body || !this.call) return
        // Recording endpoints return actor-aware RecordingView, not full CallView.
        if (body.recordingStatus != null || body.recordingMode != null) {
          this.call = {
            ...this.call,
            recordingMode: body.recordingMode ?? this.call.recordingMode,
            recordingStatus: body.recordingStatus ?? this.call.recordingStatus,
            consentStatus: body.consentStatus ?? this.call.consentStatus,
            recordingAvailable: body.canDownload === true
          }
          this.recordingCaps = {
            canStart: !!body.canStart,
            canStop: !!body.canStop,
            canDownload: !!body.canDownload,
            canDelete: !!body.canDelete
          }
          return
        }
        if (body.id) this.call = body
      },
      async toggleRecording() {
        if (this.recordingBusy || this.recordingInProgress) return
        const start = !this.isRecording
        if (start && !window.confirm('Bắt đầu ghi cuộc gọi? Khách/đồng nghiệp sẽ thấy trạng thái đang ghi. Cần đồng ý ghi trước khi bắt đầu.')) return
        this.recordingBusy = true
        this.error = ''
        try {
          if (start) {
            // Snapshot mode Video (default policy is None) + staff consent evidence.
            let res = await apiFetch(`/api/calls/${this.callId}/recording/mode`, {
              method: 'POST',
              headers: authHeaders({ 'Content-Type': 'application/json' }),
              body: JSON.stringify({ mode: 'Video' })
            })
            let body = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(body.error || 'Không đặt được chế độ ghi.')
            this.applyRecordingView(body)
            res = await apiFetch(`/api/calls/${this.callId}/recording/consent`, {
              method: 'POST',
              headers: authHeaders({ 'Content-Type': 'application/json' }),
              body: JSON.stringify({ status: 'Granted' })
            })
            body = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(body.error || 'Không ghi nhận đồng ý ghi.')
            this.applyRecordingView(body)
          }
          const action = start ? 'start' : 'stop'
          const res = await apiFetch(`/api/calls/${this.callId}/recording/${action}`, {
            method: 'POST',
            headers: authHeaders()
          })
          const body = await res.json().catch(() => ({}))
          if (!res.ok) throw new Error(body.error || 'Không thể thay đổi trạng thái ghi.')
          this.applyRecordingView(body)
          if (body.call) this.call = { ...this.call, ...body.call }
        } catch (err) {
          this.error = err.message
        } finally {
          this.recordingBusy = false
        }
      },
      async downloadRecording() {
        try {
          if (!this.callId) throw new Error('Thiếu callId.')
          await fetchAndSaveRecording(this.callId)
        } catch (err) {
          this.error = err.message
        }
      },
      async endCall() {
        // Prevent double-tap / concurrent hangup paths hanging the UI
        if (this._endingCall) return
        this._endingCall = true
        this.intentionalLeave = true
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

          await apiFetch(`/api/calls/${this.callId}/${action}`, {
            method: 'POST',
            headers: authHeaders(),
            keepalive: true
          }).catch(err => console.warn('end/cancel API', err))
        } catch (e) {
          console.error(e)
        } finally {
          this.handleCallEnded()
          this._endingCall = false
        }
      },
      /** Explicit rejoin after unexpected media disconnect (business call still Accepted). */
      async rejoinMedia() {
        this.error = ''
        this.reconnectNotice = ''
        try {
          await this.disconnectRoom()
        } catch { /* ignore */ }
        this.room = null
        await this.joinRoom()
      },
      handleCallEnded() {
        rtLog('handleCallEnded', {
          intentional: this.intentionalLeave,
          status: this.call?.status
        })
        try {
          this.disconnectRoom()
        } catch (e) {
          console.warn(e)
        }
        if (this.broadcastChannel) {
          try {
            this.broadcastChannel.postMessage({
              type: 'CALL_WINDOW_CLOSED',
              callId: this.callId,
              intentional: true
            })
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
        if (this.mediaEngine) {
          try { this.mediaEngine.destroy() } catch (e) { console.warn(e) }
          this.mediaEngine = null
        } else if (this.room) {
          try { this.room.disconnect() } catch (e) { console.warn(e) }
        }
        this.room = null
        if (typeof this.localMediaCleanup === 'function') {
          this.localMediaCleanup()
          this.localMediaCleanup = null
        }
        this.localTracks.forEach(t => { try { t.stop() } catch { /* ignore */ } })
        this.localTracks = []
        this.remoteVideoConnected = false
        this.qualityStats = initialQualityStats()
        this.qualityStatsPrevious = { inbound: {}, outbound: {} }
        this.mediaPermissionState = 'idle'
      },
      handleBeforeUnload() {
        this.flushQualityLog(true)
        // Only end the *business* call if user already pressed Hang up.
        // Do NOT sendBeacon end/cancel on every unload — "Mở lại" reuses the
        // same window name and was killing the call (reload → beforeunload → end).
        if (this.intentionalLeave && this.call && ['Accepted', 'Ringing'].includes(this.call.status)) {
          const action = this.call.status === 'Accepted' ? 'end' : 'cancel'
          try {
            navigator.sendBeacon(
              `${API_URL}/api/calls/${this.callId}/${action}?access_token=${encodeURIComponent(getAccessToken())}`
            )
          } catch { /* ignore */ }
        }
        if (this.broadcastChannel) {
          try {
            this.broadcastChannel.postMessage({
              type: 'CALL_WINDOW_CLOSED',
              callId: this.callId,
              intentional: !!this.intentionalLeave
            })
          } catch { /* ignore */ }
        }
      }
    },
    template: `
      <div class="call-window-shell">
        <header class="call-window-header">
          <div class="call-header-user">
            <div class="call-header-avatar" :title="peerId">{{ peerAvatar }}</div>
            <div>
              <div class="call-header-title">{{ peerName }}</div>
              <div class="call-header-status">{{ callStatusLabel }}</div>
            </div>
          </div>
          <div class="call-header-actions">
            <span v-if="isRecording || recordingStatusLabel" class="recording-indicator"><span></span> {{ recordingStatusLabel || 'Đang ghi' }}</span>
            <span v-if="dentalClipStatus === 'Recording'" class="recording-indicator"><span></span> Clip răng</span>
            <span v-if="photoStatus" class="recording-indicator" style="opacity:.85">{{ photoStatus }}</span>
            <button v-if="mediaPermissionState === 'connected'" class="quality-badge" @click="showQualityPanel = !showQualityPanel" title="Xem chất lượng hình ảnh">{{ qualityBadge }}</button>
            <button v-if="needsAudioPermission" class="audio-fallback-btn" @click="enableAudioPlayback">Bật tiếng</button>
          </div>
        </header>

        <main class="call-window-body">
          <!-- Connecting / Waiting State -->
          <div v-if="!call || call.status !== 'Accepted'" class="call-connecting-state">
            <div class="pulse-ring-avatar" :title="peerName">{{ peerAvatar }}</div>
            <h2>{{ peerName }}</h2>
            <p v-if="call && call.status === 'Ringing'">{{ call.callerId === userId ? 'Đang đổ chuông…' : 'Cuộc gọi đến — vui lòng chờ…' }}</p>
            <p v-else-if="call">{{ callStatusLabel }}</p>
            <p v-else>Đang kết nối…</p>
          </div>

          <!-- Video Grid inside Call Window -->
          <div v-else class="call-video-grid">
            <div class="remote-video-container" ref="remoteMedia">
              <div
                v-if="showRemotePlaceholder"
                class="remote-avatar-placeholder"
              >
                <img
                  v-if="isEmbedPeer"
                  :src="guestAvatarUrl"
                  alt="Khách"
                />
                <div v-else class="initials-avatar">{{ peerAvatar }}</div>
                <p>{{ remotePlaceholderText }}</p>
              </div>
              <span
                v-else-if="mediaPermissionState !== 'connected'"
                class="remote-video-status"
              >{{ mediaSetupLabel }}</span>
            </div>
            <div class="local-video-container" ref="localMedia"></div>
            <div ref="remoteAudio"></div>

            <section v-if="showQualityPanel" class="quality-panel" aria-label="Chất lượng hình ảnh">
              <div class="quality-panel-title">Chất lượng hình ảnh <span class="quality-auto-hint">(tự cập nhật)</span></div>
              <p class="quality-call-id" title="Mã cuộc gọi (hỗ trợ kỹ thuật)">
                Mã cuộc gọi:
                <button type="button" class="quality-call-id-btn" @click="copyCallId">{{ callId }}</button>
              </p>
              <dl>
                <div><dt>Hình nhận</dt><dd>{{ qualityStats.incomingResolution }} · {{ qualityStats.incomingFps }} khung/giây</dd></div>
                <div><dt>Tốc độ nhận</dt><dd>{{ qualityStats.incomingBitrateKbps }} kbps</dd></div>
                <div><dt>Hình gửi</dt><dd>{{ qualityStats.outgoingResolution }} · {{ qualityStats.outgoingFps }} khung/giây</dd></div>
                <div><dt>Tốc độ gửi</dt><dd>{{ qualityStats.outgoingBitrateKbps }} kbps</dd></div>
                <div><dt>Mất tín hiệu</dt><dd>{{ qualityStats.packetLossPercent }}%</dd></div>
                <div><dt>Độ trễ</dt><dd>{{ qualityStats.roundTripTimeMs }} ms</dd></div>
                <div><dt>Định dạng</dt><dd>{{ qualityStats.codec }}</dd></div>
                <div><dt>Hạn chế mạng</dt><dd>{{ qualityStats.qualityLimitationReason }}</dd></div>
              </dl>
              <div class="quality-export-actions">
                <button type="button" class="quality-export-primary" @click="downloadQualityLog('csv')" title="Tải báo cáo chất lượng">Tải báo cáo</button>
                <button type="button" class="quality-export-end" @click="endCallAndExport" title="Tải báo cáo rồi kết thúc">Kết thúc và tải</button>
              </div>
            </section>

            <div class="call-window-controls">
              <button v-if="mediaPermissionState === 'connected'" :class="['ctrl-btn', !microphoneEnabled && 'off']" @click="toggleMicrophone" :title="microphoneEnabled ? 'Tắt micro' : 'Bật micro'">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3M8 22h8"/></svg>
              </button>
              <button v-if="mediaPermissionState === 'connected'" :class="['ctrl-btn', !cameraEnabled && 'off']" @click="toggleCamera" :title="cameraEnabled ? 'Tắt camera' : 'Bật camera'">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m16 13 5 3V8l-5 3V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2z"/></svg>
              </button>
              <button v-if="mediaPermissionState === 'connected'" :class="['ctrl-btn', 'record-btn', isRecording && 'recording']" :disabled="recordingBusy || recordingInProgress" @click="toggleRecording" :title="isRecording ? 'Dừng ghi' : 'Bắt đầu ghi (cần đồng ý)'">
                <span class="record-dot"></span>
              </button>
              <button
                v-if="mediaPermissionState === 'connected' && !isManagerRole"
                :class="['ctrl-btn', dentalClipStatus === 'Recording' && 'recording']"
                :disabled="dentalClipBusy || dentalClipStatus === 'Finalizing'"
                @click="toggleDentalClip"
                :title="dentalClipStatus === 'Recording' ? 'Dừng clip răng' : 'Ghi clip răng (camera bệnh nhân)'"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="14" height="14" rx="2"/><path d="m17 10 4-2v8l-4-2"/></svg>
              </button>
              <button
                v-if="mediaPermissionState === 'connected' && !isManagerRole"
                class="ctrl-btn"
                :disabled="photoBusy"
                @click="requestPhoto"
                title="Chụp ảnh (gửi lệnh cho bệnh nhân)"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
              </button>
              <button v-if="recordingAvailable" class="ctrl-btn download-btn" @click="downloadRecording" title="Tải bản ghi (quản lý)">
                <svg viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>
              </button>
              <button v-if="mediaPermissionState === 'error'" class="start-call-btn" style="padding: 8px 16px; font-size: 13px;" @click="rejoinMedia">
                Tham gia lại media
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
      loginAccounts: [],
      loginUserId: 'A1',
      loginPassword: DEMO_PASSWORD_HINT,
      loginError: '',
      loginBusy: false,
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
      /** userId -> online bool (same clinic only) */
      onlineMap: {},
      /** userId -> agent state string (Available/Ringing/InCall/Offline) */
      agentStateMap: {},
      queueItems: [],
      /** Staff/Manager queue dock bottom-right; collapsed by default. */
      queuePanelOpen: false,
      heartbeatTimer: null,
      showOtherClinics: false,
      guestAvatarUrl: GUEST_AVATAR_URL,
      /** Manager library */
      recordings: [],
      recordingsTotal: 0,
      recordingsLoading: false,
      recordingsError: '',
      recordingsFilter: 'all', // all | complete | deleted | failed
      recordingActionId: null,
      /** Manager consultations (M5) */
      consultations: [],
      consultationsLoading: false,
      consultationsError: '',
      consultationDetail: null,
      consultationDetailLoading: false,
      mediaActionId: null,
      /** Left icon rail — only "call" is implemented */
      activeNav: 'call',
      navRailItems: [
        { id: 'call', label: 'Cuộc gọi' },
        { id: 'schedule', label: 'Lịch hẹn' },
        { id: 'patients', label: 'Bệnh nhân' },
        { id: 'chat', label: 'Tin nhắn' },
        { id: 'stats', label: 'Thống kê' },
        { id: 'billing', label: 'Thu chi' },
        { id: 'settings', label: 'Cài đặt' }
      ]
    },
    computed: {
      isCallNav() {
        return this.activeNav === 'call'
      },
      identityId() {
        return this.currentUser?.id || ''
      },
      isVisitor() {
        return (this.currentUser?.role || 'Staff') === 'Visitor'
      },
      isManager() {
        return String(this.currentUser?.role || '').toLowerCase() === 'manager'
      },
      isCallActive() {
        return !!(this.call && ['Queued', 'Ringing', 'Accepted'].includes(this.call.status))
      },
      selectedIdentity() {
        if (this.isVisitor) return null
        return this.identities.find(i => i.id === this.targetId)
          || this.visibleContacts[0]
          || null
      },
      showDetailPanel() {
        return !!(this.selectedIdentity && !this.isVisitor && !this.isManager)
      },
      visibleContacts() {
        const query = this.searchQuery.trim().toLowerCase()
        const clinic = clinicIdOf(this.currentUser)
        return this.identities.filter(i => {
          if (i.id === this.identityId) return false
          // Default: only same clinic (demo B1 is other clinic). Backend also filters directory.
          if (!this.showOtherClinics && clinic && clinicIdOf(i) !== clinic) return false
          if (!query) return true
          return `${i.id} ${i.displayName} ${clinicIdOf(i)}`.toLowerCase().includes(query)
        })
      },
      peerIdentity() {
        if (!this.call) return this.selectedIdentity
        const peerId = this.call.callerId === this.identityId ? this.call.calleeId : this.call.callerId
        const known = this.identities.find(i => i.id === peerId)
        if (known) return known
        return {
          id: peerId,
          displayName: peerLabel(peerId),
          role: isEmbedVisitorId(peerId) ? 'Visitor' : 'Staff'
        }
      },
      peerName() {
        return peerLabel(this.peerIdentity?.id, this.peerIdentity)
      },
      peerAvatar() {
        return peerAvatarText(this.peerIdentity?.id, this.peerIdentity)
      },
      isEmbedPeer() {
        return isEmbedVisitorId(this.peerIdentity?.id)
      },
      selfAgentState() {
        return this.agentStateMap[this.identityId] || (this.identityId ? 'Available' : 'Offline')
      },
      selfAgentBadgeClass() {
        return agentBadgeClass(this.selfAgentState)
      },
      selfAgentBadgeLabel() {
        return agentBadgeLabel(this.selfAgentState)
      },
      queueMineCount() {
        return (this.queueItems || []).filter(i => this.isQueueAssignedToMe(i)).length
      },
      filteredRecordings() {
        const list = this.recordings || []
        const f = this.recordingsFilter
        if (f === 'complete') return list.filter(r => r.recordingStatus === 'Complete')
        if (f === 'deleted') return list.filter(r => r.recordingStatus === 'Deleted')
        if (f === 'failed') return list.filter(r => r.recordingStatus === 'Failed')
        return list
      },
      completeRecordingsCount() {
        return (this.recordings || []).filter(r => r.recordingStatus === 'Complete').length
      },
      /** Group demo accounts by clinic so login stays short + scannable. */
      loginAccountGroups() {
        const map = new Map()
        for (const user of this.loginAccounts || []) {
          const key = clinicIdOf(user) || 'other'
          if (!map.has(key)) {
            map.set(key, {
              clinicId: key,
              label: clinicDisplayName(key),
              users: []
            })
          }
          map.get(key).users.push(user)
        }
        // Prefer clinic-a then clinic-b then others
        const order = ['clinic-a', 'clinic-b']
        return [...map.values()].sort((a, b) => {
          const ia = order.indexOf(a.clinicId)
          const ib = order.indexOf(b.clinicId)
          if (ia === -1 && ib === -1) return a.label.localeCompare(b.label, 'vi')
          if (ia === -1) return 1
          if (ib === -1) return -1
          return ia - ib
        })
      }
    },
    async mounted() {
      // Init BroadcastChannel to sync with Call Window
      if ('BroadcastChannel' in window) {
        this.broadcastChannel = new BroadcastChannel('livekit_call_channel')
        this.broadcastChannel.onmessage = (event) => {
          const { type, callId, intentional } = event.data || {}
          if (type === 'CALL_WINDOW_OPENED' || type === 'CALL_WINDOW_READY') {
            if (this.call && this.call.id === callId) {
              this.popupState = 'active_window'
            }
          } else if (type === 'CALL_WINDOW_CLOSED') {
            // Reload/"Mở lại" also fires CLOSED briefly — keep Accepted call so reopen works.
            // Only clear UI when hangup was intentional or call is no longer active.
            if (this.call && callId && this.call.id !== callId) return
            if (intentional) {
              this.clearCallUiState({ showEndedToast: false })
              return
            }
            if (this.call && this.isCallActive) {
              this.callWindowRef = null
              this.popupState = 'active_window'
              return
            }
            this.clearCallUiState({ showEndedToast: false })
          }
        }
      }

      await this.bootstrapAuth()
    },
    beforeDestroy() {
      if (this.hub) this.hub.stop()
      if (this.broadcastChannel) this.broadcastChannel.close()
    },
    methods: {
      async bootstrapAuth() {
        // Public account list for login picker
        try {
          const res = await fetch(`${API_URL}/api/auth/accounts`)
          if (res.ok) this.loginAccounts = await res.json()
        } catch (err) {
          this.loginError = 'Không tải được danh sách tài khoản: ' + err.message
        }

        // Restore JWT session if still valid
        if (getAccessToken()) {
          try {
            const meRes = await apiFetch('/api/auth/me')
            if (meRes.ok) {
              const me = await meRes.json()
              await this.enterApp(me)
              return
            }
          } catch {
            /* fall through to login */
          }
          clearAuthSession()
        }
        this.isLoggedIn = false
      },
      async loadIdentities() {
        try {
          const res = await apiFetch(`/api/identities`)
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          this.identities = await res.json()
        } catch (err) {
          this.popupErrorMessage = 'Không thể tải danh sách liên hệ: ' + err.message
          this.popupState = 'error'
        }
      },
      selectLoginAccount(user) {
        this.loginUserId = user.id
        this.loginPassword = DEMO_PASSWORD_HINT
        this.loginError = ''
      },
      async submitLogin() {
        this.loginBusy = true
        this.loginError = ''
        try {
          const res = await fetch(`${API_URL}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              userId: this.loginUserId,
              password: this.loginPassword
            })
          })
          const body = await res.json().catch(() => ({}))
          if (!res.ok) {
            throw new Error(body.error || 'Đăng nhập thất bại')
          }
          setAuthSession(body.accessToken, body.user)
          await this.enterApp(body.user)
        } catch (err) {
          this.loginError = err.message
        } finally {
          this.loginBusy = false
        }
      },
      async enterApp(user) {
        this.currentUser = user
        this.isLoggedIn = true
        this.onlineMap = {}
        this.recordings = []
        this.recordingsError = ''
        history.replaceState(null, '', `?user=${encodeURIComponent(user.id)}`)
        await this.loadIdentities()
        const sameClinicPeers = this.identities.filter(i => i.id !== user.id)
        this.targetId = sameClinicPeers[0]?.id || ''
        await this.connectRealtime()
        if (String(user.role || '').toLowerCase() === 'manager') {
          await Promise.all([this.loadConsultations(), this.loadRecordings()])
        }
      },
      async logout() {
        if (this.heartbeatTimer) {
          clearInterval(this.heartbeatTimer)
          this.heartbeatTimer = null
        }
        if (this.hub) await this.hub.stop()
        clearAuthSession()
        this.currentUser = null
        this.isLoggedIn = false
        this.call = null
        this.popupState = 'none'
        this.onlineMap = {}
        this.agentStateMap = {}
        this.queueItems = []
        this.queuePanelOpen = false
        this.identities = []
        this.recordings = []
        this.recordingsTotal = 0
        this.recordingsError = ''
        this.recordingActionId = null
        this.consultations = []
        this.consultationDetail = null
        history.replaceState(null, '', location.pathname)
      },
      async loadConsultations() {
        if (!this.isManager) return
        this.consultationsLoading = true
        this.consultationsError = ''
        try {
          const res = await apiFetch('/api/consultations?limit=50', { headers: authHeaders() })
          const body = await res.json().catch(() => ({}))
          if (res.status === 404) {
            this.consultations = []
            return
          }
          if (!res.ok) {
            throw new Error(body.error || `Không tải được consultations (HTTP ${res.status})`)
          }
          this.consultations = body.items || []
        } catch (e) {
          this.consultationsError = e.message || 'Lỗi tải consultations'
          this.consultations = []
        } finally {
          this.consultationsLoading = false
        }
      },
      async openConsultationDetail(sessionId) {
        if (!sessionId) return
        this.consultationDetailLoading = true
        try {
          const res = await apiFetch(`/api/consultations/${sessionId}`, { headers: authHeaders() })
          const body = await res.json().catch(() => ({}))
          if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
          this.consultationDetail = body
        } catch (e) {
          this.popupErrorMessage = e.message
          this.popupState = 'error'
        } finally {
          this.consultationDetailLoading = false
        }
      },
      closeConsultationDetail() {
        this.consultationDetail = null
      },
      async downloadMediaAsset(assetId, kind) {
        if (!assetId || this.mediaActionId) return
        this.mediaActionId = assetId
        try {
          await fetchAndSaveMediaAsset(assetId, kind)
        } catch (e) {
          this.popupErrorMessage = e.message
          this.popupState = 'error'
        } finally {
          this.mediaActionId = null
        }
      },
      async deleteMediaAsset(assetId) {
        if (!assetId || this.mediaActionId) return
        const ok = window.confirm('Đánh dấu xóa media này? File sẽ bị xóa sau bởi retention.')
        if (!ok) return
        this.mediaActionId = assetId
        try {
          const res = await apiFetch(`/api/media/${assetId}`, {
            method: 'DELETE',
            headers: authHeaders()
          })
          const body = await res.json().catch(() => ({}))
          if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
          if (this.consultationDetail?.sessionId) {
            await this.openConsultationDetail(this.consultationDetail.sessionId)
          }
          await this.loadConsultations()
        } catch (e) {
          this.popupErrorMessage = e.message
          this.popupState = 'error'
        } finally {
          this.mediaActionId = null
        }
      },
      async loadRecordings() {
        if (!this.isManager) return
        this.recordingsLoading = true
        this.recordingsError = ''
        try {
          const res = await apiFetch('/api/recordings', { headers: authHeaders() })
          const body = await res.json().catch(() => ({}))
          if (!res.ok) {
            throw new Error(body.error || `Không tải được danh sách (HTTP ${res.status})`)
          }
          this.recordings = body.items || []
          this.recordingsTotal = body.total ?? this.recordings.length
        } catch (e) {
          this.recordingsError = e.message || 'Lỗi tải bản ghi'
          this.recordings = []
          this.recordingsTotal = 0
        } finally {
          this.recordingsLoading = false
        }
      },
      async downloadRecordingByCallId(callId) {
        if (!callId || this.recordingActionId) return
        this.recordingActionId = callId
        try {
          await fetchAndSaveRecording(callId)
        } catch (e) {
          this.popupErrorMessage = e.message
          this.popupState = 'error'
          this.error = e.message
        } finally {
          this.recordingActionId = null
        }
      },
      async deleteRecordingByCallId(callId) {
        if (!callId || this.recordingActionId) return
        const ok = window.confirm('Xóa bản ghi này? Thao tác không hoàn tác được.')
        if (!ok) return
        this.recordingActionId = callId
        try {
          const res = await apiFetch(`/api/calls/${callId}/recording`, {
            method: 'DELETE',
            headers: authHeaders()
          })
          const body = await res.json().catch(() => ({}))
          if (!res.ok) {
            throw new Error(body.error || `Không xóa được (HTTP ${res.status})`)
          }
          await this.loadRecordings()
        } catch (e) {
          this.popupErrorMessage = e.message
          this.popupState = 'error'
        } finally {
          this.recordingActionId = null
        }
      },
      recordingStatusLabelVi,
      recordingModeLabel,
      formatViDateTime,
      selectNav(id) {
        this.activeNav = id || 'call'
      },
      isUserOnline(userId) {
        return !!this.onlineMap[userId]
      },
      isCallForMe(call) {
        if (!call) return false
        const me = this.identityId
        return call.callerId === me
          || call.calleeId === me
          || call.assignedStaffId === me
      },
      applyPresenceSnapshot(snapshot) {
        if (!snapshot?.users) return
        const nextOnline = { ...this.onlineMap }
        const nextState = { ...this.agentStateMap }
        for (const u of snapshot.users) {
          nextOnline[u.userId] = !!u.online
          nextState[u.userId] = u.state || (u.online ? 'Available' : 'Offline')
        }
        // Self is online while this page is connected
        if (this.identityId) {
          nextOnline[this.identityId] = true
          if (!nextState[this.identityId] || nextState[this.identityId] === 'Offline') {
            nextState[this.identityId] = 'Available'
          }
        }
        this.onlineMap = nextOnline
        this.agentStateMap = nextState
      },
      clearCallUiState({ showEndedToast = false } = {}) {
        this.call = null
        this.popupState = showEndedToast ? 'ended' : 'none'
        this.callWindowRef = null
      },
      async connectRealtime() {
        if (this.hub) await this.hub.stop()
        if (this.heartbeatTimer) {
          clearInterval(this.heartbeatTimer)
          this.heartbeatTimer = null
        }
        this.hub = new signalR.HubConnectionBuilder()
          .withUrl(`${API_URL}/hubs/calls`, {
            accessTokenFactory: () => getAccessToken()
          })
          .withAutomaticReconnect()
          .build()

        this.hub.on('CallUpdated', call => {
          if (!this.isCallForMe(call)) return

          this.call = call

          if (call.status === 'Queued') {
            this.popupState = call.callerId === this.identityId ? 'ringing' : 'none'
          } else if (call.status === 'Ringing') {
            const assigned = call.assignedStaffId || call.calleeId
            this.popupState = assigned === this.identityId ? 'incoming' : 'ringing'
          } else if (call.status === 'Accepted') {
            this.popupState = 'active_window'
          } else if (call.status === 'Rejected') {
            this.popupState = 'rejected'
          } else if (['Cancelled', 'Ended', 'Timeout', 'NoAgent', 'Closed'].includes(call.status)) {
            this.popupState = 'ended'
            if (this._endedToastTimer) clearTimeout(this._endedToastTimer)
            this._endedToastTimer = setTimeout(() => {
              if (this.popupState === 'ended' && !this.isCallActive) {
                this.clearCallUiState({ showEndedToast: false })
              }
            }, 2500)
          }
        })

        this.hub.on('PresenceUpdated', snapshot => {
          this.applyPresenceSnapshot(snapshot)
        })

        this.hub.on('QueueUpdated', snapshot => {
          this.queueItems = snapshot?.items || []
        })

        this.hub.onreconnected(async () => {
          await this.refreshPresence()
          if (!this.isVisitor) {
            await this.refreshQueue()
            try { await this.hub.invoke('Heartbeat') } catch { /* ignore */ }
          }
        })

        await this.hub.start()
        await this.refreshPresence()

        if (!this.isVisitor && !this.isManager) {
          // Staff only — Manager is not dispatched / not "ready" for queue.
          try {
            await apiFetch('/api/agents/ready', { method: 'POST', headers: authHeaders() })
          } catch { /* ignore */ }
          this.heartbeatTimer = setInterval(() => {
            if (this.hub?.state === 'Connected') {
              this.hub.invoke('Heartbeat').catch(() => {})
            }
          }, 15000)
        }
        if (!this.isVisitor) {
          await this.refreshQueue()
        }

        // Check if there is an active call already
        try {
          const res = await apiFetch(`/api/calls/active`, {
            headers: authHeaders()
          })
          if (res.ok && res.status !== 204) {
            const activeCall = await res.json()
            this.call = activeCall
            if (activeCall.status === 'Accepted') {
              this.popupState = 'active_window'
            } else if (activeCall.status === 'Ringing') {
              const assigned = activeCall.assignedStaffId || activeCall.calleeId
              this.popupState = assigned === this.identityId ? 'incoming' : 'ringing'
            } else if (activeCall.status === 'Queued') {
              this.popupState = 'ringing'
            }
          }
        } catch (e) {
          console.error(e)
        }
      },
      async refreshPresence() {
        try {
          const res = await apiFetch(`/api/presence`, {
            headers: authHeaders()
          })
          if (res.ok) {
            this.applyPresenceSnapshot(await res.json())
          }
        } catch (e) {
          console.warn('presence fetch failed', e)
        }
      },
      async refreshQueue() {
        if (this.isVisitor) return
        try {
          const res = await apiFetch('/api/queue', { headers: authHeaders() })
          if (res.ok) {
            const snap = await res.json()
            this.queueItems = snap?.items || []
          }
        } catch (e) {
          console.warn('queue fetch failed', e)
        }
      },
      formatQueueLabel,
      queueStatusVi,
      callStatusVi,
      formatWaitSeconds,
      clinicDisplayName,
      roleDisplayName,
      userInitials,
      isQueueAssignedToMe(item) {
        if (!item || !this.identityId) return false
        return String(item.assignedStaffId || '').toLowerCase() === this.identityId.toLowerCase()
      },
      agentStateFor(userId) {
        return this.agentStateMap[userId] || 'Offline'
      },
      agentBadgeClassFor(userId) {
        return agentBadgeClass(this.agentStateFor(userId))
      },
      agentBadgeLabelFor(userId) {
        return agentBadgeLabel(this.agentStateFor(userId))
      },
      callUrlFor(callId, mediaMode = 'video') {
        const media = mediaMode === 'audio' ? 'audio' : 'video'
        return `/call/${callId}?user=${encodeURIComponent(this.identityId)}&media=${media}`
      },
      mediaModeFromCall(call, fallback = 'video') {
        const m = call?.initialMediaMode || call?.InitialMediaMode || fallback
        return String(m).toLowerCase() === 'audio' ? 'audio' : 'video'
      },
      async startQueueCall(mediaMode = 'video') {
        if (this.isCallActive) return
        try {
          const media = mediaMode === 'audio' ? 'audio' : 'video'
          try {
            sessionStorage.setItem('simlydent_preferred_media', media)
          } catch { /* ignore */ }
          const res = await apiFetch('/api/queue/calls', {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ initialMediaMode: media === 'audio' ? 'Audio' : 'Video' })
          })
          const body = await res.json().catch(() => ({}))
          if (!res.ok) {
            this.popupErrorMessage = body.error || 'Không vào được hàng đợi.'
            this.popupState = 'error'
            return
          }
          this.call = body
          this.popupState = body.status === 'Ringing' ? 'ringing' : 'ringing'
          // Demo visitor (VA): open call window when accepted — media from server call
          this._queuePreferredMedia = this.mediaModeFromCall(body, media)
        } catch (e) {
          this.popupErrorMessage = e.message
          this.popupState = 'error'
        }
      },
      selectUser(userId) {
        if (userId === this.identityId) return
        // Only block while call is truly active (was: !this.call → stuck after end)
        if (this.isCallActive) return
        const peer = this.identities.find(i => i.id === userId)
        if (!peer) return
        if (!this.sameClinic(peer) && !this.showOtherClinics) return
        this.targetId = userId
      },
      sameClinic(item) {
        return clinicIdOf(item) === clinicIdOf(this.currentUser)
      },
      /** Compatibility alias used by existing templates. */
      sameTenant(item) {
        return this.sameClinic(item)
      },
      contactStatusLabel(item) {
        if (!this.sameClinic(item)) return 'Phòng khám khác'
        const state = this.agentStateMap[item.id]
        if (state && state !== 'Offline') return agentBadgeLabel(state)
        return this.isUserOnline(item.id) ? 'Sẵn sàng' : 'Ngoại tuyến'
      },
      clinicLabel(clinicId) {
        return clinicDisplayName(clinicId)
      },
      roleLabel(role) {
        return roleDisplayName(role)
      },
      isManagerAccount(user) {
        return String(user?.role || '').toLowerCase() === 'manager'
      },
      async startCall(targetId, mediaMode = 'video') {
        if (this.isVisitor) {
          await this.startQueueCall(mediaMode)
          return
        }
        if (this.isManager) {
          this.popupErrorMessage = 'Tài khoản Quản lý không đặt cuộc gọi media. Hãy dùng tài khoản nhân viên tư vấn để nhận khách.'
          this.popupState = 'error'
          return
        }
        if (this.isCallActive) return
        const peer = this.identities.find(i => i.id === targetId)
        if (!peer) return
        if (!this.sameClinic(peer)) {
          this.popupErrorMessage = 'Chỉ gọi được đồng nghiệp cùng phòng khám.'
          this.popupState = 'error'
          return
        }
        if (!this.isUserOnline(targetId)) {
          this.popupErrorMessage = 'Đồng nghiệp này đang ngoại tuyến. Vui lòng gọi khi họ đã đăng nhập.'
          this.popupState = 'error'
          return
        }
        this.targetId = targetId
        const media = mediaMode === 'audio' ? 'audio' : 'video'
        try {
          sessionStorage.setItem('simlydent_preferred_media', media)
        } catch { /* ignore */ }
        const isMobile = window.innerWidth < 768

        // Open blank popup immediately to avoid popup blocker on Desktop
        let popupWin = null
        if (!isMobile) {
          popupWin = window.open('about:blank', `Call_${targetId}`, 'width=960,height=680,scrollbars=no,resizable=yes')
        }

        try {
          const res = await apiFetch(`/api/calls`, {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({
              calleeId: targetId,
              initialMediaMode: media === 'audio' ? 'Audio' : 'Video'
            })
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

          // Prefer server authoritative mode; URL is cache only
          const resolved = this.mediaModeFromCall(call, media)
          const callUrl = this.callUrlFor(call.id, resolved)
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
        // Authoritative media is call.initialMediaMode from the ringing CallView (set by caller).
        // sessionStorage is only a stale cache — do not let callee default to video on audio calls.
        const media = this.mediaModeFromCall(this.call, 'video')

        let popupWin = null
        if (!isMobile) {
          popupWin = window.open('about:blank', `Call_${this.call.id}`, 'width=960,height=680,scrollbars=no,resizable=yes')
        }

        try {
          const res = await apiFetch(`/api/calls/${this.call.id}/accept`, {
            method: 'POST',
            headers: authHeaders()
          })

          if (!res.ok) {
            if (popupWin) popupWin.close()
            const errData = await res.json().catch(() => ({}))
            this.popupErrorMessage = errData.error || 'Không nhận được cuộc gọi. Có thể đã được chuyển cho người khác.'
            this.popupState = 'error'
            return
          }

          const call = await res.json()
          this.call = call
          this.popupState = 'active_window'

          const resolved = this.mediaModeFromCall(call, media)
          try {
            sessionStorage.setItem('simlydent_preferred_media', resolved)
          } catch { /* ignore */ }
          const callUrl = this.callUrlFor(call.id, resolved)
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
          await apiFetch(`/api/calls/${this.call.id}/reject`, {
            method: 'POST',
            headers: authHeaders()
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
          await apiFetch(`/api/calls/${this.call.id}/cancel`, {
            method: 'POST',
            headers: authHeaders()
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
        const media = this.mediaModeFromCall(this.call, (() => {
          try {
            return sessionStorage.getItem('simlydent_preferred_media') || 'video'
          } catch {
            return 'video'
          }
        })())
        const callUrl = this.callUrlFor(this.call.id, media)
        if (isMobile) {
          window.location.href = callUrl
          return
        }

        // If the call popup is still open, only focus — do NOT navigate/reload.
        // Navigating the same window name reloads the call page and used to
        // fire beforeunload → sendBeacon end → "Mở lại = tự ngắt".
        try {
          if (this.callWindowRef && !this.callWindowRef.closed) {
            this.callWindowRef.focus()
            this.popupState = 'active_window'
            return
          }
        } catch { /* cross-origin or stale ref */ }

        // Window was closed: open a fresh call window (business call stays Accepted).
        const winName = `Call_${this.call.id}`
        this.callWindowRef = window.open(callUrl, winName, 'width=960,height=680,scrollbars=no,resizable=yes')
        if (!this.callWindowRef) {
          this.popupState = 'popup_blocked'
        } else {
          try {
            this.callWindowRef.focus()
          } catch { /* ignore */ }
          this.popupState = 'active_window'
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
        <!-- LOGIN -->
        <div v-if="!isLoggedIn" class="login-overlay">
          <div class="login-card">
            <div class="login-brand">
              <div class="login-logo">S</div>
              <h1>SimlyDent</h1>
            </div>
            <p class="login-lead">Tư vấn video cho phòng khám</p>
            <p class="login-hint">Chọn tài khoản · mật khẩu <strong>Demo@123</strong></p>

            <div class="login-picker">
              <div class="demo-account-scroll" role="listbox" aria-label="Chọn tài khoản demo">
                <div
                  v-for="group in loginAccountGroups"
                  :key="group.clinicId"
                  class="login-account-group"
                >
                  <div class="login-group-label">{{ group.label }}</div>
                  <button
                    v-for="user in group.users"
                    :key="user.id"
                    type="button"
                    class="account-btn"
                    :class="{ selected: loginUserId === user.id }"
                    role="option"
                    :aria-selected="loginUserId === user.id ? 'true' : 'false'"
                    @click="selectLoginAccount(user)"
                  >
                    <div class="account-avatar">{{ userInitials(user) }}</div>
                    <div class="account-info">
                      <span class="account-name">{{ user.displayName }}</span>
                      <span class="account-id">{{ user.id }} · {{ roleLabel(user.role) }}</span>
                    </div>
                    <span
                      v-if="isManagerAccount(user)"
                      class="account-role-chip account-role-chip--manager"
                    >Quản lý</span>
                  </button>
                </div>
              </div>
              <p class="login-scroll-hint">Cuộn để xem thêm tài khoản</p>
            </div>

            <div class="login-footer-actions">
              <div class="login-password-field">
                <label for="login-password">Mật khẩu</label>
                <input
                  id="login-password"
                  v-model="loginPassword"
                  type="password"
                  autocomplete="current-password"
                  @keyup.enter="submitLogin"
                />
              </div>
              <p v-if="loginError" class="login-error">{{ loginError }}</p>
              <button
                type="button"
                class="start-call-btn login-submit"
                :disabled="loginBusy || !loginUserId"
                @click="submitLogin"
              >
                {{ loginBusy ? 'Đang đăng nhập…' : 'Đăng nhập' }}
              </button>
            </div>
          </div>
        </div>

        <!-- MAIN APP -->
        <main
          v-else
          class="app-shell"
          :class="{
            'has-detail': showDetailPanel && isCallNav,
            'nav-only': !isCallNav
          }"
        >
          <!-- Icon rail (SimlyDent-style app chrome) -->
          <nav class="nav-rail" aria-label="Menu chính">
            <div class="nav-rail-brand" title="SimlyDent">S</div>
            <div class="nav-rail-items">
              <button
                v-for="item in navRailItems"
                :key="item.id"
                type="button"
                class="nav-rail-btn"
                :class="{ active: activeNav === item.id }"
                :title="item.label"
                :aria-label="item.label"
                :aria-current="activeNav === item.id ? 'page' : null"
                @click="selectNav(item.id)"
              >
                <!-- phone / call -->
                <svg v-if="item.id === 'call'" viewBox="0 0 24 24" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.81.36 1.6.68 2.34a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.74.32 1.53.55 2.34.68A2 2 0 0 1 22 16.92z"/></svg>
                <!-- calendar -->
                <svg v-else-if="item.id === 'schedule'" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
                <!-- users -->
                <svg v-else-if="item.id === 'patients'" viewBox="0 0 24 24" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                <!-- message -->
                <svg v-else-if="item.id === 'chat'" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                <!-- chart -->
                <svg v-else-if="item.id === 'stats'" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3v18h18"/><path d="M7 16v-5M12 16V8M17 16v-3"/></svg>
                <!-- wallet -->
                <svg v-else-if="item.id === 'billing'" viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/><path d="M16 15h2"/></svg>
                <!-- settings -->
                <svg v-else viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
              </button>
            </div>
            <button type="button" class="nav-rail-btn nav-rail-logout" title="Đăng xuất" aria-label="Đăng xuất" @click="logout">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/></svg>
            </button>
          </nav>

          <aside class="sidebar" v-if="isCallNav">
            <header class="sidebar-header">
              <div>
                <h1>{{ isVisitor ? 'Tư vấn' : 'Đồng nghiệp' }}</h1>
                <p class="sidebar-kicker">{{ clinicLabel(currentUser.clinicId || currentUser.tenantId) }}</p>
              </div>
            </header>

            <div v-if="!isVisitor" class="search-container">
              <div class="search-input-wrapper">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
                <input v-model="searchQuery" type="search" placeholder="Tìm theo tên…" aria-label="Tìm đồng nghiệp" />
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
                  {{ userInitials(item) }}
                  <div
                    v-if="sameTenant(item)"
                    :class="['status-dot', isUserOnline(item.id) ? 'online' : 'offline']"
                  ></div>
                </div>
                <div class="contact-details">
                  <div class="contact-name">{{ item.displayName }}</div>
                  <div class="contact-status">
                    <span v-if="sameTenant(item)" :class="agentBadgeClassFor(item.id)">{{ agentBadgeLabelFor(item.id) }}</span>
                    <span v-else>{{ contactStatusLabel(item) }}</span>
                  </div>
                </div>
              </div>
              <p v-if="!isVisitor && !visibleContacts.length" class="empty-list-hint">
                Chưa có đồng nghiệp cùng phòng khám.
              </p>
              <p v-if="isVisitor" class="empty-list-hint">
                Dùng nút giữa màn hình để gọi tư vấn.
              </p>
            </div>

            <footer class="sidebar-user-footer">
              <div class="current-user-info">
                <div class="current-user-avatar">{{ userInitials(currentUser) }}</div>
                <div>
                  <strong class="current-user-name">{{ currentUser.displayName }}</strong>
                  <span class="current-user-meta">{{ roleLabel(currentUser.role) }} · {{ clinicLabel(currentUser.clinicId || currentUser.tenantId) }}</span>
                  <span v-if="!isVisitor && !isManager" :class="[selfAgentBadgeClass, 'self-status-badge']">{{ selfAgentBadgeLabel }}</span>
                </div>
              </div>
            </footer>
          </aside>

          <section class="main-stage">
            <!-- Placeholder for non-call nav icons (no page yet) -->
            <div v-if="!isCallNav" class="main-body">
              <div class="idle-placeholder nav-placeholder">
                <div class="hero-avatar-large hero-logo">S</div>
                <h2 class="idle-title">{{ (navRailItems.find(i => i.id === activeNav) || {}).label || 'Mục' }}</h2>
                <p class="idle-desc">Mục này chỉ là khung giao diện — chưa mở trang chi tiết trong PoC.</p>
                <button type="button" class="btn-secondary-pill" @click="selectNav('call')">Về cuộc gọi</button>
              </div>
            </div>

            <template v-else>
            <header class="main-header" v-if="selectedIdentity && !isManager">
              <div class="target-info">
                <div class="user-avatar accent">
                  {{ userInitials(selectedIdentity) }}
                  <div :class="['status-dot', isUserOnline(selectedIdentity.id) ? 'online' : 'offline']"></div>
                </div>
                <div class="target-details">
                  <span class="target-name">{{ selectedIdentity.displayName }}</span>
                  <span class="target-status">
                    <span v-if="sameTenant(selectedIdentity)" :class="agentBadgeClassFor(selectedIdentity.id)">{{ agentBadgeLabelFor(selectedIdentity.id) }}</span>
                    <span v-else>{{ contactStatusLabel(selectedIdentity) }}</span>
                  </span>
                </div>
              </div>
              <div class="header-call-actions">
                <button
                  type="button"
                  class="header-call-btn"
                  :disabled="isCallActive || !isUserOnline(selectedIdentity.id) || !sameTenant(selectedIdentity)"
                  @click="startCall(selectedIdentity.id, 'video')"
                  title="Gọi video (camera + micro)"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m16 13 5 3V8l-5 3V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2z"/></svg>
                  <span>Gọi video</span>
                </button>
                <button
                  type="button"
                  class="header-call-btn header-call-btn--audio"
                  :disabled="isCallActive || !isUserOnline(selectedIdentity.id) || !sameTenant(selectedIdentity)"
                  @click="startCall(selectedIdentity.id, 'audio')"
                  title="Gọi thoại (chỉ micro)"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.81.36 1.6.68 2.34a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.74.32 1.53.55 2.34.68A2 2 0 0 1 22 16.92z"/></svg>
                  <span>Gọi thoại</span>
                </button>
              </div>
            </header>

            <div class="main-body">
              <div v-if="popupState === 'active_window'" class="active-window-banner">
                <span>Cuộc gọi đang mở ở cửa sổ riêng</span>
                <button type="button" @click="reopenCallWindow">Mở lại</button>
              </div>

              <!-- Visitor home -->
              <div v-if="isVisitor" class="idle-placeholder">
                <div class="hero-avatar-large hero-logo">S</div>
                <h2 class="idle-title">Gọi tư vấn</h2>
                <p class="idle-desc">
                  Bạn sẽ vào hàng chờ. Nhân viên rảnh của phòng khám sẽ nhận cuộc gọi.
                  Chọn video (camera + micro) hoặc chỉ thoại.
                </p>
                <p v-if="queueItems.length" class="idle-meta">
                  Hiện có {{ queueItems.length }} yêu cầu đang chờ
                </p>
                <div class="call-actions-row">
                  <button type="button" class="start-call-btn" :disabled="isCallActive" @click="startQueueCall('video')">
                    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="m16 13 5 3V8l-5 3V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2z"/></svg>
                    <span>{{ isCallActive ? ('Đang ' + callStatusVi(call && call.status).toLowerCase()) : 'Gọi video' }}</span>
                  </button>
                  <button type="button" class="start-call-btn start-call-btn--secondary" :disabled="isCallActive" @click="startQueueCall('audio')">
                    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.81.36 1.6.68 2.34a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.74.32 1.53.55 2.34.68A2 2 0 0 1 22 16.92z"/></svg>
                    <span>Gọi thoại</span>
                  </button>
                </div>
              </div>

              <!-- Manager: consultations + legacy recordings -->
              <div v-else-if="isManager" class="manager-library">
                <header class="library-header">
                  <div>
                    <p class="library-kicker">{{ clinicLabel(currentUser.clinicId || currentUser.tenantId) }} · Quản lý</p>
                    <h2 class="library-title">Thư viện tư vấn</h2>
                    <p class="library-desc">
                      Media theo phiên tư vấn (audio + clip răng + ảnh). Chỉ quản lý đúng phòng khám.
                    </p>
                  </div>
                  <div class="library-actions">
                    <button type="button" class="btn-secondary-pill" @click="queuePanelOpen = true">
                      Khách chờ{{ queueItems.length ? ' (' + queueItems.length + ')' : '' }}
                    </button>
                    <button
                      type="button"
                      class="btn-secondary-pill"
                      :disabled="consultationsLoading || recordingsLoading"
                      @click="loadConsultations(); loadRecordings()"
                    >
                      {{ (consultationsLoading || recordingsLoading) ? 'Đang tải…' : 'Làm mới' }}
                    </button>
                  </div>
                </header>

                <h3 class="library-section-title" style="margin: 16px 0 8px; font-size: 15px;">Consultations</h3>
                <p v-if="consultationsError" class="library-error">{{ consultationsError }}</p>
                <div v-if="consultationsLoading && !consultations.length" class="library-empty">
                  Đang tải consultations…
                </div>
                <div v-else-if="!consultations.length" class="library-empty">
                  <p class="library-empty-title">Chưa có phiên tư vấn</p>
                  <p class="library-empty-desc">Sau khi staff Accept + consent, phiên và media sẽ xuất hiện ở đây.</p>
                </div>
                <div v-else class="library-table-wrap">
                  <table class="library-table">
                    <thead>
                      <tr>
                        <th>Bệnh nhân</th>
                        <th>Nhân viên</th>
                        <th>Media</th>
                        <th>Thời gian</th>
                        <th class="col-actions">Thao tác</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="row in consultations" :key="row.sessionId">
                        <td>
                          <div class="library-primary">{{ row.patientDisplayName || row.patientId }}</div>
                          <div class="library-secondary mono" :title="row.callId">{{ String(row.callId).slice(0, 8) }}…</div>
                        </td>
                        <td class="library-secondary">{{ row.staffDisplayName || row.staffId || '—' }}</td>
                        <td class="library-secondary">
                          🔊{{ row.audioCount }} · 🎬{{ row.videoCount }} · 📷{{ row.photoCount }}
                        </td>
                        <td class="library-secondary">
                          {{ formatViDateTime(row.startedAt || row.endedAt) }}
                          <span v-if="row.durationSeconds"> · {{ Math.round(row.durationSeconds / 60) }}p</span>
                        </td>
                        <td class="col-actions">
                          <button type="button" class="row-btn row-btn--primary" @click="openConsultationDetail(row.sessionId)">
                            Xem
                          </button>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <!-- Consultation detail modal -->
                <div v-if="consultationDetail" class="library-modal-backdrop" @click.self="closeConsultationDetail" style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:80;display:flex;align-items:center;justify-content:center;padding:16px;">
                  <div class="library-modal" style="background:#fff;border-radius:12px;max-width:720px;width:100%;max-height:85vh;overflow:auto;padding:20px;">
                    <header style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:12px;">
                      <div>
                        <h3 style="margin:0;">{{ consultationDetail.patientDisplayName }}</h3>
                        <p class="library-secondary" style="margin:4px 0 0;">
                          NV: {{ consultationDetail.staffDisplayName || '—' }} ·
                          {{ formatViDateTime(consultationDetail.startedAt) }}
                        </p>
                      </div>
                      <button type="button" class="btn-secondary-pill" @click="closeConsultationDetail">Đóng</button>
                    </header>
                    <div v-if="consultationDetailLoading">Đang tải…</div>
                    <template v-else>
                      <section v-if="consultationDetail.audio" style="margin-bottom:14px;">
                        <h4 style="margin:0 0 6px;">Audio phiên</h4>
                        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                          <span class="status-pill">{{ consultationDetail.audio.status }}</span>
                          <button v-if="consultationDetail.audio.canDownload" type="button" class="row-btn row-btn--primary"
                            :disabled="mediaActionId === consultationDetail.audio.assetId"
                            @click="downloadMediaAsset(consultationDetail.audio.assetId, 'CallAudio')">Tải audio</button>
                          <button v-if="consultationDetail.audio.canMarkDelete" type="button" class="row-btn row-btn--danger"
                            @click="deleteMediaAsset(consultationDetail.audio.assetId)">Xóa</button>
                        </div>
                      </section>
                      <section style="margin-bottom:14px;">
                        <h4 style="margin:0 0 6px;">Clip răng ({{ (consultationDetail.videoClips || []).length }})</h4>
                        <div v-if="!(consultationDetail.videoClips || []).length" class="library-secondary">Chưa có clip</div>
                        <div v-for="clip in (consultationDetail.videoClips || [])" :key="clip.assetId" style="display:flex;gap:8px;align-items:center;margin:6px 0;flex-wrap:wrap;">
                          <span>Clip {{ clip.displayIndex }}</span>
                          <span class="status-pill">{{ clip.status }}</span>
                          <span class="library-secondary" v-if="clip.width">{{ clip.width }}×{{ clip.height }}</span>
                          <button v-if="clip.canDownload" type="button" class="row-btn row-btn--primary"
                            @click="downloadMediaAsset(clip.assetId, 'DentalVideoClip')">Tải</button>
                          <button v-if="clip.canMarkDelete" type="button" class="row-btn row-btn--danger"
                            @click="deleteMediaAsset(clip.assetId)">Xóa</button>
                        </div>
                      </section>
                      <section>
                        <h4 style="margin:0 0 6px;">Ảnh ({{ (consultationDetail.photos || []).length }})</h4>
                        <div v-if="!(consultationDetail.photos || []).length" class="library-secondary">Chưa có ảnh</div>
                        <div style="display:flex;flex-wrap:wrap;gap:10px;">
                          <div v-for="ph in (consultationDetail.photos || [])" :key="ph.assetId" style="border:1px solid #e5e7eb;border-radius:8px;padding:8px;min-width:120px;">
                            <div class="library-secondary">Ảnh {{ ph.displayIndex }} · {{ ph.status }}</div>
                            <div style="margin-top:6px;display:flex;gap:6px;">
                              <button v-if="ph.canDownload" type="button" class="row-btn row-btn--primary"
                                @click="downloadMediaAsset(ph.assetId, 'Snapshot')">Tải</button>
                              <button v-if="ph.canMarkDelete" type="button" class="row-btn row-btn--danger"
                                @click="deleteMediaAsset(ph.assetId)">Xóa</button>
                            </div>
                          </div>
                        </div>
                      </section>
                    </template>
                  </div>
                </div>

                <h3 class="library-section-title" style="margin: 28px 0 8px; font-size: 15px;">Legacy recordings (trước media catalog)</h3>
                <div class="library-filters" role="tablist" aria-label="Lọc bản ghi cũ">
                  <button
                    type="button"
                    role="tab"
                    :class="['filter-chip', recordingsFilter === 'all' && 'active']"
                    @click="recordingsFilter = 'all'"
                  >Tất cả ({{ recordings.length }})</button>
                  <button
                    type="button"
                    role="tab"
                    :class="['filter-chip', recordingsFilter === 'complete' && 'active']"
                    @click="recordingsFilter = 'complete'"
                  >Sẵn sàng tải ({{ completeRecordingsCount }})</button>
                  <button
                    type="button"
                    role="tab"
                    :class="['filter-chip', recordingsFilter === 'failed' && 'active']"
                    @click="recordingsFilter = 'failed'"
                  >Lỗi</button>
                  <button
                    type="button"
                    role="tab"
                    :class="['filter-chip', recordingsFilter === 'deleted' && 'active']"
                    @click="recordingsFilter = 'deleted'"
                  >Đã xóa</button>
                </div>

                <p v-if="recordingsError" class="library-error">{{ recordingsError }}</p>

                <div v-if="recordingsLoading && !recordings.length" class="library-empty">
                  Đang tải danh sách bản ghi cũ…
                </div>
                <div v-else-if="!filteredRecordings.length" class="library-empty">
                  <p class="library-empty-title">Không có legacy recording</p>
                </div>
                <div v-else class="library-table-wrap">
                  <table class="library-table">
                    <thead>
                      <tr>
                        <th>Khách / cuộc gọi</th>
                        <th>Chế độ</th>
                        <th>Trạng thái</th>
                        <th>Cập nhật</th>
                        <th class="col-actions">Thao tác</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="row in filteredRecordings" :key="row.callId">
                        <td>
                          <div class="library-primary">{{ row.callerLabel || row.callerId }}</div>
                          <div class="library-secondary">
                            {{ row.assignedStaffId ? ('NV: ' + row.assignedStaffId) : 'Chưa gán NV' }}
                            · <span class="mono" :title="row.callId">{{ String(row.callId).slice(0, 8) }}…</span>
                          </div>
                        </td>
                        <td>{{ recordingModeLabel(row.recordingMode) }}</td>
                        <td>
                          <span
                            class="status-pill"
                            :class="'status-pill--' + String(row.recordingStatus || '').toLowerCase()"
                          >{{ recordingStatusLabelVi(row.recordingStatus) }}</span>
                        </td>
                        <td class="library-secondary">{{ formatViDateTime(row.updatedAt) }}</td>
                        <td class="col-actions">
                          <button
                            v-if="row.canDownload"
                            type="button"
                            class="row-btn row-btn--primary"
                            :disabled="recordingActionId === row.callId"
                            @click="downloadRecordingByCallId(row.callId)"
                          >Tải</button>
                          <button
                            v-if="row.canDelete && row.recordingStatus !== 'Deleted'"
                            type="button"
                            class="row-btn row-btn--danger"
                            :disabled="recordingActionId === row.callId"
                            @click="deleteRecordingByCallId(row.callId)"
                          >Xóa</button>
                          <span v-if="!row.canDownload && row.recordingStatus === 'Deleted'" class="library-secondary">—</span>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>

              <!-- Staff: peer selected -->
              <div v-else-if="selectedIdentity" class="idle-placeholder">
                <div class="hero-avatar-large">{{ userInitials(selectedIdentity) }}</div>
                <h2 class="idle-title">{{ selectedIdentity.displayName }}</h2>
                <p class="idle-desc">
                  <span :class="agentBadgeClassFor(selectedIdentity.id)">{{ agentBadgeLabelFor(selectedIdentity.id) }}</span>
                </p>
                <ul class="idle-steps">
                  <li><span class="idle-step-num">1</span><span>Khách website vào <strong>Khách chờ</strong> (góc dưới phải) — hệ thống mời bạn nhận máy.</span></li>
                  <li><span class="idle-step-num">2</span><span>Hoặc gọi nội bộ đồng nghiệp khi cả hai đang trực tuyến (video hoặc chỉ thoại).</span></li>
                </ul>
                <div class="call-actions-row">
                  <button
                    type="button"
                    class="start-call-btn"
                    :disabled="isCallActive || !sameTenant(selectedIdentity) || !isUserOnline(selectedIdentity.id)"
                    @click="startCall(selectedIdentity.id, 'video')"
                  >
                    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="m16 13 5 3V8l-5 3V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2z"/></svg>
                    <span>Gọi video</span>
                  </button>
                  <button
                    type="button"
                    class="start-call-btn start-call-btn--secondary"
                    :disabled="isCallActive || !sameTenant(selectedIdentity) || !isUserOnline(selectedIdentity.id)"
                    @click="startCall(selectedIdentity.id, 'audio')"
                  >
                    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.81.36 1.6.68 2.34a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.74.32 1.53.55 2.34.68A2 2 0 0 1 22 16.92z"/></svg>
                    <span>Gọi thoại</span>
                  </button>
                </div>
              </div>

              <!-- Staff empty -->
              <div v-else class="idle-placeholder">
                <div class="hero-avatar-large hero-logo">S</div>
                <h2 class="idle-title">Sẵn sàng tư vấn</h2>
                <p class="idle-desc">Chọn đồng nghiệp bên trái, hoặc mở <strong>Khách chờ</strong> (góc dưới phải) khi có khách từ website.</p>
                <button type="button" class="btn-secondary-pill" @click="queuePanelOpen = true">
                  Mở khách chờ
                </button>
              </div>
            </div>
            </template>
          </section>

          <aside class="right-sidebar" v-if="showDetailPanel && isCallNav">
            <div class="profile-section">
              <div class="right-profile-avatar">{{ userInitials(selectedIdentity) }}</div>
              <div class="right-profile-name">{{ selectedIdentity.displayName }}</div>
              <div class="peer-status-block">
                <span :class="agentBadgeClassFor(selectedIdentity.id)">{{ agentBadgeLabelFor(selectedIdentity.id) }}</span>
              </div>
              <p class="peer-clinic-line">{{ clinicLabel(selectedIdentity.clinicId || selectedIdentity.tenantId) }}</p>
              <p class="peer-help-text">
                Gọi video hoặc thoại nội bộ giữa nhân viên cùng phòng. Khách từ website được phân công qua hàng chờ — không cần gọi tay.
              </p>
              <div class="call-actions-row" style="margin-top: 16px;">
                <button
                  type="button"
                  class="start-call-btn"
                  :disabled="isCallActive || !sameTenant(selectedIdentity) || !isUserOnline(selectedIdentity.id)"
                  @click="startCall(selectedIdentity.id, 'video')"
                >Gọi video</button>
                <button
                  type="button"
                  class="start-call-btn start-call-btn--secondary"
                  :disabled="isCallActive || !sameTenant(selectedIdentity) || !isUserOnline(selectedIdentity.id)"
                  @click="startCall(selectedIdentity.id, 'audio')"
                >Gọi thoại</button>
              </div>
            </div>
          </aside>
        </main>

        <!-- Queue dock (staff + manager) — only on Call workspace -->
        <div v-if="!isVisitor && isCallNav" class="queue-dock" :class="{ open: queuePanelOpen }">
          <button
            type="button"
            class="queue-dock-toggle"
            :aria-expanded="queuePanelOpen ? 'true' : 'false'"
            aria-controls="queue-dock-panel"
            @click="queuePanelOpen = !queuePanelOpen"
          >
            <span class="queue-dock-label">Khách chờ</span>
            <span class="queue-dock-badge" :class="{ hot: queueItems.length > 0 }">{{ queueItems.length }}</span>
            <span v-if="queueMineCount > 0" class="queue-dock-mine">{{ queueMineCount }} của bạn</span>
            <span class="queue-dock-chevron" aria-hidden="true">{{ queuePanelOpen ? '▾' : '▴' }}</span>
          </button>
          <div
            v-show="queuePanelOpen"
            id="queue-dock-panel"
            class="queue-panel queue-panel--dock"
            aria-label="Khách đang chờ tư vấn"
          >
            <div class="queue-panel-header">
              <span class="queue-panel-title">Khách đang chờ</span>
              <button type="button" class="queue-panel-close" @click="queuePanelOpen = false" aria-label="Thu gọn">✕</button>
            </div>
            <div v-if="!queueItems.length" class="queue-empty">
              {{ isManager ? 'Chưa có khách trong hàng chờ.' : 'Hiện không có khách chờ. Khi có, hệ thống sẽ mời bạn nhận máy.' }}
            </div>
            <div v-else class="queue-panel-list">
              <div v-for="item in queueItems" :key="item.id" class="queue-row">
                <div class="queue-row-avatar">
                  <img :src="guestAvatarUrl" alt="" />
                </div>
                <div class="queue-row-body">
                  <div class="queue-row-name">{{ formatQueueLabel(item) }}</div>
                  <div class="queue-row-meta">
                    {{ queueStatusVi(item.status) }}
                    · chờ {{ formatWaitSeconds(item.waitingSeconds) }}
                    <template v-if="item.assignedStaffId"> · phụ trách {{ item.assignedStaffId }}</template>
                    <template v-else> · chưa phân công</template>
                  </div>
                </div>
                <div class="queue-row-tags">
                  <span
                    :class="['queue-tag', item.status === 'Ringing' ? 'queue-tag--ringing' : 'queue-tag--queued']"
                  >{{ queueStatusVi(item.status) }}</span>
                  <span v-if="isQueueAssignedToMe(item)" class="queue-tag queue-tag--mine">Của bạn</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- POPUPS -->
        <div v-if="popupState === 'incoming'" class="modal-backdrop">
          <div class="call-popup-card">
            <div class="pulse-ring-avatar" :title="peerName">{{ peerAvatar }}</div>
            <h3 class="popup-title">{{ peerName }}</h3>
            <p class="popup-subtitle">{{ isEmbedPeer ? 'Khách từ website đang chờ — cuộc gọi dành cho bạn.' : 'Đang gọi video cho bạn…' }}</p>
            <div class="popup-action-buttons">
              <button type="button" class="popup-btn danger" @click="rejectCall">Từ chối</button>
              <button type="button" class="popup-btn success" @click="acceptCall">Nhận cuộc gọi</button>
            </div>
          </div>
        </div>

        <div v-if="popupState === 'ringing'" class="modal-backdrop">
          <div class="call-popup-card">
            <div class="pulse-ring-avatar" :title="peerName">{{ peerAvatar }}</div>
            <h3 class="popup-title">{{ peerName }}</h3>
            <p class="popup-subtitle">Đang đổ chuông…</p>
            <div class="popup-action-buttons">
              <button type="button" class="popup-btn danger" @click="cancelCall">Hủy cuộc gọi</button>
            </div>
          </div>
        </div>

        <div v-if="popupState === 'popup_blocked'" class="modal-backdrop">
          <div class="call-popup-card">
            <h3 class="popup-title">Trình duyệt chặn cửa sổ gọi</h3>
            <p class="popup-subtitle">Bấm nút bên dưới để mở cửa sổ video.</p>
            <div class="popup-action-buttons">
              <button type="button" class="popup-btn primary" @click="reopenCallWindow">Mở cuộc gọi</button>
              <button type="button" class="popup-btn secondary" @click="closePopup">Đóng</button>
            </div>
          </div>
        </div>

        <div v-if="popupState === 'rejected'" class="modal-backdrop">
          <div class="call-popup-card">
            <h3 class="popup-title">Cuộc gọi bị từ chối</h3>
            <p class="popup-subtitle">{{ peerName }} đã từ chối cuộc gọi.</p>
            <div class="popup-action-buttons">
              <button type="button" class="popup-btn primary" @click="closePopup">Đóng</button>
            </div>
          </div>
        </div>

        <div v-if="popupState === 'busy'" class="modal-backdrop">
          <div class="call-popup-card">
            <h3 class="popup-title">Đồng nghiệp đang bận</h3>
            <p class="popup-subtitle">Người này đang trong cuộc gọi khác. Thử lại sau.</p>
            <div class="popup-action-buttons">
              <button type="button" class="popup-btn primary" @click="closePopup">Đóng</button>
            </div>
          </div>
        </div>

        <div v-if="popupState === 'ended'" class="modal-backdrop">
          <div class="call-popup-card">
            <h3 class="popup-title">Cuộc gọi đã kết thúc</h3>
            <p class="popup-subtitle">Bạn có thể nhận khách mới từ hàng chờ.</p>
            <div class="popup-action-buttons">
              <button type="button" class="popup-btn primary" @click="closePopup">Đóng</button>
            </div>
          </div>
        </div>

        <div v-if="popupState === 'error'" class="modal-backdrop">
          <div class="call-popup-card">
            <h3 class="popup-title">Không thực hiện được</h3>
            <p class="popup-subtitle">{{ popupErrorMessage }}</p>
            <div class="popup-action-buttons">
              <button type="button" class="popup-btn primary" @click="closePopup">Đóng</button>
            </div>
          </div>
        </div>
      </div>
    `
  })
}
