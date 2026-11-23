// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { Count, Menu, monograms, NavItem } from '@/shared/view/ui';

afterEach(cleanup);

describe('monograms', () => {
  it('gives one letter, and two where names share their first letter', () => {
    const m = monograms(['Main', 'EML', 'Ebisu', 'Sachi', 'Hercules']);
    expect([...m.values()]).toEqual(['M', 'E', 'Eb', 'S', 'H']);
  });
});

describe('Count', () => {
  it('says what it counts and takes the meaning colour', () => {
    render(<><Count label="5 waiting for you" tone="you">5</Count><Count label="stopped" tone="stopped">!</Count></>);
    expect(screen.getByLabelText('5 waiting for you').className).toContain('text-you-ink');
    expect(screen.getByLabelText('stopped').className).toContain('text-stopped-ink');
  });
});

describe('NavItem', () => {
  it('marks the open place as the current page', () => {
    const onClick = vi.fn();
    render(<><NavItem label="Inbox" current onClick={onClick} /><NavItem label="Now" onClick={() => {}} /></>);
    expect(screen.getByRole('button', { name: 'Inbox' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: 'Now' }).getAttribute('aria-current')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Inbox' }));
    expect(onClick).toHaveBeenCalled();
  });
});

describe('Menu', () => {
  const setup = () => {
    const rename = vi.fn();
    const close = vi.fn();
    render(<Menu label="Desk actions" items={[{ label: 'Rename', onSelect: rename }, { label: 'Disabled', onSelect: () => {}, disabled: true }, { label: 'Close desk', onSelect: close, destructive: true }]} />);
    return { rename, close, trigger: screen.getByRole('button', { name: 'Desk actions' }) };
  };

  it('opens on click with the focus on the first item and runs the picked action', () => {
    const { rename, trigger } = setup();
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Rename' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    expect(rename).toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('moves with the arrow keys past disabled items and closes on Escape', () => {
    const { trigger } = setup();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const menu = screen.getByRole('menu', { name: 'Desk actions' });
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Close desk' }));
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Rename' }));
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes on a click beside it', () => {
    const { trigger } = setup();
    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('shows what it acts on above the actions and what they do below, and the keys still reach only the actions', () => {
    render(<Menu label="Limits" header={<p>Gmail · Send email</p>} footer={<p>The session restarts.</p>} align="start" items={[{ label: 'Allow', onSelect: () => {} }]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Limits' }));
    const menu = screen.getByRole('menu', { name: 'Limits' });
    expect(menu.textContent).toBe('Gmail · Send emailAllowThe session restarts.');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Allow' }));
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Allow' }));
  });
});
