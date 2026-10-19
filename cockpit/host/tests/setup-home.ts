import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// No test may touch a real cockpit home: paths.ts reads EML_COCKPIT_HOME when it is
// first imported, and a static import of a module that pulls it in runs before a
// test's own `process.env.EML_COCKPIT_HOME = …`. Every test file starts with a
// throwaway home; a test that sets its own still wins for its dynamic imports.
process.env.EML_COCKPIT_HOME = mkdtempSync(join(tmpdir(), 'cockpit-test-home-'))
