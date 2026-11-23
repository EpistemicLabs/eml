import { beforeEach, describe, expect, it } from 'vitest';

import { getTaskBoardPage, openItemIn, resetTaskBoardPage, setFold, setOpenItem } from './useTaskBoardPageStore';

beforeEach(() => resetTaskBoardPage());

describe('the task board page store', () => {
  it('starts with nothing open, FYI and Snoozed folded, and Unread left to the Inbox', () => {
    expect(getTaskBoardPage()).toEqual({ open: null, folds: { fyi: false, snoozed: false, unread: null } });
  });

  it('keeps each fold as it was set', () => {
    setFold('unread', false);
    setFold('snoozed', true);
    expect(getTaskBoardPage().folds).toEqual({ fyi: false, snoozed: true, unread: false });
  });

  it('shows the open item only in the view it was opened in', () => {
    setOpenItem({ sessionId: 's1' }, 'inbox');
    expect(openItemIn(getTaskBoardPage(), 'inbox')).toEqual({ sessionId: 's1' });
    expect(openItemIn(getTaskBoardPage(), 'now')).toBeNull();
    setOpenItem({ taskId: 't1', sessionId: 's2' }, 'now');
    expect(openItemIn(getTaskBoardPage(), 'inbox')).toBeNull();
    setOpenItem(null, 'now');
    expect(getTaskBoardPage().open).toBeNull();
  });
});
