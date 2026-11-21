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

import { ShortcutSheet } from '@/components/top-bar/ShortcutSheet';
import { MOD, SHORTCUTS } from '@/components/top-bar/shortcuts';
import { useCockpitShortcuts } from '@/components/top-bar/useCockpitShortcuts';

import { SpacesNav, TaskNav } from './SidebarNav';

let settingsOpened = 0;
function Nav() {
  useCockpitShortcuts(() => { settingsOpened++; });
  return <><TaskNav /><SpacesNav /><ShortcutSheet /><input aria-label="Composer" /></>;
}
const mount = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Nav /></QueryClientProvider>);
const mod = MOD === '⌘' ? { metaKey: true } : { ctrlKey: true };

beforeEach(() => {
  fx.activated = [];
  settingsOpened = 0;
  fx.sessions = [{ id: 's-failed', attention: { kind: 'failed' } }, { id: 's-asks', attention: { kind: 'question' } }];
  fx.turns = { 's-done': { state: 'done', since: 'a' }, 's-seen': { state: 'done', since: 'b' }, 's-failed': { state: 'done', since: 'c' }, 's-asks': { state: 'done', since: 'd' } };
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200 })));
  try { localStorage.clear(); } catch { /* no storage */ }
  setTopView('desks');
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('the sidebar navigation', () => {
  it('shows the open space with its desks; a desk counts what is not seen yet, or "!" for an error', () => {
    mount();
    const main = screen.getByRole('group', { name: 'Main' });
    const desks = within(main).getAllByRole('button', { name: /^(SEO|Desk 1)(?! actions)/ });
    expect(desks.map((d) => d.textContent)).toEqual(['SEO1', 'Desk 1!']);
    expect(within(main).getByTitle('1 session stopped with an error')).toBeTruthy();
    expect(within(main).getByRole('button', { name: /^SEO(?! actions)/ }).getAttribute('aria-current')).toBe('page');
  });

  it('folds a space shut and open; folded, it shows the sum of its desks', () => {
    mount();
    const eml = screen.getByRole('group', { name: 'EML' });
    const header = within(eml).getByRole('button', { name: /^EML(?! actions)/ });
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(within(eml).getByTitle('1 session to look at: finished or asking you')).toBeTruthy();
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(within(eml).getByRole('button', { name: /^Desk 1(?! actions)/ })).toBeTruthy();
  });

  it("opens a space's brain from its menu", () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Main actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Open its brain/ }));
    expect(getTopView()).toBe('brain');
  });

  it('opens the task views; the Inbox row is the current page while it is open', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: /^Plan/ }));
    expect([getTopView(), getTaskView()]).toEqual(['tasks', 'plan']);
    expect(screen.getByRole('button', { name: /^Plan/ }).getAttribute('aria-current')).toBe('page');
  });

  it('jumps to the Nth desk with the modifier and shows the numbers while it is held', () => {
    mount();
    fireEvent.keyDown(document, { key: MOD === '⌘' ? 'Meta' : 'Control' });
    expect(screen.getByRole('group', { name: 'Main' }).textContent).toContain(`${MOD}2`);
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
    const sheetDialog = screen.getByRole('dialog');
    for (const s of SHORTCUTS) expect(within(sheetDialog).getByText(s.label)).toBeTruthy();
  });
});
