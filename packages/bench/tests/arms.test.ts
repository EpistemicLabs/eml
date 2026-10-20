import { describe, it, expect } from 'vitest'
import { renderClaudeMd } from '../src/arms'

describe('renderClaudeMd', () => {
  const md = renderClaudeMd(Date.parse('2026-10-20T00:00:00Z'))

  it('keeps current decisions and leaves superseded ones out', () => {
    expect(md).toContain('Deutsche Post Warenpost')
    expect(md).not.toContain('Ship all parcels with DHL.')
  })

  it('keeps only the latest status of a scope', () => {
    expect(md).toContain('Shop is live on Shopify')
    expect(md).not.toContain('Checkout takes about 4 seconds')
  })

  it('keeps silent contradictions, as EML does', () => {
    expect(md).toContain('Weekly stall at the Saturday market')
    expect(md).toContain('Gave up the Saturday stall')
  })

  it('dates entries and names situational rules by their trigger', () => {
    expect(md).toMatch(/- \d{4}-\d{2}-\d{2} \(rule, when deploying anything to production\)/)
  })
})
