import { contractId } from '@engramprotocol/core'
import { selfTest, type SelfTestResult } from '@engramprotocol/core/dist/log/self-test'

// What this build is, checked once when the server starts: the contract id of
// its shape tables, and whether it replays the frozen log of its schema to the
// state the release froze (core log/self-test.ts). A build that fails the
// self-test derives another state from a log than the release does; the sync
// client keeps such a build from writing to a shared brain.

export interface BuildCheck {
  /** The contract id of this build, or null when its contract cannot be generated (the frozen log is missing). */
  contract: string | null
  self_test: SelfTestResult
}

function check(): BuildCheck {
  const self_test = selfTest()
  let contract: string | null = null
  try { contract = contractId() } catch { /* the self-test names the problem */ }
  return { contract, self_test }
}

export const BUILD_CHECK: BuildCheck = check()

/** One line for the server's start log. */
export function buildCheckLine(build: BuildCheck = BUILD_CHECK): string {
  const t = build.self_test
  return t.ok
    ? `[self-test] passed: schema ${t.schema}, ${t.entries} frozen entries, contract ${build.contract}`
    : `[self-test] FAILED: schema ${t.schema}: ${t.problem}`
}
