import { parentPort } from 'worker_threads'
import Database from 'better-sqlite3'
import { CommandError, EML } from '@engramprotocol/core'
import { runRead, type ReadAnswer, type ReadArgs, type ReadKind } from './reads'

// --- A read worker (read-pool.ts starts it) ---------------------------------------------
//
// One thread that runs the reads of reads.ts for the request thread. Each job
// opens the brain file read-only, runs one read and closes it again: in WAL
// mode a reader sees everything committed before it started, beside the
// server's writing connection, and a connection that lives for one job never
// holds on to a brain file that a move, a restore or a discard replaced.
// A worker never writes.

/** One read, as the pool hands it over. */
export interface ReadJob<K extends ReadKind = ReadKind> {
  /** The brain file, absolute. */
  file: string
  /** The brain's name (the EML namespace). */
  name: string
  kind: K
  args: ReadArgs<K>
}

/** What the worker answers a job with: the read's answer, or what it threw (its message, and the code of a rejected command). */
export type ReadReply = { ok: true, answer: ReadAnswer } | { ok: false, error: string, code?: string }

/** What a read threw, as it crosses to the request thread. */
export function thrown(err: unknown): { error: string, code?: string } {
  return { error: err instanceof Error ? err.message : String(err), ...(err instanceof CommandError ? { code: err.code } : {}) }
}

/** Run `job` on a read-only connection of its own. */
export function readJob(job: ReadJob): ReadAnswer {
  const db = new Database(job.file, { readonly: true, fileMustExist: true })
  try {
    return runRead(EML.fromConnection(db, job.name), db, job.kind, job.args)
  } finally {
    db.close()
  }
}

parentPort?.on('message', (job: ReadJob) => {
  let reply: ReadReply
  try {
    reply = { ok: true, answer: readJob(job) }
  } catch (err) {
    reply = { ok: false, ...thrown(err) }
  }
  parentPort!.postMessage(reply)
})
