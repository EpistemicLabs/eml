import { ChevronDown, Plus, X } from 'lucide-react';

import * as paneStore from '@/stores/usePaneStore';
import { setTopView, useTopView } from '@/stores/useTopViewStore';
import type { PaneState } from '@/stores/usePaneStore';
import type { Project } from '@/types/app';

/**
 * The compact (phone) layout's navigation, in the header row instead of the
 * desk tabs and the per-pane title rows: one picker for the Brain view or a
 * desk of the active space, one for the desk's panes, and buttons to open a
 * pane and close the shown one. Native selects, so the phone shows its own
 * picker.
 */

const BRAIN_OPTION = '__brain__';

function paneName(pane: PaneState, index: number, projects: Project[]): string {
  const project = pane.projectId ? projects.find((p) => p.projectId === pane.projectId) : undefined;
  return pane.title || pane.label || project?.displayName || `Pane ${index + 1}`;
}

const SELECT_CLASS =
  'h-8 w-full min-w-0 appearance-none truncate rounded-md border border-foreground/15 bg-foreground/[0.04] pr-6 pl-2.5 text-[14px] text-foreground';
const ICON_BUTTON_CLASS =
  'flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground disabled:opacity-30';

function Picker({ label, value, onChange, children }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="relative min-w-0 flex-1">
      <select aria-label={label} className={SELECT_CLASS} value={value} onChange={(event) => onChange(event.target.value)}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-1.5 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}

export default function CompactNavBar({ projects }: { projects: Project[] }) {
  const topView = useTopView();
  const desks = paneStore.useSpaceDesks();
  const activeDesk = paneStore.useActiveDesk();
  const activePaneId = paneStore.useActivePaneId();
  const panes = activeDesk.panes;
  const shownPane = panes.find((pane) => pane.id === activePaneId) ?? panes[0];

  const onDesk = (value: string) => {
    if (value === BRAIN_OPTION) {
      setTopView('brain');
      return;
    }
    setTopView('desks');
    paneStore.activateDesk(value);
  };

  const newPane = () => {
    setTopView('desks');
    if (shownPane) {
      paneStore.addPaneNextTo(shownPane.id, {
        paneView: 'terminal',
        ...(shownPane.projectId ? { projectId: shownPane.projectId } : {}),
      });
    } else {
      paneStore.addPane({ paneView: 'terminal' });
    }
  };

  // As in the desktop pane toolbar: the last pane closes only when it holds
  // something, and a pinned pane never.
  const canClose = !!shownPane && !shownPane.pinned && (panes.length > 1 || shownPane.projectId !== null);

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5 pr-2">
      <Picker label="Desk" value={topView === 'brain' ? BRAIN_OPTION : activeDesk.id} onChange={onDesk}>
        <option value={BRAIN_OPTION}>Brain</option>
        {desks.map((desk) => (
          <option key={desk.id} value={desk.id}>{desk.name}</option>
        ))}
      </Picker>
      {topView !== 'brain' && shownPane && (
        <>
          <Picker label="Pane" value={shownPane.id} onChange={(id) => paneStore.activatePane(id)}>
            {panes.map((pane, i) => (
              <option key={pane.id} value={pane.id}>{paneName(pane, i, projects)}</option>
            ))}
          </Picker>
          <button type="button" className={ICON_BUTTON_CLASS} aria-label="New pane" title="New pane" onClick={newPane}>
            <Plus className="h-4 w-4" />
          </button>
          <button
            type="button"
            className={ICON_BUTTON_CLASS}
            aria-label="Close pane"
            title="Close pane"
            disabled={!canClose}
            onClick={() => shownPane && paneStore.removePane(shownPane.id)}
          >
            <X className="h-4 w-4" />
          </button>
        </>
      )}
    </div>
  );
}
