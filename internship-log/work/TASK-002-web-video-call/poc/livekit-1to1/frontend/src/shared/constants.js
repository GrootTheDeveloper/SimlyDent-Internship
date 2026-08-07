/**
 * @file shared/constants.js
 * @description Application-wide constants with no external dependencies.
 * Single source of truth for keys, values, and configuration magic strings.
 *
 * Ownership: shared
 * Dependencies: none
 */

// ---------------------------------------------------------------------------
// API base URL resolution
// ---------------------------------------------------------------------------
export const API_URL = typeof import.meta.env.VITE_API_URL === 'string'
  ? import.meta.env.VITE_API_URL
  : (window.location.hostname === 'localhost' ? 'http://localhost:5080' : '')

// ---------------------------------------------------------------------------
// Auth storage keys
// ---------------------------------------------------------------------------
export const AUTH_TOKEN_KEY = 'simlydent_access_token'
export const AUTH_USER_KEY = 'simlydent_auth_user'
export const DEMO_PASSWORD_HINT = 'Demo@123'

// ---------------------------------------------------------------------------
// Session storage keys
// ---------------------------------------------------------------------------
export const SESSION_PREFERRED_MEDIA_KEY = 'simlydent_preferred_media'

// ---------------------------------------------------------------------------
// Business call statuses (authoritative set from backend)
// ---------------------------------------------------------------------------
export const CallStatus = Object.freeze({
  Queued: 'Queued',
  Ringing: 'Ringing',
  Accepted: 'Accepted',
  Rejected: 'Rejected',
  Cancelled: 'Cancelled',
  Ended: 'Ended',
  Timeout: 'Timeout',
  NoAgent: 'NoAgent',
  Closed: 'Closed',
})

/** Terminal statuses: no further transitions possible on the business call. */
export const TERMINAL_CALL_STATUSES = new Set([
  CallStatus.Rejected,
  CallStatus.Cancelled,
  CallStatus.Ended,
  CallStatus.Timeout,
  CallStatus.NoAgent,
  CallStatus.Closed,
])

// ---------------------------------------------------------------------------
// Media modes (server-authoritative values)
// ---------------------------------------------------------------------------
export const MediaMode = Object.freeze({
  Audio: 'audio',
  Video: 'video',
})

// ---------------------------------------------------------------------------
// Recording / media asset statuses
// ---------------------------------------------------------------------------
export const MediaAssetStatus = Object.freeze({
  Requested: 'Requested',
  Recording: 'Recording',
  Finalizing: 'Finalizing',
  Ready: 'Ready',
  Failed: 'Failed',
  DeletePending: 'DeletePending',
  Deleted: 'Deleted',
})

// ---------------------------------------------------------------------------
// Agent presence states
// ---------------------------------------------------------------------------
export const AgentState = Object.freeze({
  Available: 'Available',
  Ringing: 'Ringing',
  InCall: 'InCall',
  Offline: 'Offline',
})

// ---------------------------------------------------------------------------
// Realtime hub
// ---------------------------------------------------------------------------
export const HUB_PATH = '/hubs/calls'
