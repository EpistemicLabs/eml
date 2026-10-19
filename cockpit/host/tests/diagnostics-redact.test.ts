import { describe, it, expect } from 'vitest'
import { createRedactor } from '../src/diagnostics/redact.js'

// What `eml-cockpit diagnose` prints goes into a public GitHub issue: nothing
// personal and no secret may survive the redaction.

const redact = createRedactor({
  cockpitHome: '/Users/jane/.eml-cockpit',
  home: '/Users/jane',
  user: 'jane',
  paths: ['/Users/jane/code/acme-shop', '/Users/jane/Private Notes', 'C:\\Users\\jane\\work\\acme-shop'],
  names: ['Acme Shop', 'access supabase pls', 'eml'],
})

describe('diagnostics redaction', () => {
  it('replaces known project folders and names, longest first, in either separator style', () => {
    expect(redact('[pty] starting session in /Users/jane/Private Notes (pane p-1)')).toMatch(/^\[pty\] starting session in <project-\d> \(pane p-1\)$/)
    expect(redact('cwd C:/Users/jane/work/acme-shop/src')).toMatch(/^cwd <project-\d>\/src$/)
    // The longer folder wins over the one it contains a name of.
    expect(redact('cwd /Users/jane/code/acme-shop')).not.toContain('acme')
    expect(redact('project "Acme Shop" and access supabase pls')).toMatch(/^project "<name-\d>" and <name-\d>$/)
  })

  it('keeps the cockpit home readable and hides every other folder below the home', () => {
    expect(redact('log at /Users/jane/.eml-cockpit/host.log')).toBe('log at <cockpit-home>/host.log')
    const out = redact('opened /Users/jane/Documents/clients/bigco/report.pdf')
    expect(out).toMatch(/^opened ~\/<path-[0-9a-f]{6}>$/)
    expect(out).not.toMatch(/clients|bigco|jane/)
  })

  it('removes secrets and e-mail addresses', () => {
    const out = redact([
      'token eml_abcDEF123_secretpart',
      'Authorization: Bearer abc.def-ghi',
      'hook token 0123456789abcdef0123456789abcdef',
      'key sk-ant-api03-ABCDEFGHIJKLMNOPQRST',
      'gh ghp_ABCDEFGHIJKLMNOPQRSTUV',
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.c2lnbmF0dXJl',
      'mail jane.doe@example.com',
      'url http://127.0.0.1:4317/api/hook?k=0123',
    ].join('\n'))
    expect(out).not.toMatch(/secretpart|abc\.def|0123456789abcdef|ABCDEFGHIJ|eyJzdWIi|jane\.doe|k=0123/)
    expect(out).toContain('Bearer <token>')
    expect(out).toContain('http://127.0.0.1:4317/api/hook?<query>')
  })

  it('hashes ids the same way each time, so one session can be followed', () => {
    const line = (id: string) => redact(`[pty] reattached session ${id}`)
    const a = line('22e80d4e-2710-43b7-88d9-6d71dad18ab1')
    expect(a).toMatch(/<id-[0-9a-f]{6}>$/)
    expect(line('22E80D4E-2710-43B7-88D9-6D71DAD18AB1')).toBe(a)
    expect(line('9c1417a9-3cf5-4adf-ac37-2e91df0cb319')).not.toBe(a)
  })

  it('replaces the user name, but not short names that would hit ordinary words', () => {
    expect(redact('owner jane, brain eml running')).toBe('owner <user>, brain eml running')
  })
})
