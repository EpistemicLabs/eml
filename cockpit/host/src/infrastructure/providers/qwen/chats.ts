import * as fs from 'node:fs'
import * as path from 'node:path'
import { QWEN_CONFIG_DIR } from '../../../paths.js'

/**
 * Where Qwen Code keeps a conversation: QWEN_HOME/projects/<project dir>/chats/<id>.jsonl,
 * one JSON record per line, the same file for a terminal session and one in the chat.
 */
export function findChat(providerSessionId: string, qwenHome: string = QWEN_CONFIG_DIR): string | null {
  const projects = path.join(qwenHome, 'projects')
  let dirs: string[]
  try { dirs = fs.readdirSync(projects) } catch { return null }
  for (const dir of dirs) {
    const file = path.join(projects, dir, 'chats', `${providerSessionId}.jsonl`)
    if (fs.existsSync(file)) return file
  }
  return null
}

/** The records of a chat file, oldest first; a line that is no JSON object is left out. */
export function readChatRecords(file: string): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = []
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue
    try {
      const record = JSON.parse(line) as unknown
      if (record && typeof record === 'object' && !Array.isArray(record)) records.push(record as Record<string, unknown>)
    } catch { /* a line cut off mid-write */ }
  }
  return records
}
