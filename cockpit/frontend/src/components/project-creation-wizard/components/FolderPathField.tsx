// Controlled folder-path input with a debounced suggestions dropdown and a
// Browse button that opens the folder browser. Used by both dialogs.
import { useCallback, useEffect, useRef, useState, type KeyboardEventHandler } from 'react';
import { FolderOpen } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button, Input, POPOVER, ROW } from '@/shared/view/ui';

import FolderBrowserModal from './FolderBrowserModal';
import { fetchFolderListing } from '../data/folderApi';
import { lastSegmentOf, suggestionRootOf } from '../utils/pathUtils';
import type { FolderSuggestion } from '../types';

type FolderPathFieldProps = {
  /** The current path text (controlled). */
  value: string;
  /** Disables the input and the Browse button. */
  disabled?: boolean;
  /** The path changed: typed, picked from the dropdown, or chosen in the browser. */
  onChange: (path: string) => void;
  /** Forwarded to the input; the dialog decides what Enter does. */
  onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
};

const LOOKUP_DELAY_MS = 200;
const MIN_LOOKUP_LENGTH = 3;
const MAX_SUGGESTIONS = 5;

/** Folders whose name starts with the typed segment (case-insensitively) and is not that segment itself. */
function matchingSuggestions(listed: FolderSuggestion[], typedSegment: string): FolderSuggestion[] {
  const segment = typedSegment.toLowerCase();
  return listed
    .filter((folder) => {
      const name = folder.name.toLowerCase();
      return name.startsWith(segment) && name !== segment;
    })
    .slice(0, MAX_SUGGESTIONS);
}

export default function FolderPathField({ value, disabled = false, onChange, onKeyDown }: FolderPathFieldProps) {
  const [suggestions, setSuggestions] = useState<FolderSuggestion[]>([]);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [isBrowserOpen, setIsBrowserOpen] = useState(false);

  const lookupTimerRef = useRef<number | null>(null);
  // Bumped on every new lookup and on cancellation; a response whose
  // sequence no longer matches belongs to text that is no longer current.
  const lookupSequenceRef = useRef(0);

  const cancelPendingLookup = useCallback(() => {
    if (lookupTimerRef.current !== null) {
      window.clearTimeout(lookupTimerRef.current);
      lookupTimerRef.current = null;
    }
    lookupSequenceRef.current += 1;
  }, []);

  useEffect(() => {
    return () => {
      cancelPendingLookup();
    };
  }, [cancelPendingLookup]);

  const lookUpSuggestions = async (typed: string, sequence: number) => {
    try {
      const { suggestions: listed } = await fetchFolderListing(suggestionRootOf(typed));
      if (sequence !== lookupSequenceRef.current) return;
      const matches = matchingSuggestions(listed, lastSegmentOf(typed));
      setSuggestions(matches);
      setIsDropdownOpen(matches.length > 0);
    } catch (lookupError) {
      if (sequence !== lookupSequenceRef.current) return;
      console.error('Folder suggestion lookup failed', lookupError);
      setIsDropdownOpen(false);
    }
  };

  // Runs only in reaction to typing, never to a programmatic value change.
  const scheduleLookup = (typed: string) => {
    cancelPendingLookup();
    const trimmed = typed.trim();
    if (trimmed.length < MIN_LOOKUP_LENGTH) {
      setSuggestions([]);
      setIsDropdownOpen(false);
      return;
    }
    const sequence = lookupSequenceRef.current;
    lookupTimerRef.current = window.setTimeout(() => {
      lookupTimerRef.current = null;
      void lookUpSuggestions(trimmed, sequence);
    }, LOOKUP_DELAY_MS);
  };

  const handleTyping = (typed: string) => {
    onChange(typed);
    scheduleLookup(typed);
  };

  const applyChosenPath = (path: string) => {
    cancelPendingLookup();
    setIsDropdownOpen(false);
    onChange(path);
  };

  const handleBrowserSelection = (path: string) => {
    applyChosenPath(path);
    setIsBrowserOpen(false);
  };

  return (
    <div className="relative">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Input
            type="text"
            value={value}
            autoFocus
            placeholder="/path/to/project or ~/project"
            disabled={disabled}
            onChange={(event) => handleTyping(event.target.value)}
            onKeyDown={onKeyDown}
          />
          {isDropdownOpen && suggestions.length > 0 && (
            <div className={cn(POPOVER, 'absolute top-full right-0 left-0 mt-1 max-h-80 overflow-y-auto')}>
              {suggestions.map((folder) => (
                <button
                  key={folder.path}
                  type="button"
                  onClick={() => applyChosenPath(folder.path)}
                  className={cn(ROW, 'flex-col items-start gap-0 px-3 py-1.5')}
                >
                  <span className="text-body font-medium text-foreground">{folder.name}</span>
                  <span className="text-ui text-muted-foreground">{folder.path}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="shrink-0"
          title="Browse folders"
          disabled={disabled}
          onClick={() => setIsBrowserOpen(true)}
        >
          <FolderOpen aria-hidden />
        </Button>
      </div>
      <FolderBrowserModal
        isOpen={isBrowserOpen}
        onClose={() => setIsBrowserOpen(false)}
        onFolderSelected={handleBrowserSelection}
      />
    </div>
  );
}
