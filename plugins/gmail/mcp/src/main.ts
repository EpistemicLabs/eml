import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createGmailServer } from './server'

export { createGmailServer } from './server'
export { GoogleApi, refusalText, type ApiResult, type Refusal } from './google-api'
export { Calendar, Mailbox, addressesOf } from './tools'

if (require.main === module) {
  try {
    void createGmailServer(process.env).connect(new StdioServerTransport())
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`)
    process.exit(1)
  }
}
