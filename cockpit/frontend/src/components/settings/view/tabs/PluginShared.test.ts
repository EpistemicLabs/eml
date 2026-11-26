// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import type { ConnectionView, PluginView } from '@/lib/plugins-admin';

import { signInNote } from './PluginShared';

// A sign-in's line on the plugin page (PluginShared.ts signInNote): what it can do now, never a bare
// "Connected". Every value is a placeholder.

const plugin: PluginView = {
  id: 'pay', name: 'Pay', description: '', tier: 'custom', parts: ['mcp'], pane: null, channel: null,
  mcp: { transport: 'http', target: 'https://mcp.pay.example', settings: [] }, auth: { kind: 'mcp-oauth', scopes: [] },
  enabled: true, spaces: { atlas: [] }, partsOff: [], imported: true,
};
const base: ConnectionView = { id: 'pay-1', plugin: 'pay', label: 'Company', secrets: [], slug: null, address: null, oauth: true, health: 'ok', spaces: ['atlas'] };
const names = (id: string) => ({ atlas: 'Atlas' }[id] ?? id);

describe('signInNote', () => {
  it('says until when a good sign-in holds and where it is used', () => {
    const note = signInNote(plugin, { ...base, expiresAt: new Date(Date.now() + 3600_000).toISOString() }, names);
    expect(note.tone).toBe('quiet');
    expect(note.text).toMatch(/^Valid until .* · its tools: pay · renewed by the cockpit · in Atlas$/);
  });

  it('asks to pick a sign-in that no space uses, the case of a session finding no sign-in', () => {
    expect(signInNote(plugin, { ...base, spaces: [] }, names)).toEqual({ text: expect.stringContaining('no space uses it'), tone: 'act' });
  });

  it('asks to sign in again once the server refused, and for a new key once one is old', () => {
    expect(signInNote(plugin, { ...base, health: 'refused' }, names).text).toContain('sign in again');
    const key = signInNote({ ...plugin, auth: null }, { ...base, oauth: false, health: 'old', savedAt: null }, names);
    expect(key).toEqual({ text: expect.stringContaining('Key of unknown age: replace it'), tone: 'act' });
  });
});
