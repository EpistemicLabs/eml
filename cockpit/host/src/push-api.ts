import type * as http from 'node:http'
import type { PushNotifier } from './application/push-notifier.js'
import { isText, type PushStore } from './push-store.js'

/**
 * Web push over HTTP, for the page (Settings › Notifications):
 *   GET    /api/push?endpoint=…        the server's public key, and whether this device is subscribed
 *   PUT    /api/push/subscription      { endpoint, keys: { p256dh, auth }, label }: subscribe this device
 *   DELETE /api/push/subscription      { endpoint }: unsubscribe it
 *   POST   /api/push/test              { endpoint }: a test notification to this device only
 *   POST   /api/push/watching          { sessionIds, endpoint? }: the cockpit is in use on this device (sent while it is),
 *                                      and the sessions in front of the user now; no push about them, nor to other devices
 * The host's gate (createHostServer) has let the page in; a write carries its Origin,
 * which is where a tap on a notification opens the cockpit again.
 */

export interface PushApiDeps {
  store: Pick<PushStore, 'vapid' | 'devices' | 'subscribe' | 'unsubscribe'>
  notifier: Pick<PushNotifier, 'watching' | 'present' | 'test'>
}

type Json = (res: http.ServerResponse, status: number, payload: unknown) => void
type ReadJson = (req: http.IncomingMessage) => Promise<Record<string, unknown>>

const isHttpsUrl = (value: unknown): value is string => {
  if (!isText(value)) return false
  try { return new URL(value).protocol === 'https:' } catch { return false }
}

export async function handlePushApi(
  req: http.IncomingMessage, res: http.ServerResponse, deps: PushApiDeps, url: URL, method: string, json: Json, readJson: ReadJson,
): Promise<boolean> {
  if (url.pathname === '/api/push' && method === 'GET') {
    const endpoint = url.searchParams.get('endpoint')
    json(res, 200, { publicKey: deps.store.vapid().publicKey, subscribed: !!endpoint && deps.store.devices().some((entry) => entry.endpoint === endpoint) })
    return true
  }
  if (url.pathname === '/api/push/subscription' && method === 'PUT') {
    const body = await readJson(req)
    const keys = body.keys as { p256dh?: unknown; auth?: unknown } | undefined
    if (!isHttpsUrl(body.endpoint) || !isText(keys?.p256dh) || !isText(keys?.auth)) {
      json(res, 400, { error: { code: 'INVALID_SUBSCRIPTION', message: 'An https endpoint and the keys p256dh and auth are required' } })
      return true
    }
    const origin = req.headers.origin
    if (!isText(origin)) {
      json(res, 400, { error: { code: 'NO_ORIGIN', message: 'Subscribe from the cockpit page' } })
      return true
    }
    const device = deps.store.subscribe({
      endpoint: body.endpoint, p256dh: keys.p256dh, auth: keys.auth, origin, label: typeof body.label === 'string' ? body.label.slice(0, 60) : '',
    })
    json(res, 200, { id: device.id })
    return true
  }
  if (url.pathname === '/api/push/subscription' && method === 'DELETE') {
    const body = await readJson(req)
    json(res, 200, { removed: isText(body.endpoint) && deps.store.unsubscribe(body.endpoint) })
    return true
  }
  if (url.pathname === '/api/push/test' && method === 'POST') {
    const body = await readJson(req)
    const outcome = isText(body.endpoint) ? await deps.notifier.test(body.endpoint) : 'unknown'
    if (outcome === 'sent') json(res, 200, { outcome })
    else if (outcome === 'unknown') json(res, 404, { error: { code: 'UNKNOWN_DEVICE', message: 'This device is not subscribed', retry: false } })
    else if (outcome === 'gone') json(res, 410, { error: { code: 'GONE', message: 'The push service no longer knows this device; subscribe again', retry: false } })
    else json(res, 502, { error: { code: 'PUSH_FAILED', message: 'The push service did not take the message', retry: true } })
    return true
  }
  if (url.pathname === '/api/push/watching' && method === 'POST') {
    const body = await readJson(req)
    const ids = Array.isArray(body.sessionIds) ? body.sessionIds.filter(isText) : []
    deps.notifier.watching(ids)
    deps.notifier.present(isText(body.endpoint) ? body.endpoint : null)
    json(res, 200, { success: true })
    return true
  }
  return false
}
