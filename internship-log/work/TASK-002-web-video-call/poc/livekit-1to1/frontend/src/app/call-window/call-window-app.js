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
  MediaConnectionState,
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
  recordingModeLabel,
  formatViDateTime,
  createClientSessionId,
} from '../../shared/call-helpers.js'
import {
  readPreferredMediaHint,
  writePreferredMediaHint,
} from '../../shared/storage-helpers.js'
import { handleCapturePhotoCommand } from '../../domain/consultation/snapshots.js'

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

function rtLog(event, detail) {
  const ts = new Date().toISOString()
  const extra = detail !== undefined ? ` ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''
  console.info(`[rt ${ts}] ${event}${extra}`)
}

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
}
