// A tool's name as a person reads it: `mcp__gmail__send_email` → "Gmail · Send email".
// Built-in tools (Bash, SendMessage) keep their own name. The chat view has the same rule
// (frontend/src/components/chat/tool-label.ts); the agent is always told the exact name.

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

function serverLabel(server: string): string {
  if (server.startsWith('claude_ai_')) return `claude.ai ${server.slice('claude_ai_'.length).replace(/_/g, ' ')}`
  const [name, ...account] = server.split('-')
  return `${sentence(name)}${account.length ? ` (${account.join('-')})` : ''}`
}

export function toolLabel(name: string): string {
  const match = /^mcp__(.+?)(?:__(.+))?$/.exec(name)
  if (!match) return name
  const [, server, tool] = match
  return `${serverLabel(server)} · ${tool ? sentence(tool.replace(/_/g, ' ')) : 'all tools'}`
}
