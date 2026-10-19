// The pane being dragged from its title onto a desk tab (DeskTabBar). Kept
// outside the drag data: a dragover handler can't read that data, only its
// types, and the tab has to know the pane to decide whether it accepts it.
import type React from 'react';

let draggedPaneId: string | null = null;

export function startPaneDrag(event: React.DragEvent, paneId: string): void {
  event.dataTransfer.effectAllowed = 'move';
  // Firefox only starts a drag that carries data.
  event.dataTransfer.setData('text/plain', paneId);
  draggedPaneId = paneId;
}

export function endPaneDrag(): void {
  draggedPaneId = null;
}

export function getDraggedPane(): string | null {
  return draggedPaneId;
}
