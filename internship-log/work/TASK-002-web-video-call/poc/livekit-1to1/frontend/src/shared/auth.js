/**
 * @file shared/auth.js
 * @description Authentication session helpers — localStorage read/write for JWT.
 *
 * Ownership: shared
 * Dependencies: shared/constants.js
 *
 * Security note: Access token is stored in localStorage (PoC compatibility).
 * Production hardening debt: move to HttpOnly cookie + short-lived token.
 */

import { AUTH_TOKEN_KEY, AUTH_USER_KEY } from './constants.js'

/**
 * Read the current JWT access token from localStorage.
 * Returns empty string (never throws) — callers may check for falsy.
 * @returns {string}
 */
export function getAccessToken() {
  try {
    return localStorage.getItem(AUTH_TOKEN_KEY) || ''
  } catch {
    return ''
  }
}

/**
 * Persist an auth session (access token + user object).
 * @param {string} accessToken
 * @param {object} user
 */
export function setAuthSession(accessToken, user) {
  localStorage.setItem(AUTH_TOKEN_KEY, accessToken)
  localStorage.setItem(AUTH_USER_KEY, JSON.stringify(user))
}

/**
 * Remove auth session from localStorage (used on logout or 401).
 */
export function clearAuthSession() {
  localStorage.removeItem(AUTH_TOKEN_KEY)
  localStorage.removeItem(AUTH_USER_KEY)
}

/**
 * Read the cached user object from localStorage.
 * Returns null if not present or parse fails.
 * @returns {object|null}
 */
export function readCachedUser() {
  try {
    const raw = localStorage.getItem(AUTH_USER_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

/**
 * Build request headers including Bearer JWT if available.
 * @param {object} [extra={}]  Additional headers to merge.
 * @returns {object}
 */
export function authHeaders(extra = {}) {
  const headers = { ...extra }
  const token = getAccessToken()
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}
