// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { ToolServersPanel } from './ToolServersPanel';
import type { ToolServer, ToolServerSignIn } from './chat-state';

afterEach(cleanup);

const servers: ToolServer[] = [{ name: 'linear', status: 'needs-auth', error: null, scope: 'user', transport: 'web', toolCount: 0 }];
const all = { toggle: true, reconnect: true, signIn: true };

function panel(signIns: Record<string, ToolServerSignIn>, onFinishSignIn = vi.fn(() => true)) {
  render(
    <ToolServersPanel
      servers={servers} error={null} signIns={signIns} can={all}
      onAsk={() => true} onChange={() => true} onFinishSignIn={onFinishSignIn} onRestart={() => {}} onClose={() => {}}
    />,
  );
  return onFinishSignIn;
}

describe('ToolServersPanel sign-in', () => {
  it('links the page and, where the sign-in takes it back, sends the pasted address once and clears the field', () => {
    const onFinish = panel({ linear: { url: 'https://auth.example.com/authorize', takesCode: true } });
    expect(screen.getByRole('link', { name: /Open the sign-in page for linear/ }).getAttribute('href')).toBe('https://auth.example.com/authorize');
    const field = screen.getByLabelText(/Browser on another computer/) as HTMLInputElement;
    const finish = screen.getByRole('button', { name: 'Finish sign-in' });
    expect((finish as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(field, { target: { value: ' http://localhost:1/callback?code=fake-code&state=fake ' } });
    fireEvent.click(finish);
    expect(onFinish).toHaveBeenCalledWith('linear', 'http://localhost:1/callback?code=fake-code&state=fake');
    expect(field.value).toBe('');
  });

  it('shows no field for a sign-in that finishes on its own page', () => {
    panel({ linear: { url: 'https://auth.example.com/authorize', takesCode: false } });
    expect(screen.queryByLabelText(/Browser on another computer/)).toBeNull();
  });
});
