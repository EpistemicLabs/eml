import { describe, it, expect } from 'vitest'
// @ts-expect-error -- a plain node script without types (scripts/alpha-release.mjs)
import { keepCommittedNotes, nextAlphaVersion, noteLines, renderNotes } from '../../../scripts/alpha-release.mjs'
import { extractReleaseHighlights } from '../src/app-update.js'

// The alpha pre-releases the updater's alpha channel offers (.github/workflows/alpha-release.yml).
describe('alpha release script', () => {
  it('numbers the next alpha one above the highest tag of the same version', () => {
    expect(nextAlphaVersion('0.22.0-alpha.1', [])).toBe('0.22.0-alpha.1')
    expect(nextAlphaVersion('0.22.0-alpha.1', ['v0.21.5', 'v0.22.0-alpha.1', 'v0.22.0-alpha.9', 'v0.22.0-alpha.10'])).toBe('0.22.0-alpha.11')
    // another version's alphas and look-alike tags do not count
    expect(nextAlphaVersion('0.22.0-alpha.1', ['v0.23.0-alpha.4', 'v0.22.0-alpha.2-fix', 'v0.22.0-beta.7'])).toBe('0.22.0-alpha.1')
    // package.json can raise the floor, and a plain X.Y.Z starts at 1
    expect(nextAlphaVersion('0.22.0-alpha.5', ['v0.22.0-alpha.2'])).toBe('0.22.0-alpha.5')
    expect(nextAlphaVersion('0.23.0', [])).toBe('0.23.0-alpha.1')
  })

  it('refuses a version that is not on the alpha line', () => {
    expect(() => nextAlphaVersion('0.22.0-rc.1', [])).toThrow(/not X\.Y\.Z/)
  })

  it('lists merged pull requests by title, squash merges and other commits by subject', () => {
    const titles: Record<number, string> = { 240: 'Cockpit: task tree drag and drop' }
    expect(noteLines([
      { subject: 'Merge pull request #240 from EpistemicLabs/feat/task-tree-dnd' },
      { subject: 'Merge pull request #241 from EpistemicLabs/fix/x' },
      { subject: 'fix(cockpit): the banner closes (#242)' },
      { subject: 'chore: 0.22.0-alpha.1, the first version of the alpha line' },
    ], (n: number) => titles[n] ?? null)).toEqual([
      '- Cockpit: task tree drag and drop (#240)',
      '- Merge pull request #241 from EpistemicLabs/fix/x (#241)',
      '- fix(cockpit): the banner closes (#242)',
      '- chore: 0.22.0-alpha.1, the first version of the alpha line',
    ])
  })

  it("marks the notes experimental, and the updater reads their What's new", () => {
    const notes = renderNotes('0.22.0-alpha.2', ['- one (#1)'])
    expect(notes).toMatch(/^## EML v0\.22\.0-alpha\.2 \(Experimental\)/)
    expect(notes).toMatch(/things may break/)
    expect(extractReleaseHighlights(notes)).toEqual(['one (#1)'])
    expect(extractReleaseHighlights(renderNotes('0.22.0-alpha.3', []))).toEqual(['No changes since the previous alpha.'])
  })

  it('keeps committed notes and marks their title experimental once', () => {
    expect(keepCommittedNotes('0.22.0-alpha.1', "## EML v0.22.0-alpha.1\n\n### What's new\n- a\n")).toBe("## EML v0.22.0-alpha.1 (Experimental)\n\n### What's new\n- a\n")
    expect(keepCommittedNotes('0.22.0-alpha.1', '## EML v0.22.0-alpha.1 (Experimental)\n')).toBe('## EML v0.22.0-alpha.1 (Experimental)\n')
    expect(keepCommittedNotes('0.22.0-alpha.1', "### What's new\n- a\n")).toMatch(/^## EML v0\.22\.0-alpha\.1 \(Experimental\)\n\n### What's new/)
  })
})
