// The fake agent CLI's --version (managed-runtime.test.ts): the copied node runs
// this and says the version its publisher wrote next to it.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

process.stdout.write(`tool ${readFileSync(join(dirname(process.execPath), 'claims'), 'utf8')}\n`)
