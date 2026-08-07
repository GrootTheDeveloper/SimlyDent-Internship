/**
 * @file shared/storage-helpers.js
 * @description Safe sessionStorage / localStorage read-write wrappers.
 *
 * Ownership: shared
 * Dependencies: shared/constants.js
 *
 * Rules:
 * - Never throw — storage may be blocked (private mode, quota exceeded)
 * - Never store secrets (JWT, presigned URLs, passwords)
 * - Use only for transient UI hints, not authoritative state
 */

import { SESSION_PREFERRED_MEDIA_KEY } from './constants.js'

/**
 * Safely read a string from sessionStorage.
 * @param {string} key
 * @returns {string|null}
 */
export function sessionGet(key) {
  try {
    return sessionStorage.getItem(key)
  } catch {
    return null
  }
}

/**
 * Safely write a string to sessionStorage.
 * @param {string} key
 * @param {string} value
 */
export function sessionSet(key, value) {
  try {
    sessionStorage.setItem(key, value)
  } catch { /* Storage may be blocked in private/iframe contexts */ }
}

/**
 * Safely remove a key from sessionStorage.
 * @param {string} key
 */
export function sessionRemove(key) {
  try {
    sessionStorage.removeItem(key)
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Preferred media hint (session-scoped — authoritative source is server)
// ---------------------------------------------------------------------------

/**
 * Read the cached preferred media hint ('audio' | 'video' | null).
 * NOTE: This is a UI hint only. Server authoritative value (call.initialMediaMode)
 * must override this in all business logic.
 * @returns {'audio'|'video'|null}
 */
export function readPreferredMediaHint() {
  const val = sessionGet(SESSION_PREFERRED_MEDIA_KEY)
  if (val === 'audio') return 'audio'
  if (val === 'video') return 'video'
  return null
}

/**
 * Cache the preferred media hint for the session.
 * @param {'audio'|'video'} mode
 */
export function writePreferredMediaHint(mode) {
  if (mode === 'audio' || mode === 'video') {
    sessionSet(SESSION_PREFERRED_MEDIA_KEY, mode)
  }
}

/**
 * Clear the preferred media hint (e.g. after call ends).
 */
export function clearPreferredMediaHint() {
  sessionRemove(SESSION_PREFERRED_MEDIA_KEY)
}
