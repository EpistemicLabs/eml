import { describe, expect, it } from 'vitest'

import { toolLabel } from '../src/domain/tool-label.js'

describe('toolLabel', () => {
  it('names an MCP tool by its server and what it does', () => {
    expect(toolLabel('mcp__gmail__send_email')).toBe('Gmail · Send email')
    expect(toolLabel('mcp__gmail__reply_to_email')).toBe('Gmail · Reply to email')
  })

  it('keeps a second account of a server apart', () => {
    expect(toolLabel('mcp__gmail-invoice__send_email')).toBe('Gmail (invoice) · Send email')
  })

  it('reads a claude.ai connector as one', () => {
    expect(toolLabel('mcp__claude_ai_Slack__slack_send_message')).toBe('claude.ai Slack · Slack send message')
  })

  it('names a whole server when no tool is given', () => {
    expect(toolLabel('mcp__stripe')).toBe('Stripe · all tools')
  })

  it('leaves a built-in tool as it is', () => {
    expect(toolLabel('Bash')).toBe('Bash')
    expect(toolLabel('SendMessage')).toBe('SendMessage')
  })
})
