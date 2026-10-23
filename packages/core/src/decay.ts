// Scoring helpers for engrams.query({ order_by: 'score' }): significanceWeight
// and recencyBoost.

/**
 * Significance to numeric weight for ranking.
 */
export function significanceWeight(significance: string): number {
  switch (significance) {
    case 'critical': return 1.0
    case 'high':     return 0.75
    case 'normal':   return 0.5
    case 'low':      return 0.25
    case 'trivial':  return 0.1
    default:         return 0.5
  }
}

/**
 * Recency boost: newer claims score slightly higher.
 * Returns 0.5-1.0 based on age (1.0 = today, 0.5 = 365+ days).
 */
export function recencyBoost(createdAt: string, nowMs: number = Date.now()): number {
  const ageDays = daysSince(createdAt, nowMs)
  return Math.max(0.5, 1 - ageDays / 730) // half-value at 365 days
}

// === Helpers ===

function daysSince(isoDate: string, nowMs: number): number {
  return Math.max(0, (nowMs - toMs(isoDate)) / (1000 * 60 * 60 * 24))
}

function toMs(isoDate: string): number {
  return new Date(isoDate.includes('T') ? isoDate : isoDate + 'T00:00:00Z').getTime()
}
