// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { Button, Dialog, DialogContent, DialogTitle, Field, Input, Select, Switch, Textarea } from '@/shared/view/ui';

afterEach(cleanup);

describe('Button', () => {
  it('is a plain button by default, so it never submits a form by accident', () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' }).getAttribute('type')).toBe('button');
  });

  it('keeps the 24px minimum target at its smallest size', () => {
    render(<><Button size="sm">Small</Button><Button size="icon-sm" aria-label="Close">×</Button></>);
    expect(screen.getByRole('button', { name: 'Small' }).className).toContain('min-h-(--target-min)');
    expect(screen.getByRole('button', { name: 'Close' }).className).toContain('size-(--target-min)');
  });

  it('is disabled and busy while loading', () => {
    const onClick = vi.fn();
    render(<Button loading onClick={onClick}>Send</Button>);
    const button = screen.getByRole('button', { name: 'Send' });
    expect(button).toHaveProperty('disabled', true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('shows focus with the ring outline', () => {
    render(<Button variant="ghost">Ghost</Button>);
    expect(screen.getByRole('button', { name: 'Ghost' }).className).toContain('focus-visible:outline-ring');
  });
});

describe('Field', () => {
  it('labels its control and points it at the hint', () => {
    render(<Field label="Name" hint="Shown in the sidebar">{({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} />}</Field>);
    const input = screen.getByLabelText('Name');
    expect(input.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.getElementById(input.getAttribute('aria-describedby')!)?.textContent).toBe('Shown in the sidebar');
  });

  it('announces an error in place of the hint', () => {
    render(<Field label="Path" hint="A folder" error="No such folder">{({ id, describedBy }) => <Textarea id={id} aria-describedby={describedBy} />}</Field>);
    expect(screen.getByRole('alert').textContent).toBe('No such folder');
    expect(screen.queryByText('A folder')).toBeNull();
  });

  it('dresses the native select like the other fields', () => {
    render(<Select aria-label="Model"><option>A</option></Select>);
    expect(screen.getByRole('combobox', { name: 'Model' }).className).toContain('border-input');
  });
});

describe('Switch', () => {
  it('reports the wanted value and shows what it is given', () => {
    const onChange = vi.fn();
    render(<Switch checked={false} onChange={onChange} ariaLabel="Sound" />);
    const sw = screen.getByRole('switch', { name: 'Sound' });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith(true);
    expect(sw.getAttribute('aria-checked')).toBe('false');
  });

  it('does nothing while disabled', () => {
    const onChange = vi.fn();
    render(<Switch checked onChange={onChange} ariaLabel="Sound" disabled />);
    fireEvent.click(screen.getByRole('switch', { name: 'Sound' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('Dialog', () => {
  it('portals into the v2 scope and closes on Escape', () => {
    const onOpenChange = vi.fn();
    render(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent aria-label="Move project"><DialogTitle>Move project</DialogTitle><button type="button">Go</button></DialogContent>
      </Dialog>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Move project' });
    expect(dialog.closest('[data-ui="v2"]')).not.toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
