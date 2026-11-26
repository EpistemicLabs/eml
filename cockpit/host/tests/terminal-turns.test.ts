import { describe, expect, it } from 'vitest'
import { TerminalTurns } from '../src/application/terminal-turns.js'
import type { SaidTurn } from '../src/application/record-end-turn.js'
import { deriveTurn, type EndTurn } from '../src/domain/turn-end.js'

const ctx = { owner: 'lasse', agent: 'atlas', members: ['lasse', 'atlas'] }
const said = (call: EndTurn): SaidTurn => ({ call, ctx, derived: deriveTurn(call, ctx) })

describe('what a terminal session said until its turn ends', () => {
  it('is taken once', () => {
    const turns = new TerminalTurns()
    const turn = said({ result: 'Draft ready', questions: ['Send it today?'] })
    turns.said('s1', turn)
    expect(turns.take('s1')).toEqual(turn)
    expect(turns.take('s1')).toBeNull()
  })

  it('is the last call of the turn, per session', () => {
    const turns = new TerminalTurns()
    turns.said('s1', said({ result: 'Half way' }))
    turns.said('s1', said({ result: 'Done' }))
    turns.said('s2', said({ result: 'Other' }))
    expect(turns.take('s1')?.call.result).toBe('Done')
    expect(turns.take('s2')?.call.result).toBe('Other')
  })

  it('is gone once forgotten, and a session that said nothing has none', () => {
    const turns = new TerminalTurns()
    turns.said('s1', said({ result: 'Done' }))
    turns.forget('s1')
    turns.forget('s2')
    expect(turns.take('s1')).toBeNull()
    expect(turns.take('s2')).toBeNull()
  })
})
