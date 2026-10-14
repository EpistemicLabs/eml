// v0.15 Cluster 0 — shared fixtures for the MCP write tools in tests. eml_decide
// needs at least one alternative and a rationale; eml_track_task closing a task
// as resolved/invalidated needs an outcome. Tests that are not about those rules
// build their tool arguments through these helpers. Overrides win.

type Args = Record<string, unknown>

/** eml_decide arguments that pass validation. */
export function validDecideArgs(overrides: Args = {}): Args {
  return {
    content: 'chose the test option',
    scope: 'global',
    rationale: 'test rationale',
    alternatives: ['test alternative'],
    ...overrides,
  }
}

/** eml_track_task arguments; closed as resolved/invalidated they carry an outcome. */
export function validTaskArgs(overrides: Args = {}): Args {
  const closed = overrides.status === 'resolved' || overrides.status === 'invalidated'
  return {
    content: 'a test task',
    scope: 'global',
    ...(closed ? { outcome: 'test outcome' } : {}),
    ...overrides,
  }
}
