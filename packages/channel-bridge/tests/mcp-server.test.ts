import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createJobToolsServer, startJobToolsServer } from '../src/entrypoints/mcp-server'

let root: string
let client: Client

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'channel-bridge-mcp-'))
  writeFileSync(join(root, 'tool-token'), 'tool\n')
  writeFileSync(join(root, 'url'), 'http://127.0.0.1:1\n')
  const server = createJobToolsServer({
    CHANNEL_BRIDGE_URL_FILE: join(root, 'url'), CHANNEL_BRIDGE_JOB_ID: 'job-1', CHANNEL_BRIDGE_TOOL_TOKEN_FILE: join(root, 'tool-token'),
  })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  client = new Client({ name: 'test', version: '0.0.0' })
  await client.connect(clientSide)
})
afterAll(async () => {
  await client.close()
  rmSync(root, { recursive: true, force: true })
})

describe('job tools MCP server', () => {
  it('offers exactly msg_read and msg_reply', async () => {
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name).sort()).toEqual(['msg_read', 'msg_reply'])
  })

  it('answers a tool call with text, also when the bridge is away', async () => {
    const result = await client.callTool({ name: 'msg_read', arguments: {} })
    expect(JSON.stringify(result.content)).toMatch(/cannot reach the bridge/i)
  })

  it('rejects a reply without text', async () => {
    const result = await client.callTool({ name: 'msg_reply', arguments: { message_id: 'msg-1', text: '' } })
    expect(result.isError).toBe(true)
  })

  it('refuses to start without its environment', async () => {
    await expect(startJobToolsServer({})).rejects.toThrow('CHANNEL_BRIDGE_URL_FILE')
  })
})
