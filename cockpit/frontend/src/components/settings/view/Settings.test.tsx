// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../hooks/useSettingsController', () => ({
  useSettingsController: () => ({
    activeTab: 'data', setActiveTab: () => {}, saveStatus: null,
    projectSortOrder: 'name', setProjectSortOrder: () => {}, greetOnStart: true, setGreetOnStart: () => {},
  }),
}));
vi.mock('./tabs/DataTab', () => ({ default: () => <p>Data tab</p> }));

import Settings from './Settings';

afterEach(cleanup);

describe('Settings', () => {
  it('closes on Escape, even when the focus was on the page behind it', async () => {
    const behind = document.createElement('button');
    document.body.append(behind);
    behind.focus();
    const onClose = vi.fn();
    render(<Settings isOpen onClose={onClose} />);
    await new Promise((resolve) => window.requestAnimationFrame(() => resolve(null)));
    expect(screen.getByRole('dialog', { name: 'Settings' }).contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on a click beside it', () => {
    const onClose = vi.fn();
    render(<Settings isOpen onClose={onClose} />);
    fireEvent.click(screen.getByRole('dialog', { name: 'Settings' }).previousElementSibling as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
