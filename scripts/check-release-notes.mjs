#!/usr/bin/env node
// A release's notes, docs/release-notes/v<version>.md, need a "### What's new"
// section with at least one bullet: the cockpit shows those bullets after an
// update (extractReleaseHighlights in cockpit/host/src/app-update.ts reads the
// same heading). Run by CI on a release branch and by pack-release.sh.
// Usage: node scripts/check-release-notes.mjs [version]  (default: package.json's)
import { readFileSync } from 'node:fs'

const version = process.argv[2] ?? JSON.parse(readFileSync('package.json', 'utf8')).version
const file = `docs/release-notes/v${version}.md`
let notes
try {
  notes = readFileSync(file, 'utf8')
} catch {
  console.error(`[release notes] ${file} is missing`)
  process.exit(1)
}

const lines = notes.split(/\r?\n/)
const start = lines.findIndex((line) => /^###\s+what['’]s new\s*$/i.test(line.trim()))
const end = lines.findIndex((line, i) => start >= 0 && i > start && /^#{1,3}\s/.test(line.trim()))
const bullets = start < 0 ? [] : lines.slice(start + 1, end < 0 ? undefined : end).filter((line) => /^\s*[-*+]\s+\S/.test(line))
if (bullets.length === 0) {
  console.error(`[release notes] ${file} needs a "### What's new" section with at least one bullet`)
  process.exit(1)
}
console.log(`[release notes] ${file}: ${bullets.length} highlights`)
