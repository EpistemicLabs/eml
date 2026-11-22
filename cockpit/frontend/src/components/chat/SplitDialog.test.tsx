// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { SplitDialog } from './SplitDialog';
import { CreatedMarker, MessageActions, OfferCard, SplitMarker } from './SplitParts';
import { createdTaskOfTool, groupItems, isPaneCommand, keepItHereMessage, matchCommands, offerOfTool, SORT_LATER_MESSAGE, withPaneCommands } from './chat-state';

let draftStatus = 200;
let context = { projects: [{ id: 'p-ui', name: 'EML UI/UX' }, { id: 'p-code', name: 'EML Code' }], taskSystem: true, hasTask: true };
const posts: Array<{ url: string; body: Record<string, unknown> }> = [];

beforeEach(() => {
  posts.length = 0;
  draftStatus = 200;
  context = { projects: [{ id: 'p-ui', name: 'EML UI/UX' }, { id: 'p-code', name: 'EML Code' }], taskSystem: true, hasTask: true };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    posts.push({ url, body });
    if (url.endsWith('/split-brief')) {
      return draftStatus === 200
        ? new Response(JSON.stringify({ title: 'Media viewer', relation: 'spun', projectId: 'p-code', brief: 'Goal: open files.', context }), { status: 200 })
        : new Response(JSON.stringify({ error: { code: 'brief_failed', message: 'The brief could not be written: not signed in' }, context }), { status: 502 });
    }
    if (url.endsWith('/split')) return new Response(JSON.stringify({ opId: body.opId, state: 'applied', undoUntil: '2026-11-22T10:05:00Z', taskId: 't-new', sessionId: 's-new' }), { status: 202 });
    return new Response('{}', { status: 404 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('the split dialog', () => {
  it('fills in the draft for the picked message and splits off with it', async () => {
    const onDone = vi.fn();
    render(<SplitDialog sessionId="s1" projectId="p-ui" upTo="u2" onClose={() => {}} onDone={onDone} />);
    await waitFor(() => expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Media viewer'));
    expect(posts.filter((p) => p.url.endsWith('/split-brief')).map((p) => p.body)).toEqual([{ contextOnly: true }, { upTo: 'u2' }]);
    expect((screen.getByLabelText('Project') as HTMLSelectElement).value).toBe('p-code');
    expect((screen.getByRole('radio', { name: /Spun off/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: /Park as a task/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Split off' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(posts.at(-1)!.body).toMatchObject({ title: 'Media viewer', brief: 'Goal: open files.', relation: 'spun', when: 'park', projectId: 'p-code' });
    expect(onDone.mock.calls[0][0]).toMatchObject({ sessionId: 's-new', title: 'Media viewer', when: 'park' });
  });

  it('sends the same operation again when Split off is pressed after an error', async () => {
    let fail = true;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      posts.push({ url, body });
      if (url.endsWith('/split-brief')) return new Response(JSON.stringify({ title: 'T', relation: 'spun', projectId: 'p-ui', brief: 'b', context }), { status: 200 });
      if (fail) { fail = false; return new Response(JSON.stringify({ error: { code: 'split_failed', message: 'stopped part-way' } }), { status: 502 }); }
      return new Response(JSON.stringify({ opId: body.opId, state: 'applied', undoUntil: 'x' }), { status: 202 });
    }));
    const onDone = vi.fn();
    render(<SplitDialog sessionId="s1" projectId="p-ui" onClose={() => {}} onDone={onDone} />);
    await screen.findByDisplayValue('T');
    fireEvent.click(screen.getByRole('button', { name: 'Split off' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Split off' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const splits = posts.filter((p) => p.url.endsWith('/split'));
    expect(splits).toHaveLength(2);
    expect(splits[0].body.opId).toBe(splits[1].body.opId);
  });

  it('opens editable when no draft could be written, and says why', async () => {
    draftStatus = 502;
    render(<SplitDialog sessionId="s1" projectId="p-ui" onClose={() => {}} onDone={() => {}} />);
    expect(await screen.findByText(/not signed in\. Write the brief yourself\./)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Split off' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Media viewer' } });
    fireEvent.change(screen.getByLabelText('Brief'), { target: { value: 'Goal: files.' } });
    expect((screen.getByRole('button', { name: 'Split off' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('offers no sub-task without a task, and no relation where the task system is off', async () => {
    context = { ...context, hasTask: false };
    render(<SplitDialog sessionId="s1" projectId="p-ui" onClose={() => {}} onDone={() => {}} />);
    await screen.findByDisplayValue('Media viewer');
    expect(screen.queryByRole('radio', { name: /Sub-task/ })).toBeNull();
    cleanup();
    context = { ...context, taskSystem: false };
    render(<SplitDialog sessionId="s1" projectId="p-ui" onClose={() => {}} onDone={() => {}} />);
    await screen.findByDisplayValue('Media viewer');
    expect(screen.queryByRole('radio', { name: /Spun off/ })).toBeNull();
    expect(screen.getByText(/no task system/)).toBeTruthy();
  });

  it('takes the agent\'s own draft without asking for another, and finds its project by name', async () => {
    render(<SplitDialog sessionId="s1" projectId="p-ui" offered={{ title: 'Owner model', relation: 'unrelated', projectId: 'EML Code', brief: 'Goal: owners.' }} onClose={() => {}} onDone={() => {}} />);
    await waitFor(() => expect(screen.getByText('Written by the agent.')).toBeTruthy());
    await waitFor(() => expect((screen.getByLabelText('Project') as HTMLSelectElement).value).toBe('p-code'));
    expect(posts.filter((p) => p.url.endsWith('/split-brief')).map((p) => p.body)).toEqual([{ contextOnly: true, title: 'Owner model' }]);
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Owner model');
    expect((screen.getByRole('radio', { name: /Unrelated/ }) as HTMLInputElement).checked).toBe(true);
  });
});

describe('the dialog while the brief is written', () => {
  it('settles its choices from the context at once, before the draft arrives', async () => {
    let finishDraft: () => void = () => {};
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      posts.push({ url, body });
      if (body.contextOnly) return new Response(JSON.stringify({ context: { ...context, taskSystem: false } }), { status: 200 });
      await new Promise<void>((resolve) => { finishDraft = resolve; });
      return new Response(JSON.stringify({ title: 'Media viewer', relation: 'spun', projectId: 'p-ui', brief: 'Goal.', context: { ...context, taskSystem: false } }), { status: 200 });
    }));
    render(<SplitDialog sessionId="s1" projectId="p-ui" onClose={() => {}} onDone={() => {}} />);
    expect(screen.queryByRole('radio', { name: /Spun off/ })).toBeNull();
    expect(await screen.findByText(/no task system/)).toBeTruthy();
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('');
    expect(screen.getByTestId('brief-spinner').getAttribute('class')).toContain('animate-spin');
    finishDraft();
    await screen.findByDisplayValue('Media viewer');
    expect(screen.queryByTestId('brief-spinner')).toBeNull();
    expect(screen.queryByRole('radio', { name: /Spun off/ })).toBeNull();
  });
});

describe('splitting onto a task that exists', () => {
  it('preselects the open task the topic looks like, and splits onto it without making a new one', async () => {
    context = { ...context, openTasks: [{ id: 't-fix', title: 'fix-ended-mail-job', project: null }, { id: 't-other', title: 'other', project: null }], matchTaskId: 't-fix' } as typeof context;
    const onDone = vi.fn();
    render(<SplitDialog sessionId="s1" projectId="p-ui" onClose={() => {}} onDone={onDone} />);
    await waitFor(() => expect((screen.getByRole('radio', { name: /Existing task/ }) as HTMLInputElement).checked).toBe(true));
    expect((screen.getByLabelText('Which task') as HTMLSelectElement).value).toBe('t-fix');
    expect(screen.getByRole('option', { name: /Fix ended mail job \(looks like this one\)/i })).toBeTruthy();
    expect(screen.queryByRole('radio', { name: /Spun off/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Split off' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(posts.at(-1)!.body).toMatchObject({ existingTaskId: 't-fix' });
  });

  it('takes the open task the agent named in its offer', async () => {
    context = { ...context, openTasks: [{ id: 't-fix', title: 'fix-ended-mail-job', project: null }], matchTaskId: null } as typeof context;
    render(<SplitDialog sessionId="s1" projectId="p-ui" offered={{ title: 'Fix it', relation: 'spun', projectId: null, brief: 'b', existingTaskId: 't-fix' }} onClose={() => {}} onDone={() => {}} />);
    await waitFor(() => expect((screen.getByLabelText('Which task') as HTMLSelectElement).value).toBe('t-fix'));
    expect(posts[0].body).toEqual({ contextOnly: true, title: 'Fix it' });
  });

  it('asks for a task to be picked before splitting onto an existing one', async () => {
    context = { ...context, openTasks: [{ id: 't-fix', title: 'fix-ended-mail-job', project: null }], matchTaskId: null } as typeof context;
    render(<SplitDialog sessionId="s1" projectId="p-ui" onClose={() => {}} onDone={() => {}} />);
    await screen.findByDisplayValue('Media viewer');
    fireEvent.click(screen.getByRole('radio', { name: /Existing task/ }));
    expect((screen.getByRole('button', { name: 'Split off' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('the chat\'s split parts', () => {
  it('offers Split from here on a message, reachable by keyboard, shown only for the hovered message', () => {
    const onSplit = vi.fn();
    const { container } = render(<MessageActions onSplit={onSplit} />);
    const box = container.firstElementChild!;
    expect(box.className).toContain('group-hover/msg:opacity-100');
    expect(box.className).not.toMatch(/(^|\s)group-hover:/);
    expect(box.className).toContain('h-(--target-min)');
    fireEvent.click(screen.getByRole('button', { name: 'Split from here' }));
    expect(onSplit).toHaveBeenCalled();
  });

  it('marks where a topic left, with the way to it and Undo while it may', () => {
    const onUndo = vi.fn();
    const mark = { opId: 'op', title: 'Media viewer', afterItemId: 'u2', sessionId: 's-new', parked: false, undoUntil: '2026-11-22T10:05:00Z' };
    const { rerender } = render(<SplitMarker mark={mark} now={Date.parse('2026-11-22T10:00:00Z')} onOpen={() => {}} onUndo={onUndo} />);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onUndo).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Media viewer' })).toBeTruthy();
    rerender(<SplitMarker mark={mark} now={Date.parse('2026-11-22T10:06:00Z')} onOpen={() => {}} onUndo={onUndo} />);
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('shows the agent\'s offer with the choice until it is made', () => {
    const onSplit = vi.fn();
    const onKeep = vi.fn();
    const { rerender } = render(<OfferCard title="Media viewer" reason="not part of the sidebar task" decided={null} onSplit={onSplit} onKeep={onKeep} />);
    fireEvent.click(screen.getByRole('button', { name: 'Split off…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep it here' }));
    expect([onSplit.mock.calls.length, onKeep.mock.calls.length]).toEqual([1, 1]);
    rerender(<OfferCard title="Media viewer" reason="" decided="kept" onSplit={onSplit} onKeep={onKeep} />);
    expect(screen.queryByRole('button', { name: 'Keep it here' })).toBeNull();
    expect(screen.getByText('Kept here.')).toBeTruthy();
  });

  it('reads an offer_split call as an offer, not a folded tool row', () => {
    const tool = { type: 'tool', id: 't1', name: 'mcp__cockpit__offer_split', input: { title: 'Media viewer', relation: 'sideways', brief: 'Goal.', reason: 'new' } } as never;
    expect(offerOfTool(tool)).toEqual({ title: 'Media viewer', relation: 'spun', project: null, task: null, brief: 'Goal.', reason: 'new' });
    expect(groupItems([tool])).toEqual([{ kind: 'offer', id: 't1', offer: expect.objectContaining({ title: 'Media viewer' }) }]);
  });

  it('tells the agent what the user chose, in words it acts on', () => {
    expect(keepItHereMessage('Media viewer')).toBe('Keep it here: we stay on "Media viewer" in this chat.');
    expect(SORT_LATER_MESSAGE).toBe('Later: no sort now.');
    expect(isPaneCommand(' /split ', 'split')).toBe(true);
    expect(isPaneCommand('/split the board', 'split')).toBe(false);
  });

  it('shows a task the agent created as a bar, once the brain answered with its id', () => {
    const id = '0871844f-1111-4222-8333-944455556666';
    const tool = { type: 'tool', id: 'c1', name: 'mcp__eml_brain__eml_create_task', status: 'completed', input: { title: 'new-mail-jobs' }, output: `{\n  "id": "${id}",\n  "type": "task"\n}` } as never;
    expect(createdTaskOfTool(tool)).toEqual({ taskId: id, title: 'new-mail-jobs' });
    expect(groupItems([tool])).toEqual([{ kind: 'created', id: 'c1', taskId: id, title: 'new-mail-jobs' }]);
    expect(createdTaskOfTool({ ...(tool as object), status: 'running', output: '' } as never)).toBeNull();
  });

  it('offers Undo on a created task while it is open, and says when it is dropped', () => {
    const onUndo = vi.fn();
    const { rerender } = render(<CreatedMarker title="New mail jobs" state="open" onUndo={onUndo} />);
    expect(screen.getByText('New mail jobs')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onUndo).toHaveBeenCalled();
    rerender(<CreatedMarker title="New mail jobs" state="undone" onUndo={onUndo} />);
    expect(screen.getByText('Task New mail jobs dropped')).toBeTruthy();
    rerender(<CreatedMarker title="New mail jobs" state={{ error: 'This task still has open steps.' }} onUndo={onUndo} />);
    expect(screen.getByRole('alert').textContent).toBe('This task still has open steps.');
  });

  it('lists /split before the agent\'s commands', () => {
    const merged = withPaneCommands([{ name: 'review', description: '', argumentHint: '', aliases: [] }]);
    expect(merged.map((c) => c.name)).toEqual(['split', 'review']);
    expect(matchCommands(merged, '/sp').map((c) => c.name)).toEqual(['split']);
  });
});
