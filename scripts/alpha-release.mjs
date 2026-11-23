#!/usr/bin/env node
// The alpha line's pre-releases (.github/workflows/alpha-release.yml).
//
//   node scripts/alpha-release.mjs version   prints the next version, X.Y.Z-alpha.N
//   node scripts/alpha-release.mjs notes <version>
//                                            writes docs/release-notes/v<version>.md
//
// X.Y.Z comes from package.json. N is one above the highest v<X.Y.Z>-alpha.<N>
// tag, and never below the N in package.json; the tags are the counter, so a
// failed run takes no number. The notes are marked experimental and list what
// came in since the previous alpha tag (or since main, for the first): the pull
// requests merged into alpha by their title, other commits by their subject.
// A notes file committed for that version (hand-written, for a milestone) is
// kept, with "(Experimental)" added to its title when it lacks it.
// `gh` reads the titles of merged pull requests; without it the merge subject stays.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()

export function nextAlphaVersion(packageVersion, tags) {
  const m = packageVersion.match(/^(\d+\.\d+\.\d+)(?:-alpha\.(\d+))?$/)
  if (!m) throw new Error(`package.json version '${packageVersion}' is not X.Y.Z or X.Y.Z-alpha.N`)
  const [, base, floor] = m
  const taken = tags
    .map((tag) => tag.match(new RegExp(`^v${base.replaceAll('.', '\\.')}-alpha\\.(\\d+)$`)))
    .filter(Boolean)
    .map((t) => Number(t[1]))
  const n = Math.max(Number(floor ?? 1), ...taken.map((t) => t + 1))
  return `${base}-alpha.${n}`
}

// One bullet per first-parent commit: a merged pull request by its title, a
// squash merge without its "(#N)", anything else by its subject.
export function noteLines(commits, prTitle) {
  return commits.map(({ subject }) => {
    const merge = subject.match(/^Merge pull request #(\d+) from \S+/)
    if (merge) return `- ${prTitle(Number(merge[1])) ?? subject} (#${merge[1]})`
    const squash = subject.match(/^(.*) \(#(\d+)\)$/)
    if (squash) return `- ${squash[1]} (#${squash[2]})`
    return `- ${subject}`
  })
}

export function renderNotes(version, lines) {
  return [
    `## EML v${version} (Experimental)`,
    '',
    'An experimental pre-release of the alpha line, built from the `alpha` branch. Early builds for testing: things may break,',
    'and a shared space stays compatible only while every member runs the same alpha. Offered only to cockpits on the',
    'Alpha (experimental) channel (Settings › About › Updates).',
    '',
    "### What's new",
    '',
    ...(lines.length > 0 ? lines : ['- No changes since the previous alpha.']),
    '',
  ].join('\n')
}

export function keepCommittedNotes(version, committed) {
  const lines = committed.split('\n')
  const title = lines.findIndex((line) => /^#{1,2}\s/.test(line))
  if (title >= 0 && !/\(Experimental\)/.test(lines[title])) lines[title] = `${lines[title].trimEnd()} (Experimental)`
  if (title < 0) lines.unshift(`## EML v${version} (Experimental)`, '')
  return lines.join('\n')
}

function previousRef(version) {
  const base = version.replace(/-.*$/, '')
  const tags = git('tag', '-l', `v${base}-alpha.*`, '--merged', 'HEAD').split('\n').filter(Boolean)
  const older = tags.filter((t) => t !== `v${version}`).sort((a, b) => Number(a.split('.').pop()) - Number(b.split('.').pop()))
  return older.pop() ?? git('merge-base', 'HEAD', 'origin/main')
}

function prTitleFromGh(number) {
  try {
    return execFileSync('gh', ['pr', 'view', String(number), '--json', 'title', '-q', '.title'], { encoding: 'utf8' }).trim() || null
  } catch {
    return null
  }
}

function main() {
  const [command, version] = process.argv.slice(2)
  if (command === 'version') {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')).version
    console.log(nextAlphaVersion(pkg, git('tag', '-l', 'v*').split('\n').filter(Boolean)))
    return
  }
  if (command === 'notes' && version) {
    const file = `docs/release-notes/v${version}.md`
    if (existsSync(file)) {
      writeFileSync(file, keepCommittedNotes(version, readFileSync(file, 'utf8')))
      console.log(`[alpha] ${file}: committed notes kept`)
      return
    }
    const log = git('log', '--first-parent', '--format=%s', `${previousRef(version)}..HEAD`)
    const commits = log.split('\n').filter(Boolean).map((subject) => ({ subject }))
    writeFileSync(file, renderNotes(version, noteLines(commits, prTitleFromGh)))
    console.log(`[alpha] ${file}: ${commits.length} changes`)
    return
  }
  console.error('usage: alpha-release.mjs version | notes <version>')
  process.exit(1)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
