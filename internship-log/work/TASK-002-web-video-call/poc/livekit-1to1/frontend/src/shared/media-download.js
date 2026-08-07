/**
 * @file shared/media-download.js
 * Manager download for consultation media_assets (audio / clip / photo).
 */
import { API_URL } from './constants.js'
import { authHeaders } from './auth.js'
import { apiFetch } from './api-client.js'

function suggestFilename(kind, assetId, mimeType) {
  const id = String(assetId || 'file').replace(/-/g, '').slice(0, 12)
  const mime = String(mimeType || '')
  if (kind === 'CallAudio' || mime.includes('audio')) return `audio-${id}.mp3`
  if (kind === 'DentalVideoClip' || mime.includes('video')) return `clip-${id}.mp4`
  if (kind === 'Snapshot' || mime.includes('image')) return `photo-${id}.jpg`
  return `media-${id}.bin`
}

function triggerBlobDownload(blob, filename) {
  const objectUrl = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = objectUrl
  a.download = filename || 'download.bin'
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(objectUrl), 4000)
}

/**
 * Resolve download-url then save file. Proxy mode requires Bearer (same origin).
 * @param {string} assetId
 * @param {string} [kind]
 */
export async function fetchAndSaveMediaAsset(assetId, kind = 'media') {
  if (!assetId) throw new Error('Thiếu assetId.')

  const metaRes = await apiFetch(`/api/media/${assetId}/download-url`, {
    headers: authHeaders()
  })
  const meta = await metaRes.json().catch(() => ({}))
  if (!metaRes.ok) {
    throw new Error(meta.error || `Không lấy được link tải (HTTP ${metaRes.status})`)
  }

  const filename = suggestFilename(kind || meta.kind, assetId, meta.mimeType)
  let fileUrl = meta.url || `/api/media/${assetId}/file`
  if (fileUrl.startsWith('/')) fileUrl = `${API_URL}${fileUrl}`

  const isPresign = meta.mode === 'presign' && /^https?:\/\//i.test(fileUrl)
  const fileRes = await fetch(fileUrl, isPresign ? {} : { headers: authHeaders() })
  if (!fileRes.ok) {
    let detail = ''
    try {
      const err = await fileRes.json()
      detail = err.error || ''
    } catch {
      /* ignore */
    }
    throw new Error(detail || `Tải file thất bại (HTTP ${fileRes.status})`)
  }

  const blob = await fileRes.blob()
  if (!blob || blob.size === 0) throw new Error('File rỗng hoặc chưa sẵn sàng.')
  triggerBlobDownload(blob, filename)
}

/**
 * Download full consultation package as ZIP:
 *   audio.mp3 + videos/*.mp4 + images/*.jpg
 * @param {string} sessionId
 * @param {string} [suggestedName]
 */
export async function fetchAndSaveConsultationZip(sessionId, suggestedName = '') {
  if (!sessionId) throw new Error('Thiếu sessionId.')

  const res = await apiFetch(`/api/consultations/${sessionId}/zip`, {
    headers: authHeaders()
  })
  if (!res.ok) {
    let detail = ''
    try {
      const err = await res.json()
      detail = err.error || ''
    } catch {
      /* ignore */
    }
    throw new Error(detail || `Tải ZIP thất bại (HTTP ${res.status})`)
  }

  const blob = await res.blob()
  if (!blob || blob.size === 0) throw new Error('ZIP rỗng hoặc chưa có media Ready.')

  let filename = suggestedName || `consultation-${String(sessionId).slice(0, 8)}.zip`
  if (!filename.toLowerCase().endsWith('.zip')) filename += '.zip'
  // Prefer Content-Disposition filename if present
  const cd = res.headers.get('Content-Disposition') || ''
  const m = /filename\*?=(?:UTF-8''|")?([^\";]+)/i.exec(cd)
  if (m && m[1]) {
    try {
      filename = decodeURIComponent(m[1].replace(/"/g, '').trim())
    } catch {
      filename = m[1].replace(/"/g, '').trim()
    }
  }
  triggerBlobDownload(blob, filename)
}
