/**
 * @file shared/safe-log.js
 * Production-safe logging — never emit JWT, Bearer tokens, or presigned URLs.
 */

const REDACT = '[REDACTED]'

/** Debug logs enabled when ?debug=1 or localStorage simlydent_debug=1 */
export function isDebugEnabled() {
  try {
    if (typeof window === 'undefined') return false
    if (new URLSearchParams(window.location.search).get('debug') === '1') return true
    return localStorage.getItem('simlydent_debug') === '1'
  } catch {
    return false
  }
}

/**
 * Redact secrets from a string or shallow object for logging.
 * @param {unknown} value
 * @returns {unknown}
 */
export function redactForLog(value) {
  if (value == null) return value
  if (typeof value === 'string') {
    let s = value
    // JWT-like
    s = s.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, REDACT)
    // Bearer tokens
    s = s.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACT}`)
    // query access_token=
    s = s.replace(/([?&]access_token=)[^&\s]+/gi, `$1${REDACT}`)
    // AWS-style presigned query params
    s = s.replace(/([?&]X-Amz-Signature=)[^&\s]+/gi, `$1${REDACT}`)
    s = s.replace(/([?&]X-Amz-Credential=)[^&\s]+/gi, `$1${REDACT}`)
    // long hex-looking secrets
    if (/https?:\/\/\S+[?&](X-Amz-|Signature=|token=)/i.test(s)) {
      try {
        const u = new URL(s)
        ;['X-Amz-Signature', 'X-Amz-Credential', 'X-Amz-Security-Token', 'access_token', 'token', 'Signature'].forEach((k) => {
          if (u.searchParams.has(k)) u.searchParams.set(k, REDACT)
        })
        return u.toString()
      } catch {
        return REDACT
      }
    }
    return s
  }
  if (Array.isArray(value)) return value.map(redactForLog)
  if (typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      const key = String(k).toLowerCase()
      if (
        key.includes('token') ||
        key.includes('secret') ||
        key.includes('password') ||
        key.includes('authorization') ||
        key.includes('presign') ||
        key.includes('uploadurl') ||
        key === 'jwt'
      ) {
        out[k] = REDACT
      } else {
        out[k] = redactForLog(v)
      }
    }
    return out
  }
  return value
}

export function safeStringify(value) {
  try {
    return JSON.stringify(redactForLog(value))
  } catch {
    return String(value)
  }
}

/** Info only when debug enabled */
export function debugLog(...args) {
  if (!isDebugEnabled()) return
  console.info(...args.map(redactForLog))
}

export function safeWarn(...args) {
  console.warn(...args.map(redactForLog))
}

export function safeError(...args) {
  console.error(...args.map(redactForLog))
}

/**
 * Timestamped realtime log (call window). Always redacts; full detail only in debug mode.
 */
export function rtLog(event, detail) {
  const ts = new Date().toISOString()
  if (detail === undefined) {
    console.info(`[rt ${ts}] ${event}`)
    return
  }
  const safe = redactForLog(detail)
  const extra = typeof safe === 'string' ? safe : safeStringify(safe)
  if (isDebugEnabled()) {
    console.info(`[rt ${ts}] ${event} ${extra}`)
  } else {
    // Production: event name only + short non-secret summary
    const short =
      safe && typeof safe === 'object' && safe.reason
        ? ` reason=${String(safe.reason).slice(0, 80)}`
        : safe && typeof safe === 'object' && safe.type
          ? ` type=${String(safe.type)}`
          : ''
    console.info(`[rt ${ts}] ${event}${short}`)
  }
}