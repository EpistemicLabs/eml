import { describe, expect, it } from 'vitest';

import type { BoardTask } from '@/lib/task-board';

import { clearTaskPanelRequest, requestTaskPanel, taskPanelRequestTask } from './useTaskViewStore';

describe('a request for a task\'s panel', () => {
  const old = { id: 'old', spaceId: 'main', status: 'resolved' } as BoardTask;

  it('carries the task itself for one the board does not hold, until the board takes it', () => {
    requestTaskPanel('old', old);
    expect(taskPanelRequestTask()).toBe(old);
    clearTaskPanelRequest();
    expect(taskPanelRequestTask()).toBeNull();
  });

  it('carries no task when only the id is asked for, or the task is another one', () => {
    requestTaskPanel('old');
    expect(taskPanelRequestTask()).toBeNull();
    requestTaskPanel('other', old);
    expect(taskPanelRequestTask()).toBeNull();
    clearTaskPanelRequest();
  });
});
