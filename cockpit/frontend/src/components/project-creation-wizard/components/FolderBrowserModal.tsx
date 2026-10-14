// Modal folder picker: browse the host filesystem (directories only),
// optionally create a folder, and hand back a chosen path. Rendered through a
// portal so it covers the whole viewport above the dialog that opened it.
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Eye, EyeOff, FolderOpen, FolderPlus, Loader2, Plus, X } from 'lucide-react';

import { Button, Input } from '@/shared/view/ui';
import { cn } from '@/lib/utils';

import { createFolder, fetchFolderListing } from '../data/folderApi';
import { joinPath, parentPathOf } from '../utils/pathUtils';
import type { FolderSuggestion } from '../types';

type FolderBrowserModalProps = {
  /** While false the browser renders nothing but keeps its state. */
  isOpen: boolean;
  /** The user dismissed the browser without choosing. */
  onClose: () => void;
  /** The user chose a folder; the parent is expected to close the browser. */
  onFolderSelected: (folderPath: string) => void;
};

const HOME = '~';

const headerIconButtonClass =
  'rounded-md p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground';

const errorMessageOf = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

export default function FolderBrowserModal({ isOpen, onClose, onFolderSelected }: FolderBrowserModalProps) {
  const [currentPath, setCurrentPath] = useState(HOME);
  const [listing, setListing] = useState<FolderSuggestion[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [isNewFolderRowOpen, setIsNewFolderRowOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  // Only the most recently requested listing may apply its result.
  const loadSequenceRef = useRef(0);

  // A clicked folder row unmounts when the listing reloads, which drops focus
  // to the body and out of reach of the panel's key handler. Bring it back
  // unless something inside the panel (the new-folder input, a button) has it.
  const keepFocusInsidePanel = () => {
    const panel = panelRef.current;
    if (panel && !panel.contains(document.activeElement)) panel.focus();
  };

  const loadFolder = useCallback(async (path: string) => {
    const sequence = ++loadSequenceRef.current;
    const isCurrent = () => sequence === loadSequenceRef.current;
    setIsLoading(true);
    setError(null);
    try {
      const result = await fetchFolderListing(path);
      if (!isCurrent()) return;
      setCurrentPath(result.path);
      setListing(result.suggestions);
    } catch (loadError) {
      if (!isCurrent()) return;
      setError(errorMessageOf(loadError, 'Failed to load folders'));
    } finally {
      if (isCurrent()) {
        setIsLoading(false);
        keepFocusInsidePanel();
      }
    }
  }, []);

  // Every open starts at home and moves focus into the dialog so Escape and
  // the key isolation below work right away; closing hands focus back.
  useEffect(() => {
    if (!isOpen) return;
    const previouslyFocused = document.activeElement;
    panelRef.current?.focus();
    void loadFolder(HOME);
    return () => {
      if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, [isOpen, loadFolder]);

  // Ignore responses that arrive after unmount.
  useEffect(() => {
    return () => {
      loadSequenceRef.current += 1;
    };
  }, []);

  // The row owns focus while open; hand it back to the panel so a following
  // Escape still reaches the browser.
  const closeNewFolderRow = () => {
    setIsNewFolderRowOpen(false);
    setNewFolderName('');
    panelRef.current?.focus();
  };

  const resetTransientState = () => {
    setError(null);
    closeNewFolderRow();
  };

  const dismiss = () => {
    resetTransientState();
    onClose();
  };

  const selectFolder = (path: string) => {
    resetTransientState();
    onFolderSelected(path);
  };

  const canCreateFolder = isNewFolderRowOpen && newFolderName.trim() !== '' && !isCreating;

  const submitNewFolder = async () => {
    if (!canCreateFolder) return;
    setIsCreating(true);
    setError(null);
    try {
      const createdPath = await createFolder(joinPath(currentPath, newFolderName));
      closeNewFolderRow();
      await loadFolder(createdPath);
    } catch (createError) {
      setError(errorMessageOf(createError, 'Failed to create folder'));
    } finally {
      setIsCreating(false);
    }
  };

  const handleNewFolderKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void submitNewFolder();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeNewFolderRow();
    }
  };

  // Keys pressed inside the browser stay here: nothing reaches the dialog
  // underneath (which would otherwise submit on Enter).
  const handlePanelKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      dismiss();
    }
  };

  const visibleFolders = useMemo(
    () =>
      listing
        .filter((folder) => showHidden || !folder.name.startsWith('.'))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
    [listing, showHidden],
  );
  const parentPath = parentPathOf(currentPath);

  if (!isOpen) return null;

  const hiddenToggleLabel = showHidden ? 'Hide hidden folders' : 'Show hidden folders';

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={handlePanelKeyDown}
        className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-lg border border-border bg-card shadow-2xl outline-none"
      >
        <div className="flex items-center justify-between border-b border-border p-4">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted">
              <FolderOpen className="h-4 w-4 text-foreground" />
            </div>
            <h3 id={titleId} className="text-lg font-semibold text-foreground">
              Select folder
            </h3>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setShowHidden((shown) => !shown)}
              aria-pressed={showHidden}
              aria-label={hiddenToggleLabel}
              title={hiddenToggleLabel}
              className={cn(headerIconButtonClass, showHidden && 'bg-muted text-foreground')}
            >
              {showHidden ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
            </button>
            <button
              type="button"
              onClick={() => setIsNewFolderRowOpen((open) => !open)}
              aria-pressed={isNewFolderRowOpen}
              aria-label="Create new folder"
              title="Create new folder"
              className={cn(headerIconButtonClass, isNewFolderRowOpen && 'bg-muted text-foreground')}
            >
              <Plus className="h-4 w-4" />
            </button>
            <button type="button" onClick={dismiss} aria-label="Close" className={headerIconButtonClass}>
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {isNewFolderRowOpen && (
          <div className="flex items-center gap-2 border-b border-border bg-foreground/3 px-4 py-2">
            <Input
              type="text"
              value={newFolderName}
              autoFocus
              placeholder="New folder name"
              disabled={isCreating}
              onChange={(event) => setNewFolderName(event.target.value)}
              onKeyDown={handleNewFolderKeyDown}
            />
            <Button size="sm" loading={isCreating} disabled={!canCreateFolder} onClick={() => void submitNewFolder()}>
              {isCreating ? null : 'Create'}
            </Button>
            <Button size="sm" variant="ghost" onClick={closeNewFolderRow}>
              Cancel
            </Button>
          </div>
        )}

        {error && <p className="px-4 pt-3 text-xs text-foreground">{error}</p>}

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
          {isLoading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="space-y-0.5">
              {parentPath !== null && (
                <button
                  type="button"
                  onClick={() => void loadFolder(parentPath)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-medium text-muted-foreground hover:bg-muted"
                >
                  <FolderOpen className="h-4 w-4 shrink-0" />
                  <span>..</span>
                </button>
              )}
              {visibleFolders.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">No subfolders found</p>
              ) : (
                visibleFolders.map((folder) => (
                  <div key={folder.path} className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => void loadFolder(folder.path)}
                      className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-medium text-foreground hover:bg-muted"
                    >
                      <FolderPlus className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="truncate">{folder.name}</span>
                    </button>
                    <Button variant="ghost" size="sm" className="text-xs" onClick={() => selectFolder(folder.path)}>
                      Select
                    </Button>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        <div className="border-t border-border">
          <div className="flex items-center gap-2 bg-foreground/3 px-4 py-2">
            <span className="text-xs text-muted-foreground">Path</span>
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{currentPath}</span>
          </div>
          <div className="flex items-center justify-end gap-2 p-4">
            <Button variant="outline" onClick={dismiss}>
              Cancel
            </Button>
            <Button variant="outline" onClick={() => selectFolder(currentPath)}>
              Use this folder
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
