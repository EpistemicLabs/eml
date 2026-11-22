// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { useState } from 'react';

import { Button, Dialog, DialogContent, DialogTitle, Dot, RadioCard, Select, Switch, Table, TableCell, TableRow, Tree, TreeItem } from '@/shared/view/ui';

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

describe('Select', () => {
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
  it('portals to the body and closes on Escape', () => {
    const onOpenChange = vi.fn();
    render(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent aria-label="Move project"><DialogTitle>Move project</DialogTitle><button type="button">Go</button></DialogContent>
      </Dialog>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Move project' });
    expect(dialog.parentElement?.parentElement).toBe(document.body);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('stays open on a click beside it when asked to, and still closes on Escape', () => {
    const onOpenChange = vi.fn();
    render(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent aria-label="New project" dismissOnOutsideClick={false}><input aria-label="Name" /></DialogContent>
      </Dialog>,
    );
    const scrim = screen.getByRole('dialog', { name: 'New project' }).previousElementSibling as HTMLElement;
    fireEvent.click(scrim);
    expect(onOpenChange).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('leaves Escape to a window stacked on top that holds the focus', () => {
    const onOpenChange = vi.fn();
    render(
      <>
        <Dialog open onOpenChange={onOpenChange}>
          <DialogContent aria-label="Wizard"><button type="button">Next</button></DialogContent>
        </Dialog>
        <div role="dialog" aria-label="Folder browser"><button type="button">Pick</button></div>
      </>,
    );
    screen.getByRole('button', { name: 'Pick' }).focus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('leaves the focus on a field that took it itself', async () => {
    render(
      <Dialog open onOpenChange={() => {}}>
        <DialogContent aria-label="Add project"><button type="button">Close</button><input aria-label="Name" autoFocus /></DialogContent>
      </Dialog>,
    );
    await new Promise((resolve) => window.requestAnimationFrame(() => resolve(null)));
    expect(document.activeElement).toBe(screen.getByLabelText('Name'));
  });
});

describe('Dot', () => {
  it('is a ring while it waits, filled otherwise', () => {
    const { container } = render(<><Dot hue="waiting" hollow /><Dot hue="you" /></>);
    const [ring, filled] = [...container.querySelectorAll('span')];
    expect(ring.className).toContain('border-2');
    expect(ring.className).toContain('border-status-waiting');
    expect(filled.className).toContain('bg-status-you');
  });
});

describe('Tree', () => {
  function Sample({ onSelect = () => {} }: { onSelect?: (id: string) => void }) {
    const [open, setOpen] = useState(true);
    return (
      <Tree label="Tasks">
        <TreeItem content="Root" expanded={open} onToggle={() => setOpen((o) => !o)} onSelect={() => onSelect('root')}>
          <TreeItem content="Sub" line="solid" onSelect={() => onSelect('sub')} />
          <TreeItem content="Spun off" line="dashed" selected onSelect={() => onSelect('spun')} />
        </TreeItem>
        <TreeItem content="Other" onSelect={() => onSelect('other')} />
      </Tree>
    );
  }
  const item = (name: string) => screen.getAllByRole('treeitem').find((el) => el.querySelector('[data-tree-row]')?.textContent === name)!;

  it('names levels, folds, and keeps one row in the tab order', () => {
    render(<Sample />);
    expect(screen.getByRole('tree', { name: 'Tasks' })).toBeTruthy();
    expect(item('Root').getAttribute('aria-level')).toBe('1');
    expect(item('Sub').getAttribute('aria-level')).toBe('2');
    expect(item('Spun off').getAttribute('aria-selected')).toBe('true');
    expect(screen.getAllByRole('treeitem').filter((el) => el.tabIndex === 0)).toHaveLength(1);
    expect(item('Spun off').className).toContain('before:border-dashed');
    expect(item('Sub').className).not.toContain('before:border-dashed');
  });

  it('moves with the arrows, folds with Left and opens with Right, activates with Enter', () => {
    const onSelect = vi.fn();
    render(<Sample onSelect={onSelect} />);
    item('Root').focus();
    fireEvent.keyDown(item('Root'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(item('Sub'));
    fireEvent.keyDown(item('Sub'), { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('sub');
    fireEvent.keyDown(item('Sub'), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(item('Root'));
    fireEvent.keyDown(item('Root'), { key: 'ArrowLeft' });
    expect(item('Root').getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Sub')).toBeNull();
    fireEvent.keyDown(item('Root'), { key: 'End' });
    expect(document.activeElement).toBe(item('Other'));
    fireEvent.keyDown(item('Other'), { key: 'Home' });
    fireEvent.keyDown(item('Root'), { key: 'ArrowRight' });
    expect(item('Root').getAttribute('aria-expanded')).toBe('true');
  });

  it('folds with a click on the chevron without activating the row', () => {
    const onSelect = vi.fn();
    render(<Sample onSelect={onSelect} />);
    fireEvent.click(item('Root').querySelector('[data-tree-toggle]')!);
    expect(item('Root').getAttribute('aria-expanded')).toBe('false');
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('RadioCard', () => {
  it('is a labelled radio with its description, picked on click', () => {
    const onChange = vi.fn();
    render(<div role="radiogroup" aria-label="When"><RadioCard name="when" value="now" checked={false} onChange={onChange} title="Start now" description="Opens in a new pane." /></div>);
    const radio = screen.getByRole('radio', { name: /Start now/ });
    expect(screen.getByText('Opens in a new pane.')).toBeTruthy();
    fireEvent.click(radio);
    expect(onChange).toHaveBeenCalled();
  });
});

describe('Table', () => {
  it('is a named table with column headers and rows', () => {
    render(<Table label="Topics" head={['Topic', 'Goes to']}><TableRow><TableCell>Media viewer</TableCell><TableCell>Spun off</TableCell></TableRow></Table>);
    expect(screen.getByRole('table', { name: 'Topics' })).toBeTruthy();
    expect(screen.getAllByRole('columnheader').map((h) => h.getAttribute('scope'))).toEqual(['col', 'col']);
    expect(screen.getByRole('cell', { name: 'Spun off' })).toBeTruthy();
  });
});
