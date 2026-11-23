/** A status hue (tokens v2): colour only for Needs you and stopped; every other state is a grey with a label. */
export type Hue = 'you' | 'stopped' | 'review' | 'agent' | 'scheduled' | 'waiting' | 'done' | 'mark';

/** Tailwind needs whole class names in the source, so each hue spells its classes out. */
export const HUE: Record<Hue, { ink: string; dot: string; tint: string; chip: string; edge: string; rule: string }> = {
  you: { ink: 'text-you-ink', dot: 'bg-status-you', tint: 'bg-status-you/10', chip: 'bg-status-you/12', edge: 'border-status-you/40', rule: 'border-status-you' },
  stopped: { ink: 'text-stopped-ink', dot: 'bg-status-stopped', tint: 'bg-status-stopped/10', chip: 'bg-status-stopped/12', edge: 'border-status-stopped/40', rule: 'border-status-stopped' },
  review: { ink: 'text-review-ink', dot: 'bg-status-review', tint: 'bg-status-review/10', chip: 'bg-status-review/12', edge: 'border-status-review/40', rule: 'border-status-review' },
  agent: { ink: 'text-agent-ink', dot: 'bg-status-agent', tint: 'bg-status-agent/10', chip: 'bg-status-agent/12', edge: 'border-status-agent/40', rule: 'border-status-agent' },
  scheduled: { ink: 'text-scheduled-ink', dot: 'bg-status-scheduled', tint: 'bg-status-scheduled/10', chip: 'bg-status-scheduled/12', edge: 'border-status-scheduled/40', rule: 'border-status-scheduled' },
  waiting: { ink: 'text-waiting-ink', dot: 'bg-status-waiting', tint: 'bg-status-waiting/10', chip: 'bg-status-waiting/12', edge: 'border-status-waiting/40', rule: 'border-status-waiting' },
  done: { ink: 'text-done-ink', dot: 'bg-status-done', tint: 'bg-status-done/10', chip: 'bg-status-done/12', edge: 'border-status-done/40', rule: 'border-status-done' },
  mark: { ink: 'text-mark-ink', dot: 'bg-mark', tint: 'bg-mark/10', chip: 'bg-mark/12', edge: 'border-mark/40', rule: 'border-mark' },
};
