import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon, type ISearchResultChangeEvent } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';

import { useTheme } from '@/contexts/ThemeContext';
import { getDeskOfPane, getPane } from '@/stores/usePaneStore';
import { readSettings } from '@/components/settings/utils/settingsStorage';
import {
  ERROR_NO_IDENTITY,
  ERROR_NO_SIZE,
  FOCUS_STYLE_ID,
  HIDDEN_POLL_MS,
  MAX_INIT_RETRIES,
  NONCE_FAILURE_HOLD_MS,
  NORMAL_CLOSURE,
  RESIZE_DEBOUNCE_MS,
  SETTLE_DELAY_MS,
  SUBMIT_ENTER_DELAY_MS,
  SUPERSEDED_REASON,
  TERMINAL_OPTIONS,
} from '../constants';
import {
  decodeBinaryFrame,
  parseTextFrame,
  uploadPastedImage,
  requestShellNonce,
  sendFrame,
  shellSocketUrl,
} from '../utils/hostChannel';
import { ensureFocusStyle, installAtlasRecovery, watchDevicePixelRatio } from '../utils/renderRecovery';
import { installClipboardHandling } from '../utils/terminalClipboard';
import {
  clearScreen,
  fitTerminal,
  isContainerRendered,
  proposeValidSize,
  repaintAll,
  type GridSize,
} from '../utils/terminalFit';
import { getSearchDecorations, getXtermTheme } from '../utils/terminalTheme';
import { getTerminalFontSize, stepTerminalFontSize, subscribeTerminalFontSize } from '../utils/terminalFontSize';
import { matchTerminalShortcut } from '../utils/terminalShortcuts';
import { imageReference, keySequence, submissionText, type TerminalKey } from '../domain/terminalKeys';
import { prepareImageUpload } from '../utils/imageAttachment';

export interface ShellRuntimeOptions {
  paneId: string | null;
  projectId: string | null;
  sessionId: string | null;
  initialCommand: string | null;
  isActive: boolean;
  autoConnect: boolean;
  /**
   * Typed on a soft keyboard (compact layout): the keyboard must not
   * autocorrect, capitalize or suggest, which would rewrite commands.
   */
  touchInput: boolean;
}

/** Input from outside the terminal: the compact layout's key row and its extras. */
export interface ShellInput {
  sendKey: (key: TerminalKey) => void;
  /** Typed as if from the keyboard, e.g. a quick answer "1". */
  sendText: (text: string) => void;
  /** A composed message: pasted (bracketed when the CLI asks for it), then Enter. */
  submit: (message: string) => void;
  /** An image from the device: uploaded to the host, its path put into the prompt. False if it failed. */
  attachImage: (file: File) => Promise<boolean>;
  /** Give the terminal the focus back, so typing goes on there. */
  focus: () => void;
}

export type ShellOverlay =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'connecting' }
  | { kind: 'connect'; superseded: boolean };

export type SearchDirection = 'next' | 'previous';

/** Scrollback search of the pane: the find bar's state and actions. */
export interface ShellSearch {
  open: boolean;
  /** Bumped on every ⌘F, so a find bar that is already open refocuses its input. */
  focusRequest: number;
  results: ISearchResultChangeEvent | null;
  find: (term: string, direction: SearchDirection, incremental?: boolean) => void;
  close: () => void;
}

/**
 * Owns one xterm terminal and its socket to the host PTY bridge: creation and
 * teardown per session id, the nonce handshake, the `init` frame, streaming in
 * both directions, resize, theme and focus.
 */
export function useShellRuntime(options: ShellRuntimeOptions) {
  const { sessionId, isActive, autoConnect, touchInput } = options;
  const { isDarkMode } = useTheme();

  const containerRef = useRef<HTMLDivElement | null>(null);

  const [initialized, setInitialized] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connected, setConnected] = useState(false);
  const [superseded, setSuperseded] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchFocusRequest, setSearchFocusRequest] = useState(0);
  const [searchResults, setSearchResults] = useState<ISearchResultChangeEvent | null>(null);
  const fontSize = useSyncExternalStore(subscribeTerminalFontSize, getTerminalFontSize);

  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  // Synchronous guard against overlapping attempts; the rendered state lags.
  const lockRef = useRef(false);
  // Identity of the current attempt; bumped whenever an attempt is abandoned.
  const attemptRef = useRef(0);
  // The pending nonce-failure hold or init retry of the current attempt.
  const connectionTimerRef = useRef<number | null>(null);
  const lastSentSizeRef = useRef<GridSize | null>(null);

  // Values read at init time rather than reacting to them.
  const latestRef = useRef(options);
  const isDarkRef = useRef(isDarkMode);
  useLayoutEffect(() => {
    latestRef.current = options;
    isDarkRef.current = isDarkMode;
  });

  useEffect(() => {
    ensureFocusStyle(FOCUS_STYLE_ID);
  }, []);

  const cancelConnectionTimer = useCallback(() => {
    if (connectionTimerRef.current !== null) {
      window.clearTimeout(connectionTimerRef.current);
      connectionTimerRef.current = null;
    }
  }, []);

  const startConnectionTimer = useCallback(
    (fn: () => void, ms: number) => {
      cancelConnectionTimer();
      connectionTimerRef.current = window.setTimeout(() => {
        connectionTimerRef.current = null;
        fn();
      }, ms);
    },
    [cancelConnectionTimer],
  );

  const sendResize = useCallback((size: GridSize) => {
    const last = lastSentSizeRef.current;
    if (last && last.cols === size.cols && last.rows === size.rows) return;
    if (sendFrame(socketRef.current, { type: 'resize', cols: size.cols, rows: size.rows })) {
      lastSentSizeRef.current = size;
    }
  }, []);

  // A lost connection clears the screen, so a find bar has nothing left to
  // search; closing it also keeps it from taking focus back after a reconnect.
  const endSearch = useCallback(() => {
    searchRef.current?.clearDecorations();
    setSearchOpen(false);
    setSearchResults(null);
  }, []);

  /** Closes and forgets the socket, abandons any attempt, clears the screen. */
  const disconnect = useCallback(() => {
    attemptRef.current += 1;
    cancelConnectionTimer();
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      socket.close();
    }
    if (terminalRef.current) clearScreen(terminalRef.current);
    lockRef.current = false;
    setConnected(false);
    setConnecting(false);
    setSuperseded(false);
    setFailure(null);
    endSearch();
  }, [cancelConnectionTimer, endSearch]);

  /** Close or error of a socket; ignored unless it is still the current one. */
  const handleSocketEnd = useCallback(
    (socket: WebSocket, wasSuperseded: boolean) => {
      if (socketRef.current !== socket) return;
      socketRef.current = null;
      cancelConnectionTimer();
      if (wasSuperseded) setSuperseded(true);
      lockRef.current = false;
      setConnected(false);
      setConnecting(false);
      setFailure(null);
      if (terminalRef.current) clearScreen(terminalRef.current);
      endSearch();
    },
    [cancelConnectionTimer, endSearch],
  );

  const handleMessage = useCallback((payload: unknown) => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    if (payload instanceof ArrayBuffer) {
      const text = decodeBinaryFrame(payload);
      if (text !== null) terminal.write(text);
      return;
    }
    if (typeof payload !== 'string') return;
    try {
      const msg = parseTextFrame(payload);
      if (msg.kind === 'output') terminal.write(msg.data);
      else if (msg.kind === 'error') terminal.write(`\r\n\x1b[31m${msg.message}\x1b[0m\r\n`);
    } catch (error) {
      console.error('[Shell] Error handling WebSocket message:', payload, error);
    }
  }, []);

  /**
   * Sends `init` once the container has a real size, so the PTY is spawned
   * (or reattached) with the geometry the user actually sees.
   */
  const scheduleInit = useCallback(
    (socket: WebSocket) => {
      const attempt = (retries: number) => {
        if (socketRef.current !== socket || socket.readyState !== WebSocket.OPEN) return;
        const terminal = terminalRef.current;
        const fit = fitRef.current;
        const { paneId, projectId, sessionId: currentSessionId, initialCommand } = latestRef.current;
        if (!terminal || !fit || !currentSessionId || !projectId) {
          setFailure(ERROR_NO_IDENTITY);
          return;
        }
        // A pane in a background desk waits until it is shown; this does not
        // count against the retry budget.
        if (!isContainerRendered(terminal)) {
          startConnectionTimer(() => attempt(retries), HIDDEN_POLL_MS);
          return;
        }
        if (!proposeValidSize(terminal, fit)) {
          if (retries < MAX_INIT_RETRIES) {
            startConnectionTimer(() => attempt(retries + 1), SETTLE_DELAY_MS);
          } else {
            console.warn('[Shell] Container never produced valid dimensions; init not sent');
            setFailure(ERROR_NO_SIZE);
          }
          return;
        }

        const size = fitTerminal(terminal, fit);
        const pane = paneId ? getPane(paneId) : undefined;
        const desk = paneId ? getDeskOfPane(paneId) : undefined;
        const sent = sendFrame(socket, {
          type: 'init',
          paneId,
          projectId,
          sessionId: currentSessionId,
          cols: size.cols,
          rows: size.rows,
          initialCommand: initialCommand ?? null,
          greet: readSettings().greetOnStart,
          taskId: pane?.taskId ?? null,
          provider: pane?.provider ?? null,
          spaceId: desk?.spaceId ?? null,
          isDarkMode: document.documentElement.classList.contains('dark'),
        });
        if (sent) lastSentSizeRef.current = size;
      };
      startConnectionTimer(() => attempt(0), SETTLE_DELAY_MS);
    },
    [startConnectionTimer],
  );

  const connect = useCallback(async () => {
    if (!terminalRef.current || lockRef.current || socketRef.current) return;
    attemptRef.current += 1;
    const attempt = attemptRef.current;
    lockRef.current = true;
    setSuperseded(false);
    setFailure(null);
    setConnecting(true);

    const nonce = await requestShellNonce();
    if (attempt !== attemptRef.current) return;
    if (!nonce.ok) {
      // Hold "connecting" briefly so a down host is not hammered.
      startConnectionTimer(() => {
        if (attempt !== attemptRef.current) return;
        lockRef.current = false;
        setConnecting(false);
      }, NONCE_FAILURE_HOLD_MS);
      return;
    }

    let socket: WebSocket;
    try {
      socket = new WebSocket(shellSocketUrl(nonce.nonce));
      socket.binaryType = 'arraybuffer';
    } catch {
      lockRef.current = false;
      setConnected(false);
      setConnecting(false);
      return;
    }
    socketRef.current = socket;

    socket.onopen = () => {
      if (socketRef.current !== socket) return;
      lockRef.current = false;
      setConnected(true);
      setConnecting(false);
      scheduleInit(socket);
    };
    socket.onmessage = (event: MessageEvent) => {
      if (socketRef.current !== socket) return;
      handleMessage(event.data);
    };
    socket.onclose = (event: CloseEvent) => {
      handleSocketEnd(socket, event.code === NORMAL_CLOSURE && event.reason === SUPERSEDED_REASON);
    };
    socket.onerror = () => {
      handleSocketEnd(socket, false);
    };
  }, [handleMessage, handleSocketEnd, scheduleInit, startConnectionTimer]);

  // One terminal per session id; torn down and rebuilt when it changes.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !sessionId) return;

    let disposed = false;
    const terminal = new Terminal({
      ...TERMINAL_OPTIONS,
      fontSize: getTerminalFontSize(),
      theme: getXtermTheme(isDarkRef.current),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(new WebLinksAddon());
    const search = new SearchAddon();
    terminal.loadAddon(search);
    const searchSubscription = search.onDidChangeResults((results) => setSearchResults(results));
    terminal.open(container);

    // Loaded after open so a missing WebGL context surfaces here, not in open().
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        // xterm falls back to the DOM renderer; repaint so the pane is not blank.
        webgl.dispose();
        repaintAll(terminal);
      });
      terminal.loadAddon(webgl);
    } catch {
      console.warn('[Shell] WebGL renderer unavailable, using DOM fallback');
    }

    terminalRef.current = terminal;
    fitRef.current = fit;
    searchRef.current = search;

    const disposeClipboard = installClipboardHandling({
      terminal,
      container,
      bindInput: () => {
        const socket = socketRef.current;
        return (data: string) => {
          sendFrame(socket, { type: 'input', data });
        };
      },
      onShortcut: (event) => {
        const shortcut = matchTerminalShortcut(event);
        if (!shortcut) return false;
        if (shortcut === 'find') {
          setSearchOpen(true);
          setSearchFocusRequest((n) => n + 1);
        } else {
          stepTerminalFontSize(shortcut === 'zoom-in' ? 1 : shortcut === 'zoom-out' ? -1 : 0);
        }
        return true;
      },
    });

    const dataSubscription = terminal.onData((data) => {
      sendFrame(socketRef.current, { type: 'input', data });
    });

    // Pane animations fire many notifications; only the settled size is sent.
    let resizeTimer: number | null = null;
    const observer = new ResizeObserver(() => {
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        resizeTimer = null;
        if (disposed || !proposeValidSize(terminal, fit)) return;
        // Fitting mid-parse races the renderer; wait for pending writes first.
        terminal.write('', () => {
          if (disposed || !isContainerRendered(terminal)) return;
          sendResize(fitTerminal(terminal, fit));
        });
      }, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(container);

    const atlas = installAtlasRecovery(terminal);
    const stopDprWatch = watchDevicePixelRatio(() => {
      if (disposed) return;
      if (proposeValidSize(terminal, fit)) sendResize(fitTerminal(terminal, fit, false));
      atlas.trigger();
    });

    const firstFitTimer = window.setTimeout(() => {
      if (disposed || !proposeValidSize(terminal, fit)) return;
      sendResize(fitTerminal(terminal, fit));
    }, SETTLE_DELAY_MS);

    setInitialized(true);

    return () => {
      disposed = true;
      window.clearTimeout(firstFitTimer);
      atlas.dispose();
      stopDprWatch();
      disposeClipboard();
      observer.disconnect();
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      lastSentSizeRef.current = null;
      dataSubscription.dispose();
      searchSubscription.dispose();
      disconnect();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
      setSearchOpen(false);
      setSearchResults(null);
      setInitialized(false);
    };
  }, [sessionId, disconnect, sendResize]);

  // Recolour in place; the WebGL atlas caches glyphs per colour. Only on a
  // real switch: a new terminal is created with the current theme, and
  // clearing the atlas then wipes the one every pane with the same font shares.
  const appliedDarkRef = useRef(isDarkMode);
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || appliedDarkRef.current === isDarkMode) return;
    appliedDarkRef.current = isDarkMode;
    terminal.options.theme = getXtermTheme(isDarkMode);
    terminal.clearTextureAtlas();
  }, [isDarkMode]);

  // A new font size changes the grid but not the container, so no resize
  // notification comes: refit here and tell the PTY.
  useEffect(() => {
    const terminal = terminalRef.current;
    const fit = fitRef.current;
    if (!terminal || !fit || terminal.options.fontSize === fontSize) return;
    terminal.options.fontSize = fontSize;
    if (!proposeValidSize(terminal, fit)) return;
    terminal.write('', () => {
      if (terminalRef.current !== terminal || !isContainerRendered(terminal)) return;
      sendResize(fitTerminal(terminal, fit));
    });
  }, [fontSize, sendResize]);

  const findInScrollback = useCallback((term: string, direction: SearchDirection, incremental = false) => {
    const search = searchRef.current;
    if (!search) return;
    if (!term) {
      search.clearDecorations();
      setSearchResults(null);
      return;
    }
    const searchOptions = { incremental, decorations: getSearchDecorations(isDarkRef.current) };
    if (direction === 'next') search.findNext(term, searchOptions);
    else search.findPrevious(term, searchOptions);
  }, []);

  const closeSearch = useCallback(() => {
    endSearch();
    terminalRef.current?.focus();
  }, [endSearch]);

  // Any return to "neither connecting nor connected" starts a new attempt.
  useEffect(() => {
    if (autoConnect && initialized && !connecting && !connected && !superseded) void connect();
  }, [autoConnect, initialized, connecting, connected, superseded, connect]);

  useEffect(() => {
    if (!isActive || !initialized || !connected) return;
    const frame = window.requestAnimationFrame(() => terminalRef.current?.focus());
    const timer = window.setTimeout(() => terminalRef.current?.focus(), 0);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [isActive, initialized, connected]);

  // A soft keyboard types into xterm's helper textarea: keep it from
  // correcting, capitalizing or suggesting, which would rewrite commands.
  useEffect(() => {
    const textarea = terminalRef.current?.textarea;
    if (!textarea || !touchInput) return;
    const plain: Record<string, string> = { autocorrect: 'off', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false' };
    for (const [name, value] of Object.entries(plain)) textarea.setAttribute(name, value);
  }, [touchInput, initialized]);

  const input = useMemo<ShellInput>(() => {
    const send = (data: string) => sendFrame(socketRef.current, { type: 'input', data });
    return {
      sendKey: (key) => {
        const applicationCursor = terminalRef.current?.modes.applicationCursorKeysMode ?? false;
        send(keySequence(key, { applicationCursor }));
      },
      sendText: send,
      submit: (message) => {
        const terminal = terminalRef.current;
        const text = submissionText(message);
        // Through xterm's paste, so the text is bracketed when the CLI has
        // bracketed paste on and line breaks stay inside the message.
        if (terminal && text) terminal.paste(text);
        // Enter as its own keystroke a moment later: arriving together with
        // the paste, a CLI can take it as part of the pasted text.
        window.setTimeout(() => send(keySequence('enter', { applicationCursor: false })), text ? SUBMIT_ENTER_DELAY_MS : 0);
      },
      attachImage: async (file) => {
        const upload = await prepareImageUpload(file);
        const path = upload && await uploadPastedImage(upload.blob, upload.type).catch(() => null);
        if (!path) return false;
        send(imageReference(path));
        return true;
      },
      focus: () => terminalRef.current?.focus(),
    };
  }, []);

  let overlay: ShellOverlay | null = null;
  if (!initialized) overlay = { kind: 'loading' };
  else if (failure) overlay = { kind: 'error', message: failure };
  else if (connecting) overlay = { kind: 'connecting' };
  else if (!connected) overlay = { kind: 'connect', superseded };

  const search: ShellSearch = {
    open: searchOpen,
    focusRequest: searchFocusRequest,
    results: searchResults,
    find: findInScrollback,
    close: closeSearch,
  };

  return { containerRef, overlay, connect, search, input };
}
