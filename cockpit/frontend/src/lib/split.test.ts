import { describe, expect, it } from 'vitest';

import { closesPaneOnUndo, sessionToOpen } from './split';

// A split onto a task that already had its session sends that session the brief: the page opens it, and Undo leaves
// it running. A session the split started opens from the queue and closes on Undo.

describe('a split and its session', () => {
  it('opens the session the brief went to, and nothing for a session the split started', () => {
    expect(sessionToOpen({ sessionId: 's-task', routed: true })).toBe('s-task');
    expect(sessionToOpen({ sessionId: 's-new' })).toBeNull();
    expect(sessionToOpen({ routed: true })).toBeNull();
  });

  it('closes the pane on Undo only for a session the split started', () => {
    expect(closesPaneOnUndo({ sessionId: 's-new' })).toBe(true);
    expect(closesPaneOnUndo({ sessionId: 's-task', routed: true })).toBe(false);
    expect(closesPaneOnUndo({})).toBe(false);
  });
});
