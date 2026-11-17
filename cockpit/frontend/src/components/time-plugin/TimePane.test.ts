import { describe, expect, it } from 'vitest';

import { formatSeconds, sumDays } from './TimePane';

describe('the Time view', () => {
  it('writes durations as minutes and hours', () => {
    expect(formatSeconds(0)).toBe('0m');
    expect(formatSeconds(20)).toBe('<1m');
    expect(formatSeconds(42 * 60)).toBe('42m');
    expect(formatSeconds(3 * 3600 + 5 * 60 + 30)).toBe('3h 05m');
  });

  it('adds the days up per project, task and session', () => {
    const day = (user: number, agent: number) => ({
      date: '', user,
      projects: { p1: { user, agent } },
      tasks: { t1: { user, agent, projectId: 'p1' } },
      sessions: { s1: { user, agent, projectId: 'p1', taskId: 't1' } },
    });
    const total = sumDays([day(60, 10), day(120, 0)]);
    expect(total.user).toBe(180);
    expect(total.projects.p1).toEqual({ user: 180, agent: 10 });
    expect(total.tasks.t1).toEqual({ user: 180, agent: 10, projectId: 'p1' });
    expect(total.sessions.s1.taskId).toBe('t1');
  });
});
