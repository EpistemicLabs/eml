#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const version = process.argv[2] ?? JSON.parse(readFileSync('package.json', 'utf8')).version
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`[release notes] invalid version: ${version}`)
  process.exit(1)
}

const file = resolve(`docs/release-notes/v${version}.md`)
let notes
try {
  notes = readFileSync(file, 'utf8')
} catch {
  console.error(`[release notes] required file is missing: docs/release-notes/v${version}.md`)
  process.exit(1)
}

const lines = notes.split(/\r?\n/)
const headingIndex = lines.findIndex((line) => /^#{3}\s+what's new\s*#*\s*$/i.test(line.trim()))
if (headingIndex < 0) {
  console.error(`[release notes] docs/release-notes/v${version}.md must contain a "What's new" section`)
  process.exit(1)
}

const headingLevel = (lines[headingIndex].match(/^#+/)?.[0].length ?? 3)
const nextHeading = lines.findIndex((line, index) => index > headingIndex && new RegExp(`^#{1,${headingLevel}}\\s+`).test(line.trim()))
const section = lines.slice(headingIndex + 1, nextHeading < 0 ? lines.length : nextHeading)
if (!section.some((line) => /^\s*[-*+]\s+\S/.test(line))) {
  console.error(`[release notes] the "What's new" section in docs/release-notes/v${version}.md must contain at least one bullet`)
  process.exit(1)
}

console.log(`[release notes] v${version} has user-facing highlights`)
