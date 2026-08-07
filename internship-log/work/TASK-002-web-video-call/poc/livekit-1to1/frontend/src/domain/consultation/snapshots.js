/**
 * @file domain/consultation/snapshots.js
 * Photo capture + upload for consultation media.
 */
import { apiFetch } from '../../shared/api-client.js'
import { authHeaders } from '../../shared/auth.js'
import { Track } from 'livekit-client'

export async function captureLocalPhotoBlob(room) {
  const localVideoTrack = room?.localParticipant
    ?.getTrackPublication?.(Track.Source.Camera)?.track
    || room?.localParticipant
      ?.getTrackPublication?.(Track.Source.Camera)?.videoTrack
  const mst = localVideoTrack?.mediaStreamTrack
  if (!mst) {
    throw new Error('No local camera track for photo capture')
  }

  const settings = mst.getSettings?.() || {}
  let blob = null
  let actualWidth = settings.width || null
  let actualHeight = settings.height || null

  if (typeof ImageCapture !== 'undefined') {
    try {
      const capture = new ImageCapture(mst)
      const photoBlob = await capture.takePhoto()
      if (photoBlob instanceof Blob) blob = photoBlob
    } catch (e) {
      console.warn('ImageCapture.takePhoto failed, canvas fallback', e)
    }
  }

  if (!blob) {
    const canvas = document.createElement('canvas')
    canvas.width = settings.width || 1280
    canvas.height = settings.height || 720
    actualWidth = canvas.width
    actualHeight = canvas.height
    const videoEl = document.createElement('video')
    videoEl.muted = true
    videoEl.playsInline = true
    videoEl.srcObject = new MediaStream([mst])
    await videoEl.play()
    await new Promise(r => setTimeout(r, 50))
    canvas.getContext('2d').drawImage(videoEl, 0, 0, canvas.width, canvas.height)
    videoEl.pause()
    videoEl.srcObject = null
    blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.95))
  }

  if (!blob) throw new Error('Không chụp được ảnh')
  return { blob, actualWidth, actualHeight }
}

export async function handleCapturePhotoCommand(room, msg) {
  if (!msg?.assetId) return
  const { blob, actualWidth, actualHeight } = await captureLocalPhotoBlob(room)
  const mode = msg.uploadMode || (msg.uploadUrl ? 'presign' : 'api')

  if (mode === 'presign' && msg.uploadUrl) {
    const putRes = await fetch(msg.uploadUrl, {
      method: 'PUT',
      body: blob,
      headers: { 'Content-Type': 'image/jpeg' }
    })
    if (!putRes.ok) {
      throw new Error(`Upload ảnh thất bại HTTP ${putRes.status}`)
    }
    // Notify backend (retry up to 3 times)
    let lastErr = null
    for (let i = 0; i < 3; i++) {
      try {
        const res = await apiFetch(`/api/media/${msg.assetId}/upload-complete`, {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            actualWidth,
            actualHeight,
            bytes: blob.size
          })
        })
        if (res.ok || res.status === 202) return
        const body = await res.json().catch(() => ({}))
        lastErr = new Error(body.error || `upload-complete HTTP ${res.status}`)
        await new Promise(r => setTimeout(r, 800 * (i + 1)))
      } catch (e) {
        lastErr = e
        await new Promise(r => setTimeout(r, 800 * (i + 1)))
      }
    }
    if (lastErr) throw lastErr
    return
  }

  // Local / API path: POST bytes to backend (Bearer JWT)
  const path = msg.uploadPath || `/api/media/${msg.assetId}/upload`
  const q = new URLSearchParams()
  if (actualWidth) q.set('w', String(actualWidth))
  if (actualHeight) q.set('h', String(actualHeight))
  const url = q.toString() ? `${path}?${q}` : path
  const res = await apiFetch(url, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'image/jpeg' }),
    body: blob
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || `API upload HTTP ${res.status}`)
  }
}

