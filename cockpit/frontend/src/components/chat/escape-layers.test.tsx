// @vitest-environment jsdom
// One Esc, one layer, innermost first: the chat inside a task's slide-over
// takes the press before the slide-over does. A running agent stops, the panel stays; the next
// Esc closes the panel. The search in the chat closes before the panel too.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';

import { Sheet } from '@/shared/view/ui/Sheet';

import { ChatSearch } from './ChatSearch';
import { Composer } from './Composer';
import { EMPTY_CHAT } from './chat-state';
import { useChatShortcuts } from './useChatShortcuts';

afterEach(cleanup);

function Panel({ onStop, onClose, search = false }: { onStop: () => void; onClose: () => void; search?: boolean }) {
  const [open, setOpen] = useState(true);
  const [running, setRunning] = useState(true);
  const [searching, setSearching] = useState(search);
  const root = useRef<HTMLElement | null>(null);
  const stop = () => { onStop(); setRunning(false); };
  // As in ChatPane: the window handler stops a turn when the key lands outside the input.
  useChatShortcuts(root, running, true, stop, () => {}, () => setSearching(true));
  return (
    <Sheet open={open} onClose={() => { onClose(); setOpen(false); }} labelledBy="panel-title">
      <h2 id="panel-title">Task</h2>
      <section ref={root}>
        {searching && <ChatSearch items={[]} opened={new Set()} root={root} onReveal={() => {}} onUnpin={() => {}} onClose={() => setSearching(false)} />}
        <Composer
          sessionId="s-esc" running={running} status={null} chat={EMPTY_CHAT} session={null}
          onUse={() => {}} onSend={() => true} onStop={stop} onSetMode={() => true} onStopAgent={() => {}} onSetModel={() => true}
        />
      </section>
    </Sheet>
  );
}

const input = () => screen.getByRole('textbox', { name: /message/i });

describe('Esc in a task panel chat', () => {
  it('stops a running agent and leaves the panel open; the next Esc closes the panel', () => {
    const onStop = vi.fn(); const onClose = vi.fn();
    render(<Panel onStop={onStop} onClose={onClose} />);

    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();

    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes the search first, then stops, then closes the panel', () => {
    const onStop = vi.fn(); const onClose = vi.fn();
    render(<Panel onStop={onStop} onClose={onClose} search />);

    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Search the conversation' }), { key: 'Escape' });
    expect(screen.queryByRole('search')).toBeNull();
    expect(onStop).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(input(), { key: 'Escape' });
    expect([onStop.mock.calls.length, onClose.mock.calls.length]).toEqual([1, 0]);

    fireEvent.keyDown(input(), { key: 'Escape' });
    expect([onStop.mock.calls.length, onClose.mock.calls.length]).toEqual([1, 1]);
  });

  it('closes the panel at once when nothing runs', () => {
    const onClose = vi.fn();
    function Idle() {
      const [open, setOpen] = useState(true);
      return (
        <Sheet open={open} onClose={() => { onClose(); setOpen(false); }} labelledBy="idle-title">
          <h2 id="idle-title">Task</h2>
          <Composer
            sessionId="s-idle" running={false} status={null} chat={EMPTY_CHAT} session={null}
            onUse={() => {}} onSend={() => true} onStop={() => {}} onSetMode={() => true} onStopAgent={() => {}} onSetModel={() => true}
          />
        </Sheet>
      );
    }
    render(<Idle />);
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
