import { describe, expect, it } from 'vitest'
import { wakeRequest, wakeResult } from '../src/domain/send-message-wake.js'

const call = (tool_input: Record<string, unknown>, tool_name = 'SendMessage') => ({ tool_name, tool_input })

describe('wakeRequest', () => {
  it('takes the address and the text', () => {
    expect(wakeRequest(call({ to: 'eml-1', message: 'hi' }))).toEqual({ target: 'eml-1', text: 'hi', notifyWhenIdle: false })
  })

  it('takes the address out of a listing row', () => {
    expect(wakeRequest(call({ to: 'eml-1 [3fa9c1]', message: 'hi' }))?.target).toBe('eml-1')
  })

  it('keeps a message that also asks for an idle notice', () => {
    expect(wakeRequest(call({ to: 'eml-1', message: 'hi', notify_when_idle: true }))?.notifyWhenIdle).toBe(true)
  })

  it.each([
    ['an idle subscription without a message', call({ to: 'eml-1', notify_when_idle: true })],
    ['an empty message', call({ to: 'eml-1', message: '  ' })],
    ['a message that is not text', call({ to: 'eml-1', message: { type: 'shutdown_request' } })],
    ['no address', call({ message: 'hi' })],
    ['another tool', call({ to: 'eml-1', message: 'hi' }, 'Bash')],
    ['no input', { tool_name: 'SendMessage' }],
    ['nothing', null],
  ])('leaves alone %s', (_name, input) => {
    expect(wakeRequest(input)).toBeNull()
  })
})

describe('wakeResult', () => {
  const request = { target: 'eml-1', text: 'hi', notifyWhenIdle: false }

  it('says it was delivered, and where the answer comes', () => {
    const result = wakeResult('resumed', request, 'eml-2')
    expect(result).toContain('Delivered, not an error, do not send it again')
    expect(result).toContain('It can answer you at eml-2.')
  })

  it('says when the idle notice did not happen', () => {
    expect(wakeResult('resumed', { ...request, notifyWhenIdle: true }, 'eml-2')).toContain('No idle notice was set up')
    expect(wakeResult('resumed', request, 'eml-2')).not.toContain('idle notice')
  })

  it.each(['running', 'busy', 'unknown', 'refused', 'delivered', undefined, 42])('lets SendMessage go ahead on %s', (outcome) => {
    expect(wakeResult(outcome, request, 'eml-2')).toBeNull()
  })
})
