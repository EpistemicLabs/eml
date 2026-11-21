// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const fx = vi.hoisted(() => ({
  activated: [] as string[],
  sessions: [] as Array<{ id: string; attention?: { kind: string } }>,
  turns: {} as Record<string, { state: string; since: string }>,
}));

vi.mock('@/stores/usePaneStore', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useDesks: () => [
    { id: 'd1', name: 'SEO', spaceId: null, panes: [{ id: 'p1', sessionId: 's-done' }, { id: 'p2', sessionId: 's-seen' }] },
    { id: 'd2', name: 'Desk 1', spaceId: null, panes: [{ id: 'p3', sessionId: 's-failed' }] },
    { id: 'd3', name: 'Desk 1', spaceId: 'eml', panes: [{ id: 'p4', sessionId: 's-asks' }] },
  ],
  useActiveDeskId: () => 'd1',
  useActiveSpaceId: () => null,
  activateDesk: (id: string) => { fx.activated.push(id); },
  activateSpace: () => {},
}));
vi.mock('@/stores/useSpaceStore', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useSpaces: () => [{ id: 'main', name: 'Main', main: true }, { id: 'eml', name: 'EML', main: false }],
  loadSpaces: async () => [],
}));
vi.mock('@/components/sidebar/useAllSessions', () => ({ useAllSessions: () => ({ sessions: fx.sessions, queued: [], refresh: () => {} }) }));
vi.mock('@/stores/useTurnStateStore', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTurnStore: () => ({ turns: fx.turns, seen: { 's-seen': 'b' } }),
}));

import { getTaskView } from '@/stores/useTaskViewStore';
import { getTopView, setTopView } from '@/stores/useTopViewStore';

import DeskTabBar from './DeskTabBar';
import { ShortcutSheet } from './ShortcutSheet';
import { MOD, SHORTCUTS } from './shortcuts';
import { useCockpitShortcuts } from './useCockpitShortcuts';

let settingsOpened = 0;
function Bar() {
  useCockpitShortcuts(() => { settingsOpened++; });
  return <><DeskTabBar /><ShortcutSheet /><input aria-label="Composer" /></>;
}
const mount = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Bar /></QueryClientProvider>);
const mod = MOD === '⌘' ? { metaKey: true } : { ctrlKey: true };

beforeEach(() => {
  fx.activated = [];
  settingsOpened = 0;
  fx.sessions = [{ id: 's-failed', attention: { kind: 'failed' } }, { id: 's-asks', attention: { kind: 'question' } }];
  fx.turns = { 's-done': { state: 'done', since: 'a' }, 's-seen': { state: 'done', since: 'b' }, 's-failed': { state: 'done', since: 'c' }, 's-asks': { state: 'done', since: 'd' } };
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200 })));
  setTopView('desks');
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('the top bar', () => {
  it('shows every space with its desks; a desk counts what is not seen yet, or "!" for an error', () => {
    mount();
    const main = screen.getByRole('tablist', { name: 'Main' });
    const eml = screen.getByRole('tablist', { name: 'EML' });
    expect(within(main).getAllByRole('tab').map((t) => t.textContent)).toEqual(['SEO1', 'Desk 1!']);
    expect(within(eml).getByRole('tab').textContent).toBe('Desk 11');
    expect(within(main).getByTitle('1 session stopped with an error')).toBeTruthy();
    expect(within(main).getByRole('tab', { name: /SEO/ }).getAttribute('aria-selected')).toBe('true');
  });

  it('opens a space\'s brain from its name', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Main' }));
    expect(getTopView()).toBe('brain');
  });

  it('jumps to the Nth desk across the bar with the modifier and shows the numbers while it is held', () => {
    mount();
    fireEvent.keyDown(document, { key: MOD === '⌘' ? 'Meta' : 'Control' });
    expect(screen.getByRole('tablist', { name: 'EML' }).textContent).toContain(`${MOD}3`);
    fireEvent.keyDown(document, { code: 'Digit3', key: '3', ...mod });
    expect(fx.activated).toEqual(['d3']);
  });

  it('⌘. opens the Inbox, ⌘, Settings, ? the shortcut sheet; G then N picks Now; nothing fires while typing', async () => {
    mount();
    fireEvent.keyDown(document, { key: '.', ...mod });
    expect([getTopView(), getTaskView()]).toEqual(['tasks', 'inbox']);
    fireEvent.keyDown(document, { key: ',', ...mod });
    expect(settingsOpened).toBe(1);
    fireEvent.keyDown(document, { key: 'g' });
    fireEvent.keyDown(document, { key: 'n' });
    expect(getTaskView()).toBe('now');
    const composer = screen.getByRole('textbox', { name: 'Composer' });
    fireEvent.keyDown(composer, { key: 'g' });
    fireEvent.keyDown(composer, { key: 'p' });
    fireEvent.keyDown(composer, { key: '?' });
    expect(getTaskView()).toBe('now');
    expect(screen.queryByText('Keyboard shortcuts')).toBeNull();
    await act(async () => { fireEvent.keyDown(document, { key: '?' }); });
    const sheet = await screen.findByText('Keyboard shortcuts');
    expect(sheet).toBeTruthy();
    for (const s of SHORTCUTS) expect(screen.getByText(s.label)).toBeTruthy();
  });
});
