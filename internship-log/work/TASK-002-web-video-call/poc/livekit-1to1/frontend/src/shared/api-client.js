/**
 * @file shared/api-client.js
 * @description Authenticated API fetch wrapper.
 *
 * Ownership: shared
 * Dependencies: shared/auth.js, shared/constants.js
 *
 * Rules:
 * - Always injects Bearer JWT from auth session.
 * - On 401 (non-login path), clears the stale auth session.
 * - Never logs JWT or presigned URLs.
 */

import { API_URL } from './constants.js'
import { authHeaders, clearAuthSession } from './auth.js'

/**
 * Authenticated fetch wrapper for backend API calls.
 *
 * @param {string} path  API path starting with '/' (e.g. '/api/calls')
 * @param {RequestInit & { headers?: object }} [options={}]
 * @returns {Promise<Response>}
 */
export async function apiFetch(path, options = {}) {
  const headers = authHeaders(options.headers || {})
  const res = await fetch(`${API_URL}${path}`, { ...options, headers })
  if (res.status === 401 && !path.startsWith('/api/auth/login')) {
    // Stale or invalid token — clear session so UI redirects to login.
    clearAuthSession()
  }
  return res
}
