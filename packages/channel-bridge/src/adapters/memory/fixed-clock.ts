import type { Clock } from '../../ports/clock'

export class FixedClock implements Clock {
  constructor(private current: string) {}

  now(): string {
    return this.current
  }

  advance(ms: number): void {
    this.current = new Date(Date.parse(this.current) + ms).toISOString()
  }
}
