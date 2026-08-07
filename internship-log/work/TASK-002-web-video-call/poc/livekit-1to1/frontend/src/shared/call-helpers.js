/**
 * @file shared/call-helpers.js
 * @description Pure helper functions for call/identity display and status formatting.
 *
 * Ownership: shared
 * Dependencies: shared/constants.js
 *
 * Rules:
 * - No DOM access
 * - No LiveKit imports
 * - No Vue imports
 * - Pure functions only — same input always produces same output
 */

import { TERMINAL_CALL_STATUSES, MediaMode, AgentState } from './constants.js'

// ---------------------------------------------------------------------------
// Identity / participant helpers
// ---------------------------------------------------------------------------

/** Canonical clinic id from auth user DTO (clinicId preferred; tenantId is legacy alias). */
export function clinicIdOf(userOrIdentity) {
  return userOrIdentity?.clinicId || userOrIdentity?.tenantId || ''
}

/** Embed visitors use CallerId = visitor:{sessionId} — too long for staff UI. */
export function isEmbedVisitorId(id) {
  return typeof id === 'string' && id.toLowerCase().startsWith('visitor:')
}

/** Short stable code from embed session id (first 6 hex chars). */
export function visitorShortCode(id) {
  if (!isEmbedVisitorId(id)) return ''
  const raw = id.slice('visitor:'.length).replace(/[^a-fA-F0-9]/g, '')
  return (raw.slice(0, 6) || '------').toUpperCase()
}

/**
 * Human label for staff surfaces. Never show full visitor:{guid} as the title.
 * @param {string} id
 * @param {{ displayName?: string } | null} [known]
 */
export function peerLabel(id, known = null) {
  if (known?.displayName && known.displayName !== id) return known.displayName
  if (isEmbedVisitorId(id)) return `Khách #${visitorShortCode(id)}`
  if (!id) return '—'
  // Demo queue visitors VA/VB without directory hit
  if (/^V[A-Z0-9]+$/i.test(id)) return `Khách ${id.toUpperCase()}`
  return id
}

/** Compact avatar initials (never the full visitor GUID). */
export function peerAvatarText(id, known = null) {
  if (known?.displayName && known.displayName !== id) {
    return initialsFromDisplayName(known.displayName, id)
  }
  if (isEmbedVisitorId(id)) return 'K'
  if (!id) return '?'
  return String(id).slice(0, 2).toUpperCase()
}

/** Initials for directory / login avatars (prefer display name). */
export function initialsFromDisplayName(displayName, fallbackId = '') {
  const name = String(displayName || '').trim()
  if (name) {
    const parts = name.split(/\s+/).filter(Boolean)
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    }
    return name.slice(0, 2).toUpperCase()
  }
  if (fallbackId) return String(fallbackId).slice(0, 2).toUpperCase()
  return '?'
}

export function userInitials(user) {
  if (!user) return '?'
  return initialsFromDisplayName(user.displayName, user.id)
}

// ---------------------------------------------------------------------------
// Business call helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the given call status is a terminal state.
 * Terminal means: no further business transitions are possible.
 * Network disconnect is NOT a terminal state — only business hangup/end.
 * @param {string} status
 * @returns {boolean}
 */
export function isTerminalCallStatus(status) {
  return TERMINAL_CALL_STATUSES.has(status)
}

/**
 * Normalize a media mode hint from any source (URL param, sessionStorage, server).
 * Server value is authoritative — this is only for parsing/normalizing the string.
 * @param {string|null|undefined} value
 * @returns {'audio'|'video'}
 */
export function normalizeMediaMode(value) {
  const v = String(value || '').toLowerCase()
  return v === 'audio' ? MediaMode.Audio : MediaMode.Video
}

// ---------------------------------------------------------------------------
// Display label helpers (Vietnamese UI)
// ---------------------------------------------------------------------------

export function agentBadgeClass(state) {
  const s = String(state || AgentState.Offline).toLowerCase()
  if (s === 'available') return 'agent-badge agent-badge--available'
  if (s === 'ringing') return 'agent-badge agent-badge--ringing'
  if (s === 'incall') return 'agent-badge agent-badge--incall'
  return 'agent-badge agent-badge--offline'
}

/** Staff status for doctors / consultants (never raw English enums). */
export function agentBadgeLabel(state) {
  const s = String(state || AgentState.Offline)
  if (s === AgentState.Available) return 'Sẵn sàng'
  if (s === AgentState.Ringing) return 'Đang đổ chuông'
  if (s === AgentState.InCall) return 'Đang tư vấn'
  return 'Ngoại tuyến'
}

/** Call lifecycle status for staff UI. */
export function callStatusVi(status) {
  switch (status) {
    case 'Queued': return 'Đang chờ'
    case 'Ringing': return 'Đang đổ chuông'
    case 'Accepted': return 'Đang tư vấn'
    case 'Rejected': return 'Đã từ chối'
    case 'Cancelled': return 'Đã hủy'
    case 'Ended': return 'Đã kết thúc'
    case 'Timeout': return 'Hết thời gian chờ'
    case 'NoAgent': return 'Chưa có nhân viên nhận'
    case 'Closed': return 'Phòng khám đang đóng'
    default: return status || '—'
  }
}

export function formatQueueLabel(item) {
  if (!item) return 'Khách'
  if (item.callerLabel) return item.callerLabel
  return peerLabel(item.callerId)
}

export function queueStatusVi(status) {
  return callStatusVi(status)
}

export function clinicDisplayName(clinicId) {
  if (!clinicId) return 'Phòng khám'
  if (clinicId === 'clinic-a') return 'Phòng khám A'
  if (clinicId === 'clinic-b') return 'Phòng khám B'
  return String(clinicId).replace(/^clinic-/i, 'Phòng khám ')
}

export function roleDisplayName(role) {
  if (!role || role === 'Staff') return 'Nhân viên tư vấn'
  if (role === 'Visitor') return 'Khách'
  if (role === 'Admin' || role === 'Manager') return 'Quản lý'
  return role
}

export function recordingModeLabel(mode) {
  if (mode === 'AudioOnly') return 'Chỉ ghi âm'
  if (mode === 'Video') return 'Ghi hình'
  return 'Không ghi'
}

export function recordingStatusLabelVi(status) {
  switch (String(status || '')) {
    case 'Complete': return 'Sẵn sàng tải'
    case 'Failed': return 'Ghi lỗi'
    case 'Deleted': return 'Đã xóa'
    case 'Recording': return 'Đang ghi'
    case 'Starting': return 'Đang bắt đầu'
    case 'Stopping': return 'Đang dừng'
    case 'Idle': return 'Chưa ghi'
    default: return status || '—'
  }
}

// ---------------------------------------------------------------------------
// Date/time formatting
// ---------------------------------------------------------------------------

export function formatViDateTime(iso) {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return '—'
    return d.toLocaleString('vi-VN', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  } catch {
    return '—'
  }
}

export function formatWaitSeconds(seconds) {
  const n = Number(seconds)
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 60) return `khoảng ${Math.floor(n)} giây`
  const m = Math.floor(n / 60)
  const s = Math.floor(n % 60)
  if (s === 0) return `khoảng ${m} phút`
  return `khoảng ${m} phút ${s} giây`
}

// ---------------------------------------------------------------------------
// Misc utilities
// ---------------------------------------------------------------------------

export const finiteOrNull = value => Number.isFinite(value) ? value : null

export const createClientSessionId = () => globalThis.crypto?.randomUUID?.()
  || `client-${Date.now()}-${Math.random().toString(16).slice(2)}`
