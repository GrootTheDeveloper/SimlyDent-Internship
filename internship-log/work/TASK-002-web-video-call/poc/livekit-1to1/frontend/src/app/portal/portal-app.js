/**
 * @file app/portal/portal-app.js
 * Staff portal: login, contacts, queue, history, manager.
 */
import Vue from 'vue/dist/vue.esm.js'
import * as signalR from '@microsoft/signalr'

import {
  DEMO_PASSWORD_HINT,
  API_URL,
  HUB_PATH,
} from '../../shared/constants.js'
import {
  getAccessToken,
  setAuthSession,
  clearAuthSession,
  readCachedUser,
  authHeaders,
} from '../../shared/auth.js'
import { apiFetch } from '../../shared/api-client.js'
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
  formatViDateTime,
  formatWaitSeconds,
} from '../../shared/call-helpers.js'
import {
  readPreferredMediaHint,
  writePreferredMediaHint,
  clearPreferredMediaHint,
} from '../../shared/storage-helpers.js'

const GUEST_AVATAR_URL = '/assets/guest-avatar.svg'

/** Mount portal Vue on #app */
export function mountPortalApp() {
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
      /** Manager consultations (canonical media catalog) */
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
        history.replaceState(null, '', `?user=${encodeURIComponent(user.id)}`)
        await this.loadIdentities()
        const sameClinicPeers = this.identities.filter(i => i.id !== user.id)
        this.targetId = sameClinicPeers[0]?.id || ''
        await this.connectRealtime()
        if (String(user.role || '').toLowerCase() === 'manager') {
          await this.loadConsultations()
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

              <!-- Manager: consultations (canonical media catalog only) -->
              <div v-else-if="isManager" class="manager-library">
                <header class="library-header">
                  <div>
                    <p class="library-kicker">{{ clinicLabel(currentUser.clinicId || currentUser.tenantId) }} · Quản lý</p>
                    <h2 class="library-title">Thư viện tư vấn</h2>
                    <p class="library-desc">
                      Audio phiên (tự ghi) · clip răng · ảnh. Chỉ quản lý đúng phòng khám.
                    </p>
                  </div>
                  <div class="library-actions">
                    <button type="button" class="btn-secondary-pill" @click="queuePanelOpen = true">
                      Khách chờ{{ queueItems.length ? ' (' + queueItems.length + ')' : '' }}
                    </button>
                    <button
                      type="button"
                      class="btn-secondary-pill"
                      :disabled="consultationsLoading"
                      @click="loadConsultations()"
                    >
                      {{ consultationsLoading ? 'Đang tải…' : 'Làm mới' }}
                    </button>
                  </div>
                </header>

                <h3 class="library-section-title" style="margin: 16px 0 8px; font-size: 15px;">Phiên tư vấn</h3>
                <p v-if="consultationsError" class="library-error">{{ consultationsError }}</p>
                <div v-if="consultationsLoading && !consultations.length" class="library-empty">
                  Đang tải consultations…
                </div>
                <div v-else-if="!consultations.length" class="library-empty">
                  <p class="library-empty-title">Chưa có phiên tư vấn</p>
                  <p class="library-empty-desc">Sau khi staff Accept, phiên được tạo; audio phiên tự ghi. Clip răng / ảnh do NV chủ động — quản lý tải tại đây khi Ready.</p>
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
