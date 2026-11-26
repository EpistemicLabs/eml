import { describe, expect, it } from 'vitest'
import { directoryQueryOf, endTurn, listSessions, schedule, sendMessage, type SendMessagePorts } from '../src/application/session-tools.js'
import type { MessageRequest } from '../src/application/deliver-message.js'
import { searchResult, searchSessions, type DirectoryEntry } from '../src/domain/session-directory.js'
import type { DeliveryOutcome } from '../src/domain/session-delivery.js'
import { LIST_SESSIONS_WORDING, SESSION_TOOLS } from '../src/domain/session-tools.js'
import { deriveTurn, endTurnAnswer, endTurnDescription, type EndTurn } from '../src/domain/turn-end.js'

const entry = (patch: Partial<DirectoryEntry>): DirectoryEntry => ({
  address: 'eml-1111', name: 'Catalogue import', outcome: 'Import done', asked: 'Import the catalogue', project: 'EML',
  state: 'stopped', lastActive: '2026-11-25T08:00:00.000Z', parent: null, main: false, ...patch,
})
const DIRECTORY = [
  entry({}),
  entry({ address: 'eml-2222', name: 'Release notes', outcome: null, asked: 'Write the notes', state: 'running', lastActive: '2026-11-25T09:00:00.000Z' }),
  entry({ address: 'shop-3333', name: 'Old catalogue', project: 'Shop', state: 'archived', lastActive: '2026-11-20T09:00:00.000Z' }),
]

describe('the tool definitions', () => {
  it('have one name each, as the agent calls them', () => {
    expect(Object.values(SESSION_TOOLS).map((tool) => tool.name))
      .toEqual(['end_turn', 'session_status', 'schedule', 'offer_split', 'propose_sort', 'send_message', 'list_sessions'])
  })

  it('name the user\'s time zone where a tool reads times', () => {
    expect(SESSION_TOOLS.endTurn.description('Asia/Bangkok (UTC+7)')).toBe(endTurnDescription('Asia/Bangkok (UTC+7)'))
    expect(SESSION_TOOLS.schedule.description('Asia/Bangkok (UTC+7)')).toContain('by default the user\'s own (Asia/Bangkok (UTC+7));')
    expect(SESSION_TOOLS.schedule.description()).toContain('by default the user\'s own; pass it')
  })

  it('send_message says what a terminal session cannot get back, and list_sessions where the address comes from', () => {
    const send = SESSION_TOOLS.sendMessage.description()
    expect(send).toContain('A stopped session is resumed first.')
    expect(send).toContain('A terminal session cannot receive a reply this way: the receiver\'s answer comes through the task or the user')
    expect(send).toContain('exactly as list_sessions shows it')
    expect(SESSION_TOOLS.listSessions.description()).toContain('you can message with send_message')
    expect(Object.keys(SESSION_TOOLS.sendMessage.input)).toEqual(['to', 'text'])
    expect(Object.keys(SESSION_TOOLS.listSessions.input)).toEqual(['words', 'state', 'project', 'archived', 'limit'])
  })
})

describe('end_turn', () => {
  const ctx = { owner: 'lasse', agent: 'atlas', members: ['lasse', 'atlas'] }
  const ports = () => {
    const calls: EndTurn[] = []
    return { calls, endTurn: async (call: EndTurn) => { calls.push(call); return { derived: deriveTurn(call, ctx), missing: ['next' as const] } } }
  }

  it('hands a readable call on, trimmed, and answers what was recorded and what it lacks', async () => {
    const p = ports()
    const call = { result: 'Half way' }
    expect(await endTurn(p, { result: ' Half way ' })).toEqual({ text: endTurnAnswer(call, deriveTurn(call, ctx), { missing: ['next'] }), isError: false })
    expect(p.calls).toEqual([call])
  })

  it('refuses input it cannot read, as an error, without handing it on', async () => {
    const p = ports()
    expect(await endTurn(p, {})).toMatchObject({ isError: true, text: expect.stringMatching(/^Not recorded: result is missing/) })
    expect(await endTurn(p, { result: 'x', next: { what: 'look' } })).toMatchObject({ isError: true, text: expect.stringMatching(/^Not recorded: next\.who is missing/) })
    expect(await endTurn(p, { result: 'x', next: { who: 'me', what: 'look', when: 'tomorrow' } })).toMatchObject({ isError: true, text: expect.stringMatching(/^Not recorded: next\.when "tomorrow" is not a time\./) })
    expect(await endTurn(p, null)).toMatchObject({ isError: true })
    expect(p.calls).toEqual([])
  })

  it('answers as an error with the reason when the call was not recorded', async () => {
    const down = { endTurn: async () => { throw new Error('the brain does not answer') } }
    expect(await endTurn(down, { result: 'x' })).toEqual({ text: 'Not recorded: the brain does not answer. Call end_turn again.', isError: true })
    const odd = { endTurn: async () => { throw 'no error object' } }
    expect(await endTurn(odd, { result: 'x' })).toEqual({ text: 'Not recorded: unknown error. Call end_turn again.', isError: true })
  })
})

describe('schedule', () => {
  it('answers what the jobs answer', async () => {
    const got: unknown[] = []
    expect(await schedule({ jobs: async (input) => { got.push(input); return 'Created "Daily brief".' } }, { action: 'create', name: 'Daily brief' }))
      .toEqual({ text: 'Created "Daily brief".', isError: false })
    expect(got).toEqual([{ action: 'create', name: 'Daily brief' }])
  })

  it('says so when the tool itself failed', async () => {
    expect(await schedule({ jobs: async () => { throw new Error('store not writable') } }, { action: 'list' }))
      .toEqual({ text: 'The schedule tool failed: store not writable', isError: false })
    expect((await schedule({ jobs: async () => { throw 'odd' } }, { action: 'list' })).text).toBe('The schedule tool failed: unknown error')
  })
})

describe('send_message', () => {
  function setup(outcome: DeliveryOutcome | Error = 'delivered', patch: Partial<SendMessagePorts> = {}) {
    const requests: MessageRequest[] = []
    const ports: SendMessagePorts = {
      directory: () => DIRECTORY,
      from: 'eml-9999',
      deliver: async (request) => {
        requests.push(request)
        if (outcome instanceof Error) throw outcome
        return outcome
      },
      ...patch,
    }
    return { ports, requests }
  }
  const send = (outcome: DeliveryOutcome | Error) => sendMessage(setup(outcome).ports, { to: 'eml-1111', text: 'The import is done.' })

  it('hands the text to a session of the caller\'s directory, as from a session, and says who wrote', async () => {
    const { ports, requests } = setup('delivered')
    await sendMessage(ports, { to: ' eml-1111 ', text: 'The import is done.' })
    expect(requests).toEqual([{ target: 'eml-1111', text: 'The import is done.', from: 'eml-9999', caller: 'session' }])
  })

  it('passes on that the caller cannot be messaged back', async () => {
    const { ports, requests } = setup('delivered', { noReply: true })
    await sendMessage(ports, { to: 'eml-1111', text: 'The import is done.' })
    expect(requests).toEqual([{ target: 'eml-1111', text: 'The import is done.', from: 'eml-9999', caller: 'session', noReply: true }])
  })

  it('delivered: the running session has it, and its answer comes another way', async () => {
    expect(await send('delivered')).toEqual({
      text: 'Delivered: eml-1111 runs and has your message. Its answer does not come back to this call: it comes through the task or the user.',
      isError: false,
    })
  })

  it('resumed: the stopped session was woken and has it', async () => {
    expect(await send('resumed')).toEqual({
      text: 'Delivered: eml-1111 had stopped, so the cockpit woke it and it has your message. Its answer does not come back to this call: it comes through the task or the user.',
      isError: false,
    })
  })

  it('busy: try again later, or tell the user', async () => {
    expect(await send('busy')).toEqual({
      text: 'Not sent: eml-1111 cannot take it right now (it runs in a terminal, or is switching). Send it again later, or tell your user what you wanted it to know.',
      isError: true,
    })
  })

  it('unknown: reads like a session the caller cannot message', async () => {
    expect(await send('unknown')).toEqual({
      text: 'Not sent: eml-1111 is not a session you can message. list_sessions shows the addresses you can send to; take the address from there.',
      isError: true,
    })
  })

  it('refused: sending again will not help', async () => {
    expect(await send('refused')).toEqual({
      text: 'Not sent: eml-1111 does not run in chat, so the cockpit cannot hand it a message. Sending again will not help: tell your user what you wanted it to know.',
      isError: true,
    })
  })

  it('running: nothing was sent', async () => {
    expect(await send('running')).toEqual({
      text: 'Not sent: eml-1111 runs, and the cockpit took this message only for a stopped session. Send it again.',
      isError: true,
    })
  })

  it('refuses a target outside the caller\'s directory without asking for a delivery', async () => {
    const { ports, requests } = setup('delivered')
    expect(await sendMessage(ports, { to: 'other-4444', text: 'hello' })).toEqual({
      text: 'Not sent: other-4444 is not a session you can message. list_sessions shows the addresses you can send to; take the address from there.',
      isError: true,
    })
    const alone = setup('delivered', { directory: () => [] })
    expect((await sendMessage(alone.ports, { to: 'eml-1111', text: 'hello' })).isError).toBe(true)
    expect([...requests, ...alone.requests]).toEqual([])
  })

  it('refuses a call without an address or a text', async () => {
    const { ports, requests } = setup('delivered')
    const incomplete = { text: 'Not sent: to (the session\'s address) and text are both needed.', isError: true }
    expect(await sendMessage(ports, { to: 'eml-1111', text: '  ' })).toEqual(incomplete)
    expect(await sendMessage(ports, { text: 'hello' })).toEqual(incomplete)
    expect(await sendMessage(ports, { to: 7, text: 'hello' })).toEqual(incomplete)
    expect(requests).toEqual([])
  })

  it('says so when the delivery itself failed', async () => {
    expect(await send(new Error('The host is shutting down.'))).toEqual({
      text: 'Not sent: the cockpit could not hand eml-1111 your message (The host is shutting down). Send it again.',
      isError: true,
    })
  })
})

describe('list_sessions', () => {
  const ports = { directory: () => DIRECTORY }

  it('prints what the search command prints', () => {
    const query = { words: ['catalogue'], archived: false, limit: 10 }
    expect(listSessions(ports, { words: 'catalogue' })).toEqual({ text: searchResult(searchSessions(DIRECTORY, query), query), isError: false })
    expect(listSessions(ports, { words: 'catalogue' }).text).toMatch(/^One session fits:\n\neml-1111 · stopped/)
  })

  it('without words lists the most recent, and says so when nothing fits', () => {
    expect(listSessions(ports, {}).text).toMatch(/^2 sessions fit[\s\S]*eml-2222[\s\S]*eml-1111/)
    expect(listSessions(ports, { words: 'nothing like it' }).text).toMatch(/^No session matches "nothing like it"\./)
    // The tool's answer names the tool where the search command's names the command and ListAgents.
    expect(listSessions(ports, { words: 'nothing like it' }).text).toBe(searchResult([], { words: ['nothing', 'like', 'it'] }, LIST_SESSIONS_WORDING))
    expect(listSessions(ports, { words: 'nothing like it' }).text).toContain('Archived sessions: list_sessions with archived true. The most recent sessions: list_sessions without words.')
  })

  it('narrows by state, project and archive', () => {
    expect(listSessions(ports, { state: 'running' }).text).toMatch(/^One session fits:\n\neml-2222/)
    expect(listSessions(ports, { words: 'catalogue', archived: true }).text).toMatch(/^2 sessions fit/)
    expect(listSessions(ports, { words: 'catalogue', archived: true, project: 'shop' }).text).toMatch(/^One session fits:\n\nshop-3333 · archived/)
    expect(listSessions(ports, { limit: 1 }).text).toMatch(/^One session fits:\n\neml-2222/)
  })

  it('reads its input with the bounds of the search command', () => {
    expect(directoryQueryOf({})).toEqual({ words: [], archived: false, limit: 10 })
    expect(directoryQueryOf({ words: '  release   notes ', state: 'stopped', project: 'EML', archived: true, limit: 1000 }))
      .toEqual({ words: ['release', 'notes'], state: 'stopped', project: 'EML', archived: true, limit: 200 })
    expect(directoryQueryOf({ words: ['release', 'notes'], state: 'archived', project: ' ', limit: 0 })).toEqual({ words: ['release', 'notes'], archived: false, limit: 10 })
  })
})
