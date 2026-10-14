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
  },
})
