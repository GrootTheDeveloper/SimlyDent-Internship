/**
 * @file main.js ? thin surface router (Phase 3)
 */
import './style.css'
import { normalizeMediaMode } from './shared/call-helpers.js'
import { readPreferredMediaHint } from './shared/storage-helpers.js'

const path = window.location.pathname
const isCallRoute = path.startsWith('/call/')

async function boot() {
  if (isCallRoute) {
    const { mountCallWindowApp } = await import('./app/call-window/call-window-app.js')
    const callId = path.replace('/call/', '').trim()
    const callQuery = new URLSearchParams(window.location.search)
    let preferredMediaHint = normalizeMediaMode(callQuery.get('media') || 'video')
    const storedHint = readPreferredMediaHint()
    if (storedHint && !callQuery.get('media')) preferredMediaHint = storedHint
    mountCallWindowApp({ callId, preferredMediaHint })
    return
  }
  const { mountPortalApp } = await import('./app/portal/portal-app.js')
  mountPortalApp()
}

boot().catch((err) => {
  console.error('[boot]', err)
  const el = document.getElementById('app')
  if (el) {
    el.innerHTML = '<div style="padding:2rem;font-family:sans-serif;color:#b91c1c">Kh?ng kh?i t?o ???c ?ng d?ng. Xem console.</div>'
  }
})
