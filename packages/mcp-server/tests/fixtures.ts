// Shared fixtures for the MCP write tools in tests. v0.19: eml_decide needs a
// title, a rationale and at least one alternative; eml_create_task a title.
// Tests that are not about those rules build their tool arguments through
// these helpers. Overrides win.

type Args = Record<string, unknown>

/** eml_decide arguments that pass validation. */
export function validDecideArgs(overrides: Args = {}): Args {
  return {
    content: 'chose the test option',
    scope: 'global',
    title: 'test-decision',
    rationale: 'test rationale',
    alternatives: ['test alternative'],
    ...overrides,
  }
}

/** eml_create_task arguments that pass validation. */
export function validTaskArgs(overrides: Args = {}): Args {
  return {
    content: 'a test task',
    scope: 'global',
    title: 'test-task',
    ...overrides,
  }
}
