/**
 * @file app/call-window/call-window-app.js
 * Standalone /call/:id surface ? MediaEngine for LiveKit.
 */
import Vue from 'vue/dist/vue.esm.js'
import * as signalR from '@microsoft/signalr'
import {
  LocalVideoTrack,
  Track,
  VideoPresets
} from 'livekit-client'

import {
  applyVideoDisplayFit,
} from '../../domain/media/media-utils.js'
import {
  MediaEngineEvent,
  createMediaEngine,
} from '../../domain/media/media-engine.js'
import {
  readLocalMediaState,
  resolveRemoteParticipantIdentity,
  resolveRemoteVideoTrackSid,
  attachTrackElement,
  startRoomAudio,
  replayAllAudioElements,
  subscribeAvailableRemoteTracks,
} from '../../domain/media/livekit-adapter.js'
import {
  CameraRequestAction,
  CameraRequestState,
  isMediaModeMessage,
  isCameraRequestMessage,
  isObsoleteModeSyncMessage,
  normalizeCameraRequestAction,
  publishCameraRequest,
  parseDataPayload,
  reduceCameraRequestState,
  shouldJoinAudioOnly,
  desiredCameraFromInitialMode,
} from '../../domain/media/media-mode.js'
import {
  readConnectionStats,
  readTrackStats,
  toTelemetryVideoStats,
  clientEnvironment
} from '../../domain/quality/telemetry.js'
import {
  DEMO_PASSWORD_HINT,
  API_URL,
  HUB_PATH,
} from '../../shared/constants.js'
import {
  getAccessToken,
  readCachedUser,
  authHeaders,
} from '../../shared/auth.js'
import { apiFetch } from '../../shared/api-client.js'
import {
  clinicIdOf,
  isEmbedVisitorId,
  peerLabel,
  peerAvatarText,
  normalizeMediaMode,
  callStatusVi,
  formatViDateTime,
  createClientSessionId,
} from '../../shared/call-helpers.js'
import {
  readPreferredMediaHint,
  writePreferredMediaHint,
} from '../../shared/storage-helpers.js'
import { handleCapturePhotoCommand } from '../../domain/consultation/snapshots.js'
import { rtLog, safeWarn, safeError } from '../../shared/safe-log.js'

const GUEST_AVATAR_URL = '/assets/guest-avatar.svg'

const initialQualityStats = () => ({
  incomingResolution: 'Ch?a c?',
  incomingFps: 0,
  incomingBitrateKbps: 0,
  packetLossPercent: 0,
  jitterMs: 0,
  roundTripTimeMs: 0,
  outgoingResolution: 'Ch?a c?',
  outgoingFps: 0,
  outgoingBitrateKbps: 0,
  qualityLimitationReason: 'none',
  codec: 'Ch?a c?'
})

/** Mount call-window Vue on #app */
export function mountCallWindowApp(opts = {}) {
  const pathName = window.location.pathname
  const callId = opts.callId || pathName.replace('/call/', '').trim()
  const cached = readCachedUser()
  const callQuery = new URLSearchParams(window.location.search)
  const userId = cached?.id || callQuery.get('user') || ''
  let preferredMediaHint = opts.preferredMediaHint
  if (!preferredMediaHint) {
    preferredMediaHint = normalizeMediaMode(callQuery.get('media') || 'video')
    const storedHint = readPreferredMediaHint()
    if (storedHint && !callQuery.get('media')) preferredMediaHint = storedHint
  }

  new Vue({
    el: '#app',
    data: {
      callId,
      userId,
      /**
       * Join preference only (URL / server initialMediaMode).
       * After media connects, never used as a runtime "session mode".
       */
      preferredMediaMode: preferredMediaHint,
      /**
       * Local desired camera after connect / for reconnect.
       * Independent of remote camera and of initialMediaMode once mediaSessionStarted.
       */
      desiredCameraEnabled: preferredMediaHint !== 'audio',
      /** True after first successful LiveKit connect this window lifetime. */
      mediaSessionStarted: false,
      currentUser: cached || null,
      identities: [],
      call: null,

      hub: null,
      room: null,
      /** @type {import('../../domain/media/media-engine.js').MediaEngine|null} */
      mediaEngine: null,
      localTracks: [],
      /** Stops canvas portrait pipeline (if used) */
      localMediaCleanup: null,
      connected: false,
      joining: false,
      mediaPermissionState: 'idle',
      /** Derived from MediaEngine / LiveKit publications after ops complete. */
      cameraEnabled: preferredMediaHint !== 'audio',
      microphoneEnabled: true,
      cameraToggleBusy: false,
      intentionalLeave: false,
      reconnectNotice: '',
      /** Remote camera track currently attached / unmuted (LiveKit-derived). */
      remoteVideoConnected: false,
      needsAudioPermission: false,
      /**
       * Camera request FSM — application state only (LiveKit has no request semantic).
       * idle | sent | received | accepted | rejected | expired
       */
      cameraRequestState: CameraRequestState.Idle,
      cameraRequestBusy: false,
      _cameraRequestExpireTimer: null,
      /** Consultation media (M2–M4) — secondary tools, not primary controls */
      dentalClipBusy: false,
      dentalClipStatus: 'Idle',
      dentalClipAssetId: null,
      /** Filled from /media-state poll; CallView also carries autoAudioStatus after Accept. */
      _polledAutoAudioStatus: '',
      _mediaStateTimer: null,
      /** Ready clips completed this call (staff may start many sequential clips). */
      dentalClipReadyCount: 0,
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
      showClinicalTools: false,
      showMoreMenu: false,
      callDurationSeconds: 0,
      _callDurationTimer: null,

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
      /** Presentation only: neither side has remote video track visible. */
      showRemotePlaceholder() {
        return this.mediaPermissionState === 'connected' && !this.remoteVideoConnected
      },
      /** Large phone-style stage when remote has no camera (not a global session mode). */
      showVoiceStage() {
        return (
          this.mediaPermissionState === 'connected' &&
          !this.remoteVideoConnected &&
          this.call?.status === 'Accepted'
        )
      },
      remotePlaceholderText() {
        if (this.isEmbedPeer) return 'Khách đang tắt camera'
        return 'Đối phương đang tắt camera'
      },
      mediaSetupLabel() {
        const wantCam = this.desiredCameraEnabled
        if (this.mediaPermissionState === 'requesting') {
          return wantCam
            ? 'Đang xin quyền camera và micro…'
            : 'Đang xin quyền micro…'
        }
        if (this.mediaPermissionState === 'connecting') {
          return wantCam ? 'Đang kết nối…' : 'Đang kết nối thoại…'
        }
        if (this.mediaPermissionState === 'reconnecting') {
          return this.reconnectNotice || 'Đang kết nối lại media…'
        }
        if (this.mediaPermissionState === 'error') {
          return this.error || 'Không kết nối được hình ảnh / âm thanh'
        }
        if (this.mediaPermissionState === 'connected' && !this.remoteVideoConnected) {
          return this.isEmbedPeer
            ? 'Khách đang tắt camera (vẫn nghe được tiếng).'
            : 'Đối phương đang tắt camera.'
        }
        return wantCam ? 'Đang chuẩn bị camera và micro…' : 'Đang chuẩn bị micro…'
      },
      callStatusLabel() {
        if (!this.call) return 'Đang tải…'
        return callStatusVi(this.call.status)
      },
      callDurationLabel() {
        const s = Math.max(0, this.callDurationSeconds | 0)
        const m = Math.floor(s / 60)
        const r = s % 60
        return `${m}:${String(r).padStart(2, '0')}`
      },
      connectionHint() {
        if (this.mediaPermissionState === 'reconnecting') return 'Đang kết nối lại…'
        if (this.mediaPermissionState === 'error') return 'Mất media — cuộc gọi vẫn mở'
        if (this.mediaPermissionState === 'connected') return 'Đã kết nối'
        if (this.mediaPermissionState === 'connecting' || this.mediaPermissionState === 'requesting') {
          return 'Đang kết nối…'
        }
        return this.callStatusLabel
      },
      qualityBadge() {
        const resolution = this.qualityStats.incomingResolution
        if (/1280×720|720×1280|1920×1080|1080×1920/.test(resolution)) return 'HD'
        if (/640×360|360×640/.test(resolution)) return 'SD'
        return this.remoteVideoConnected ? 'LOW' : '--'
      },
      isManagerRole() {
        return String(this.currentUser?.role || this.userRole || '').toLowerCase() === 'manager'
      },
      incomingCameraRequest() {
        return this.cameraRequestState === CameraRequestState.Received
      },
      outgoingCameraRequest() {
        return this.cameraRequestState === CameraRequestState.Sent
      },
      /** Product: session audio is always auto (CallAudio). */
      autoAudioStatus() {
        return this.call?.autoAudioStatus || this._polledAutoAudioStatus || 'Idle'
      },
      autoAudioLabel() {
        const s = this.autoAudioStatus
        if (s === 'Recording') return 'Đang ghi âm'
        if (s === 'Finalizing') return 'Đang lưu audio…'
        if (s === 'Ready') return 'Đã có audio phiên'
        if (s === 'Failed') return 'Ghi âm phiên lỗi'
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
      this.stopMediaStatePolling()
      this.stopCallDurationTimer()
      this.clearCameraRequestExpireTimer()
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
       * Authoritative *initial* media preference from server CallView.
       * Only seeds join preference / desiredCamera before the first media session.
       * Never resets runtime camera after mediaSessionStarted (reconnect-safe).
       */
      applyAuthoritativeMediaMode(call) {
        const serverMode = call?.initialMediaMode || call?.InitialMediaMode
        // Prefer server when present; never let a stale sessionStorage "video" win over Audio.
        if (serverMode) {
          this.preferredMediaMode = normalizeMediaMode(serverMode)
        } else if (!this.preferredMediaMode) {
          this.preferredMediaMode = 'video'
        }
        if (!this.mediaSessionStarted) {
          this.desiredCameraEnabled = desiredCameraFromInitialMode(this.preferredMediaMode)
          this.cameraEnabled = this.desiredCameraEnabled
          // Keep URL/session cache aligned so re-open/popup does not flip to video
          try {
            writePreferredMediaHint(this.preferredMediaMode)
          } catch { /* ignore */ }
        }
        try {
          sessionStorage.setItem('simlydent_preferred_media', this.preferredMediaMode)
        } catch { /* ignore */ }
        rtLog('initial_media_resolved', {
          preferred: this.preferredMediaMode,
          desiredCamera: this.desiredCameraEnabled,
          mediaSessionStarted: this.mediaSessionStarted,
          server: serverMode || null,
          urlHint: preferredMediaHint
        })
      },
      startCallDurationTimer() {
        this.stopCallDurationTimer()
        this.callDurationSeconds = 0
        this._callDurationTimer = setInterval(() => {
          this.callDurationSeconds += 1
        }, 1000)
      },
      stopCallDurationTimer() {
        if (this._callDurationTimer) {
          clearInterval(this._callDurationTimer)
          this._callDurationTimer = null
        }
      },
      clearCameraRequestExpireTimer() {
        if (this._cameraRequestExpireTimer) {
          clearTimeout(this._cameraRequestExpireTimer)
          this._cameraRequestExpireTimer = null
        }
      },
      setCameraRequestState(event) {
        this.cameraRequestState = reduceCameraRequestState(this.cameraRequestState, event)
        if (this.cameraRequestState === CameraRequestState.Accepted ||
            this.cameraRequestState === CameraRequestState.Rejected ||
            this.cameraRequestState === CameraRequestState.Expired) {
          // Terminal request outcomes → idle after a short UI beat
          const snap = this.cameraRequestState
          setTimeout(() => {
            if (this.cameraRequestState === snap) {
              this.cameraRequestState = CameraRequestState.Idle
            }
          }, 1200)
        }
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
            this.mediaSessionStarted = true
            this.syncRoomFromEngine()
            this.reconcileLocalMediaUi()
            this.attachAvailableRemoteTracks()
            this.$nextTick(() => {
              if (this.cameraEnabled) this.attachLocalVideo()
            })
            this.startQualityMonitoring()
            if (!this._callDurationTimer) this.startCallDurationTimer()
            break
          case MediaEngineEvent.Reconnecting:
            // Media blip only — business call stays Accepted
            this.mediaPermissionState = 'reconnecting'
            this.reconnectNotice = 'Mạng media đang reconnect… cuộc gọi vẫn mở.'
            break
          case MediaEngineEvent.Reconnected:
            this.mediaPermissionState = 'connected'
            this.reconnectNotice = ''
            this.syncRoomFromEngine()
            this.reconcileLocalMediaUi()
            // Restore local camera from desired state if SDK dropped it
            if (this.desiredCameraEnabled && !this.cameraEnabled) {
              this.ensureCameraEnabled(true).catch(() => {})
            } else if (!this.desiredCameraEnabled && this.cameraEnabled) {
              this.ensureCameraEnabled(false).catch(() => {})
            }
            this.attachAvailableRemoteTracks()
            this.$nextTick(() => {
              if (this.cameraEnabled) this.attachLocalVideo()
            })
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
            // Keep desiredCameraEnabled — rejoin must restore runtime intent, not initialMediaMode
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
            // Soft notice when join fell back to audio-only (common: "Could not start video source")
            if (
              payload?.note === 'audio-only' &&
              payload?.lastError &&
              this.preferredMediaMode !== 'audio'
            ) {
              this.error = payload.lastError
            }
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
            const msg = parseDataPayload(payload.payload)
            if (!msg) break
            if (isMediaModeMessage(msg)) {
              this.handleCameraRequestMessage(msg)
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
          // Seed preferred only before first media session — never overwrite desiredCamera mid-call
          if (this.call && !this.mediaSessionStarted) {
            this.applyAuthoritativeMediaMode(this.call)
          }

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
          // audioOnly from desiredCamera / initial preference — NOT a global session mode
          const audioOnly = shouldJoinAudioOnly({
            mediaSessionStarted: this.mediaSessionStarted,
            desiredCameraEnabled: this.desiredCameraEnabled,
            initialMediaMode: this.preferredMediaMode
          })
          rtLog('joinRoom_media', {
            audioOnly,
            desiredCamera: this.desiredCameraEnabled,
            mediaSessionStarted: this.mediaSessionStarted,
            preferred: this.preferredMediaMode,
            via: 'MediaEngine'
          })

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
          this.mediaSessionStarted = true
          this.reconcileLocalMediaUi()
          if (this.mediaPermissionState !== 'error') {
            this.mediaPermissionState = 'connected'
          }
          this.startMediaStatePolling()

          // Reconcile actual publications to desired local camera (independent of peer)
          if (this.desiredCameraEnabled) {
            try {
              await this.mediaEngine.ensureCameraEnabled(true)
            } catch (e) {
              safeWarn('join restore camera', e)
              this.error = e?.message || 'Không bật được camera — micro vẫn hoạt động.'
            }
          } else {
            try {
              await this.mediaEngine.ensureCameraEnabled(false)
            } catch { /* ignore */ }
          }
          this.reconcileLocalMediaUi()
          this.$nextTick(() => {
            if (this.cameraEnabled) this.attachLocalVideo()
          })
          // No mode_sync — remote UI derives video from LiveKit publications
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
            ? (e?.message || 'Không bật được camera.')
            : (e?.message || 'Không tắt được camera.')
          return this.cameraEnabled
        }
      },
      /**
       * Local camera toggle only — never changes peer camera and never
       * broadcasts a global session mode.
       */
      async toggleCamera() {
        if (!this.mediaEngine?.room || this.cameraToggleBusy) return
        this.cameraToggleBusy = true
        this.error = ''
        try {
          const next = !this.cameraEnabled
          this.desiredCameraEnabled = next
          const ok = await this.ensureCameraEnabled(next)
          if (ok !== next) {
            // Revert desire if operation failed
            this.desiredCameraEnabled = this.cameraEnabled
          }
        } finally {
          this.cameraToggleBusy = false
        }
      },
      /**
       * Business request: ask remote participant to enable *their* camera.
       * Does not change local camera.
       */
      async requestPeerCamera() {
        if (this.cameraRequestBusy || this.outgoingCameraRequest) return
        const room = this.mediaEngine?.room || this.room
        if (!room) return
        this.cameraRequestBusy = true
        try {
          this.setCameraRequestState('send')
          this.clearCameraRequestExpireTimer()
          await publishCameraRequest(room, CameraRequestAction.Request, {
            from: this.userId
          })
          this._cameraRequestExpireTimer = setTimeout(() => {
            if (this.cameraRequestState === CameraRequestState.Sent) {
              this.setCameraRequestState('expire')
              this.error = 'Yêu cầu bật camera hết hạn — đối phương chưa phản hồi.'
            }
          }, 45000)
        } finally {
          this.cameraRequestBusy = false
        }
      },
      /** Patient/staff accepts: enable *local* camera only; notify peer. */
      async acceptCameraRequest() {
        if (this.cameraRequestBusy) return
        this.cameraRequestBusy = true
        this.error = ''
        try {
          this.desiredCameraEnabled = true
          const ok = await this.ensureCameraEnabled(true)
          if (!ok) {
            this.desiredCameraEnabled = this.cameraEnabled
            this.error = this.error || 'Không bật được camera.'
            return
          }
          this.setCameraRequestState('accept')
          this.clearCameraRequestExpireTimer()
          const room = this.mediaEngine?.room || this.room
          await publishCameraRequest(room, CameraRequestAction.Accept, {
            from: this.userId
          })
          this.$nextTick(() => this.attachLocalVideo())
        } finally {
          this.cameraRequestBusy = false
        }
      },
      /** Decline request — no local or remote camera side effects. */
      async rejectCameraRequest() {
        this.setCameraRequestState('reject')
        this.clearCameraRequestExpireTimer()
        const room = this.mediaEngine?.room || this.room
        await publishCameraRequest(room, CameraRequestAction.Reject, {
          from: this.userId
        })
        this.setCameraRequestState('clear')
      },
      /**
       * Handle camera_request (and legacy media_mode request/accept/reject).
       * Obsolete switch_audio / switch_video / mode_sync never mutate local camera.
       */
      handleCameraRequestMessage(msg) {
        if (!msg || msg.from === this.userId) return

        if (isObsoleteModeSyncMessage(msg)) {
          // Legacy peers may still send these — ignore for local media.
          // Remote video appearance is derived from LiveKit publications only.
          rtLog('ignored_legacy_mode_sync', { action: msg.action, mode: msg.mode })
          return
        }

        if (!isCameraRequestMessage(msg) && !isMediaModeMessage(msg)) return

        const action = normalizeCameraRequestAction(msg.action)
        if (!action) {
          rtLog('ignored_unknown_media_msg', { type: msg.type, action: msg.action })
          return
        }

        if (action === CameraRequestAction.Request) {
          this.setCameraRequestState('receive')
          return
        }
        if (action === CameraRequestAction.Accept) {
          // Peer accepted our request — their camera will appear via LiveKit.
          // Do NOT enable our local camera.
          this.clearCameraRequestExpireTimer()
          this.setCameraRequestState('accept')
          return
        }
        if (action === CameraRequestAction.Reject) {
          this.clearCameraRequestExpireTimer()
          this.setCameraRequestState('reject')
          this.error = 'Đối phương từ chối bật camera.'
        }
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
      async refreshMediaState() {
        if (!this.callId) return
        try {
          const res = await apiFetch(`/api/calls/${this.callId}/media-state`, { headers: authHeaders() })
          if (!res.ok) return
          const body = await res.json()
          // MediaStateView: autoAudioStatus, activeDentalClipStatus, activeDentalClipAssetId, assets
          const audio = body.autoAudioStatus || body.audioStatus
          if (audio) {
            this._polledAutoAudioStatus = audio
            if (this.call) this.call = { ...this.call, autoAudioStatus: audio }
          }
          const clipSt = body.activeDentalClipStatus || body.clipStatus
          if (clipSt) this.dentalClipStatus = clipSt
          const clipId = body.activeDentalClipAssetId ?? body.activeClipAssetId
          if (clipId) this.dentalClipAssetId = clipId
          if (clipSt === 'Idle') this.dentalClipAssetId = null
          const items = body.assets || body.items || []
          this.dentalClipReadyCount = items.filter(
            (x) => x.kind === 'DentalVideoClip' && (x.status === 'Ready' || x.status === 'Finalizing')
          ).length
        } catch {
          /* ignore poll errors */
        }
      },
      startMediaStatePolling() {
        this.stopMediaStatePolling()
        this.refreshMediaState()
        this._mediaStateTimer = setInterval(() => this.refreshMediaState(), 4000)
      },
      stopMediaStatePolling() {
        if (this._mediaStateTimer) {
          clearInterval(this._mediaStateTimer)
          this._mediaStateTimer = null
        }
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
            // After finalize, staff can start another clip (multi-clip per call).
            await this.refreshMediaState()
          } else {
            const patientIdentity = this.resolvePatientParticipantIdentity()
            if (!patientIdentity) throw new Error('Chưa thấy bệnh nhân trong room (cần camera remote)')
            const trackHint = this.resolvePatientVideoTrackSid()
            const remotePub = this.room
              ? [...this.room.remoteParticipants.values()][0]
              : null
            const settings = remotePub
              ? [...(remotePub.videoTrackPublications?.values?.() || [])][0]
                ?.track?.mediaStreamTrack?.getSettings?.()
              : null
            // Round getSettings() floats — backend used to reject 29.97 as int ("Invalid JSON body")
            const toInt = (v) => {
              const n = Number(v)
              return Number.isFinite(n) && n > 0 ? Math.round(n) : null
            }
            const payload = {
              patientParticipantIdentity: patientIdentity,
              patientVideoTrackSidHint: trackHint || null,
              actualWidth: toInt(settings?.width),
              actualHeight: toInt(settings?.height),
              actualFrameRate: toInt(settings?.frameRate)
            }
            const res = await apiFetch(`/api/calls/${this.callId}/video-clips/start`, {
              method: 'POST',
              headers: authHeaders({ 'Content-Type': 'application/json' }),
              body: JSON.stringify(payload)
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
      async endCall() {
        // Prevent double-tap / concurrent hangup paths hanging the UI
        if (this._endingCall) return
        this._endingCall = true
        this.intentionalLeave = true
        try {
          // Never block hangup on telemetry (was a source of "tắt call không được")
          const sideWork = [
            this.flushQualityLog().catch(err => console.warn('flush quality on end', err))
          ]
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
        this.stopCallDurationTimer()
        this.clearCameraRequestExpireTimer()
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
        this.clearCameraRequestExpireTimer()
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
        // Keep desiredCameraEnabled + mediaSessionStarted so rejoin restores runtime intent
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
              <div class="call-header-status">
                <span>{{ connectionHint }}</span>
                <span v-if="call && call.status === 'Accepted' && mediaPermissionState === 'connected'" class="call-duration"> · {{ callDurationLabel }}</span>
              </div>
            </div>
          </div>
          <div class="call-header-actions">
            <span
              v-if="autoAudioStatus === 'Recording'"
              class="recording-indicator"
              title="Phiên đang được ghi âm tự động"
            ><span></span> Đang ghi âm</span>
            <button
              v-if="needsAudioPermission"
              type="button"
              class="audio-fallback-btn"
              @click="enableAudioPlayback"
            >Bật tiếng</button>
            <div class="call-more-wrap">
              <button
                type="button"
                class="call-more-btn"
                title="Thêm"
                @click="showMoreMenu = !showMoreMenu; showClinicalTools = false; showQualityPanel = false"
              >⋯</button>
              <div v-if="showMoreMenu" class="call-more-menu" @click.stop>
                <button type="button" class="call-more-item" @click="showQualityPanel = true; showMoreMenu = false">
                  Chi tiết kết nối ({{ qualityBadge }})
                </button>
                <button
                  v-if="mediaPermissionState === 'connected' && !isManagerRole"
                  type="button"
                  class="call-more-item"
                  @click="showClinicalTools = !showClinicalTools; showMoreMenu = false"
                >Công cụ tư vấn</button>
                <button type="button" class="call-more-item" @click="copyCallId(); showMoreMenu = false">
                  Sao chép mã cuộc gọi
                </button>
              </div>
            </div>
          </div>
        </header>

        <main class="call-window-body" @click="showMoreMenu = false">
          <!-- Connecting / Waiting State -->
          <div v-if="!call || call.status !== 'Accepted'" class="call-connecting-state">
            <div class="pulse-ring-avatar" :title="peerName">{{ peerAvatar }}</div>
            <h2>{{ peerName }}</h2>
            <p v-if="call && call.status === 'Ringing'">{{ call.callerId === userId ? 'Đang đổ chuông…' : 'Cuộc gọi đến — vui lòng chờ…' }}</p>
            <p v-else-if="call">{{ callStatusLabel }}</p>
            <p v-else>Đang kết nối…</p>
          </div>

          <!-- Unified in-call surface (audio vs video = track state, not two machines) -->
          <div v-else class="call-video-grid" :class="{ 'call-voice-stage': showVoiceStage }">
            <!-- Voice presentation when remote has no video (not a global session mode) -->
            <div v-if="showVoiceStage" class="voice-stage" aria-label="Cuộc gọi">
              <div class="voice-stage-avatar" :title="peerName">
                <img v-if="isEmbedPeer" :src="guestAvatarUrl" alt="" />
                <span v-else>{{ peerAvatar }}</span>
              </div>
              <div class="voice-stage-name">{{ peerName }}</div>
              <div class="voice-stage-meta">
                <span class="audio-live-dot"></span>
                {{ callDurationLabel }} · {{ remotePlaceholderText }}
              </div>
            </div>

            <div class="remote-video-container" ref="remoteMedia" :class="{ 'is-voice-underlay': showVoiceStage }">
              <div
                v-if="showRemotePlaceholder && !showVoiceStage"
                class="remote-avatar-placeholder"
              >
                <img v-if="isEmbedPeer" :src="guestAvatarUrl" alt="Khách" />
                <div v-else class="initials-avatar">{{ peerAvatar }}</div>
                <p>{{ remotePlaceholderText }}</p>
              </div>
              <span
                v-else-if="mediaPermissionState !== 'connected'"
                class="remote-video-status"
              >{{ mediaSetupLabel }}</span>
            </div>

            <!-- Local PiP only when local camera is actually on -->
            <div
              class="local-video-container"
              ref="localMedia"
              :class="{ 'is-hidden-stage': !cameraEnabled }"
            ></div>
            <div ref="remoteAudio"></div>

            <!-- Camera request (business interaction — not session mode sync) -->
            <div v-if="incomingCameraRequest" class="media-mode-banner">
              <p>Tư vấn viên muốn bạn <strong>bật camera</strong> để hỗ trợ tư vấn.</p>
              <div class="media-mode-banner-actions">
                <button type="button" class="media-mode-btn primary" :disabled="cameraRequestBusy" @click="acceptCameraRequest">Bật camera</button>
                <button type="button" class="media-mode-btn" :disabled="cameraRequestBusy" @click="rejectCameraRequest">Để sau</button>
              </div>
            </div>
            <div v-else-if="outgoingCameraRequest" class="media-mode-banner soft">
              <p>Đã gửi yêu cầu bật camera — đang chờ phản hồi…</p>
              <button type="button" class="media-mode-btn" @click="setCameraRequestState('clear')">Ẩn</button>
            </div>

            <!-- Secondary: clinical tools -->
            <aside v-if="showClinicalTools && !isManagerRole" class="clinical-tools-panel" aria-label="Công cụ tư vấn">
              <div class="clinical-tools-title">Công cụ tư vấn</div>
              <div class="clinical-tools-row">
                <button
                  type="button"
                  class="clinical-tool-btn"
                  :disabled="dentalClipBusy || dentalClipStatus === 'Finalizing' || mediaPermissionState !== 'connected'"
                  @click="toggleDentalClip"
                >
                  {{ dentalClipStatus === 'Recording' ? 'Dừng clip' : 'Quay clip răng' }}
                </button>
                <button
                  type="button"
                  class="clinical-tool-btn"
                  :disabled="photoBusy || mediaPermissionState !== 'connected'"
                  @click="requestPhoto"
                >Chụp ảnh</button>
              </div>
              <p class="clinical-tools-meta">
                <span v-if="dentalClipStatus === 'Recording'">● Đang quay clip</span>
                <span v-else-if="dentalClipReadyCount > 0">{{ dentalClipReadyCount }} clip sẵn sàng</span>
                <span v-if="photoStatus"> · {{ photoStatus }}</span>
                <span v-if="!dentalClipReadyCount && dentalClipStatus !== 'Recording' && !photoStatus">Clip / ảnh lưu vào thư viện tư vấn</span>
              </p>
              <button type="button" class="clinical-tools-close" @click="showClinicalTools = false">Đóng</button>
            </aside>

            <section v-if="showQualityPanel" class="quality-panel" aria-label="Chi tiết kết nối">
              <div class="quality-panel-title">Chi tiết kết nối <span class="quality-auto-hint">(hỗ trợ kỹ thuật)</span></div>
              <p class="quality-call-id" title="Mã cuộc gọi">
                Mã:
                <button type="button" class="quality-call-id-btn" @click="copyCallId">{{ callId }}</button>
              </p>
              <dl>
                <div><dt>Hình nhận</dt><dd>{{ qualityStats.incomingResolution }} · {{ qualityStats.incomingFps }} fps</dd></div>
                <div><dt>Bitrate nhận</dt><dd>{{ qualityStats.incomingBitrateKbps }} kbps</dd></div>
                <div><dt>Hình gửi</dt><dd>{{ qualityStats.outgoingResolution }} · {{ qualityStats.outgoingFps }} fps</dd></div>
                <div><dt>Bitrate gửi</dt><dd>{{ qualityStats.outgoingBitrateKbps }} kbps</dd></div>
                <div><dt>Mất gói</dt><dd>{{ qualityStats.packetLossPercent }}%</dd></div>
                <div><dt>RTT</dt><dd>{{ qualityStats.roundTripTimeMs }} ms</dd></div>
                <div><dt>Codec</dt><dd>{{ qualityStats.codec }}</dd></div>
                <div><dt>Hạn chế</dt><dd>{{ qualityStats.qualityLimitationReason }}</dd></div>
              </dl>
              <div class="quality-export-actions">
                <button type="button" class="quality-export-primary" @click="downloadQualityLog('csv')">Tải báo cáo</button>
                <button type="button" class="quality-export-end" @click="endCallAndExport">Kết thúc và tải</button>
                <button type="button" class="quality-export-primary" style="background:transparent;border-color:rgba(255,255,255,.2)" @click="showQualityPanel = false">Đóng</button>
              </div>
            </section>

            <!-- Primary controls: mic, camera, request camera, hangup -->
            <div class="call-window-controls">
              <button
                v-if="mediaPermissionState === 'connected'"
                type="button"
                :class="['ctrl-btn', !microphoneEnabled && 'off']"
                @click="toggleMicrophone"
                :title="microphoneEnabled ? 'Tắt micro' : 'Bật micro'"
                :aria-label="microphoneEnabled ? 'Tắt micro' : 'Bật micro'"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3M8 22h8"/></svg>
              </button>
              <button
                v-if="mediaPermissionState === 'connected'"
                type="button"
                :class="['ctrl-btn', !cameraEnabled && 'off']"
                :disabled="cameraToggleBusy"
                @click="toggleCamera"
                :title="cameraEnabled ? 'Tắt camera của tôi' : 'Bật camera của tôi'"
                :aria-label="cameraEnabled ? 'Tắt camera của tôi' : 'Bật camera của tôi'"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m16 13 5 3V8l-5 3V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2z"/></svg>
              </button>
              <button
                v-if="mediaPermissionState === 'connected' && !remoteVideoConnected"
                type="button"
                class="ctrl-text-btn secondary"
                :disabled="cameraRequestBusy || outgoingCameraRequest"
                @click="requestPeerCamera"
                title="Gửi yêu cầu — không bật camera của bạn"
              >{{ outgoingCameraRequest ? 'Đang chờ…' : 'Yêu cầu khách bật camera' }}</button>
              <button
                v-if="mediaPermissionState === 'connected' && !isManagerRole"
                type="button"
                class="ctrl-btn tools-toggle"
                :class="{ active: showClinicalTools }"
                @click="showClinicalTools = !showClinicalTools; showMoreMenu = false"
                title="Công cụ tư vấn"
                aria-label="Công cụ tư vấn"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
              </button>
              <button
                v-if="mediaPermissionState === 'error'"
                type="button"
                class="start-call-btn"
                style="padding: 8px 16px; font-size: 13px;"
                @click="rejoinMedia"
              >Tham gia lại media</button>
              <button type="button" class="ctrl-btn danger" @click="endCall" title="Kết thúc cuộc gọi" aria-label="Kết thúc cuộc gọi">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.68 13.31a16 16 0 0 0 6 6l2-2a2 2 0 0 1 2-.48c.68.23 1.37.39 2.08.48A2 2 0 0 1 24 19.3V22a2 2 0 0 1-2.18 2A19.8 19.8 0 0 1 4.55 6.73 2 2 0 0 1 6.53 4.55h2.7a2 2 0 0 1 2 1.72c.09.71.25 1.4.48 2.08a2 2 0 0 1-.47 2zM23 1 1 23"/></svg>
              </button>
            </div>
          </div>
        </main>

        <div class="toast-error" v-if="error" @click="error = ''">{{ error }}</div>
      </div>
    `
  })
}
