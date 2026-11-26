// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import AgentSignIn from './AgentSignIn';

// The sign-in without a terminal: a link and a code field (Claude Code), or a link and a code
// to enter there (Codex). The host is a fetch stub; every code is made up.

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function renderSignIn(provider: 'claude' | 'codex', onDone = vi.fn()) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AgentSignIn provider={provider} onDone={onDone} />
    </QueryClientProvider>,
  );
  return onDone;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('AgentSignIn', () => {
  it('Claude: shows the link, sends the pasted code and reports done', async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      calls.push([path, init]);
      if (path.endsWith('/code')) return json({ id: 'a1', state: 'done', url: 'https://claude.example/x', userCode: null, takesCode: true, error: null });
      return json({ id: 'a1', state: 'waiting', url: 'https://claude.example/x', userCode: null, takesCode: true, error: null });
    }));
    const onDone = renderSignIn('claude');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    const link = await screen.findByRole('link', { name: /Open the sign-in page/ });
    expect(link.getAttribute('href')).toBe('https://claude.example/x');
    fireEvent.change(screen.getByLabelText('Code from the sign-in page'), { target: { value: 'fake-code' } });
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }));
    await screen.findByText('Signed in.');
    expect(onDone).toHaveBeenCalled();
    expect(calls[0][0]).toBe('/api/providers/claude/sign-in');
    expect(calls[1][0]).toBe('/api/providers/claude/sign-in/a1/code');
    expect(JSON.parse(String(calls[1][1]?.body))).toEqual({ code: 'fake-code' });
  });

  it('Codex: shows the code to enter on the page, and no field', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ id: 'b1', state: 'waiting', url: 'https://auth.example/device', userCode: 'FAKE-0000', takesCode: false, error: null })));
    renderSignIn('codex');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('FAKE-0000')).toBeTruthy();
    expect(screen.queryByLabelText('Code from the sign-in page')).toBeNull();
  });

  it('shows the host\'s refusal and offers to try again', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { message: 'Claude Code did not show a sign-in link. Try again.' } }, 400)));
    renderSignIn('claude');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(screen.getByText(/did not show a sign-in link/)).toBeTruthy());
  });
});
