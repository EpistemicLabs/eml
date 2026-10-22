import { defineConfig } from 'vitest/config'

/**
 * Root vitest-Config (alle Workspace-Pakete erben das).
 *
 * pool='forks' statt default 'threads': better-sqlite3 11.x hat auf Node 23
 * einen GC-Race, der beim Process-Exit gelegentlich SIGSEGV erzeugt
 * (Tests passen, aber exit-code ≠ 0). Forks isolieren das pro Test-File und
 * die Test-Ergebnisse aggregiert vitest selbst — der parent-Prozess sieht
 * sauberen Exit.
 */
export default defineConfig({
  test: {
    pool: 'forks',
    // The migration tests run the real forward-migration pipeline on brain
    // files; on Windows CI runners one test takes 10-15s. vitest 4 fails a
    // synchronous test that overruns, vitest 1 did not.
    testTimeout: 60_000,
  },
})
