import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as http from 'node:http'
import { handleJobsApi, type JobsApiDeps } from '../src/jobs-api.js'
import { JobStore } from '../src/job-store.js'

/** PUT and GET /api/jobs/time-zone against a store on disk, as the page calls them. */
function setup(saved: string | null) {
  const file = join(mkdtempSync(join(tmpdir(), 'cockpit-time-zone-')), 'jobs.json')
  const store = new JobStore(file)
  if (saved) store.setTimeZone(saved)
  const deps = { store, zones: store } as unknown as JobsApiDeps
  const call = async (method: 'GET' | 'PUT', body: Record<string, unknown> = {}) => {
    let answer: { status: number; payload: unknown } | null = null
    const json = (_res: http.ServerResponse, status: number, payload: unknown) => { answer = { status, payload } }
    const handled = await handleJobsApi({ headers: {} } as http.IncomingMessage, {} as http.ServerResponse, deps, '/api/jobs/time-zone', method, json, async () => body)
    expect(handled).toBe(true)
    return answer!
  }
  return { file, store, call }
}

describe('the user\'s time zone setting', () => {
  it('is not overwritten by a page load: a browser\'s zone without explicit leaves a saved zone as it is', async () => {
    const { file, call } = setup('Asia/Bangkok')
    expect(await call('PUT', { timeZone: 'UTC' })).toEqual({ status: 200, payload: { timeZone: 'Asia/Bangkok', changed: false } })
    expect(new JobStore(file).timeZone()).toBe('Asia/Bangkok')
    expect(await call('GET')).toEqual({ status: 200, payload: { timeZone: 'Asia/Bangkok' } })
  })

  it('is filled in by the first browser while none is saved', async () => {
    const { file, call } = setup(null)
    expect(await call('GET')).toEqual({ status: 200, payload: { timeZone: null } })
    expect(await call('PUT', { timeZone: 'Asia/Makassar' })).toEqual({ status: 200, payload: { timeZone: 'Asia/Makassar', changed: true } })
    expect(new JobStore(file).timeZone()).toBe('Asia/Makassar')
    // The next browser, in another zone, changes nothing.
    expect(await call('PUT', { timeZone: 'UTC' })).toMatchObject({ payload: { timeZone: 'Asia/Makassar', changed: false } })
  })

  it('changes when the user chooses one in Settings (explicit)', async () => {
    const { file, call } = setup('UTC')
    expect(await call('PUT', { timeZone: 'Asia/Bangkok', explicit: true })).toEqual({ status: 200, payload: { timeZone: 'Asia/Bangkok', changed: true } })
    expect(new JobStore(file).timeZone()).toBe('Asia/Bangkok')
  })

  it('refuses what is no IANA zone', async () => {
    const { store, call } = setup('Asia/Bangkok')
    expect(await call('PUT', { timeZone: 'Mars/Olympus', explicit: true })).toMatchObject({ status: 400, payload: { error: { code: 'INVALID_TIME_ZONE' } } })
    expect(store.timeZone()).toBe('Asia/Bangkok')
  })
})
