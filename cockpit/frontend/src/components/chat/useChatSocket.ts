import { useCallback, useEffect, useRef, useState } from 'react';

import * as paneStore from '@/stores/usePaneStore';
import { readSettings } from '@/components/settings/utils/settingsStorage';
import { chatInitFrame, clearChatStart, peekChatStart, rememberModels } from './chat-start';

import { receiveEvent, resetChat, resumePoint, setConnection, setProblem, setSwitching, setLimits, setTerminalBusy, setToolServerSignIn, setToolServers, showSentMessage, type SessionLimits } from './chat-store';
import type { ChatEvent, ToolServer } from './chat-state';

// Reasons the host closes with on purpose: the session went elsewhere, so
// reconnecting would take it back.
const NO_RECONNECT = new Set(['superseded', 'deleted', 'timed out', 'archived', 'stopped']);
const RECONNECT_MAX_MS = 5_000;

export type PermissionReply =
  | { decision: 'allow' }
  | { decision: 'always' }
  /** `message`: why, for the agent; `interrupt`: stop the turn too. */
  | { decision: 'deny'; message?: string; interrupt?: boolean }
  | { decision: 'answer'; answers: Record<string, string> };

export type ToolServerAction = 'enable' | 'disable' | 'reconnect' | 'sign_in';

async function mintNonce(): Promise<string | null> {
  try {
    const res = await fetch('/api/chat', { method: 'POST' });
    if (!res.ok) return null;
    const body = await res.json() as { nonce?: unknown };
    return typeof body.nonce === 'string' ? body.nonce : null;
  } catch {
    return null;
  }
}

// How often a view waiting for the terminal asks again.
const BUSY_RETRY_MS = 3_000;

/** `spaceId` for a view outside the desks (the task panel); a pane's comes from its desk. */
/** The open chat socket of each session shown in a pane: controls outside the chat pane (the pane header) send through it. */
const senders = new Map<string, (frame: Record<string, unknown>) => boolean>();

/** The user lifts the session's limits and it restarts; forJob: its job's future runs too. False when no chat view of it is open. */
export function liftLimits(sessionId: string, forJob: boolean): boolean {
  return senders.get(sessionId)?.({ type: 'restart', unlimited: true, forJob }) ?? false;
}

export function useChatSocket(paneId: string, projectId: string, sessionId: string, whenIdle = false, spaceId?: string | null) {
  const sendInitRef = useRef<((wait: boolean) => void) | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  // The host has this socket on the session: until then frames wait here, so a
  // message sent while the view connects or loads still goes out.
  const joinedRef = useRef(false);
  const waitingRef = useRef<Array<Record<string, unknown>>>([]);
  // Bumped by "Reconnect": starts the effect over.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // Set on cleanup, so StrictMode's double effect leaves one socket: every async
    // step checks it, and a socket still connecting closes once it is open.
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let backoff = 500;
    let busyRetry: ReturnType<typeof setTimeout> | null = null;
    const clearBusy = () => {
      if (busyRetry) clearTimeout(busyRetry);
      busyRetry = null;
      setTerminalBusy(sessionId, null);
    };

    const connect = async () => {
      setConnection(sessionId, 'connecting');
      const nonce = await mintNonce();
      if (disposed) return;
      const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = nonce ? new WebSocket(`${scheme}//${window.location.host}/ws/chat?nonce=${encodeURIComponent(nonce)}`) : null;
      if (!socket) { schedule(); return; }
      socketRef.current = socket;
      joinedRef.current = false;
      const sendInit = (wait: boolean) => {
        if (socket.readyState !== WebSocket.OPEN) return;
        const space = spaceId !== undefined ? spaceId : paneStore.getDeskOfPane(paneId)?.spaceId ?? null;
        socket.send(JSON.stringify(chatInitFrame({
          paneId, projectId, sessionId, spaceId: space, resume: resumePoint(sessionId), wait,
          greet: readSettings().greetOnStart,
          provider: paneStore.chatProviderOfPane(paneId),
          start: peekChatStart(sessionId),
        })));
      };
      sendInitRef.current = (wait) => { clearBusy(); sendInit(wait); };

      socket.onopen = () => {
        if (disposed) { socket.close(); return; }
        backoff = 500;
        setConnection(sessionId, 'open');
        sendInit(whenIdle);
      };
      socket.onmessage = (message) => {
        if (disposed || typeof message.data !== 'string') return;
        const frame = JSON.parse(message.data) as { type: string; state?: 'working' | 'waiting'; seq?: number; event?: ChatEvent; epoch?: number; reason?: string; message?: string; servers?: ToolServer[]; error?: string | null; name?: string; url?: string } & Partial<SessionLimits>;
        if (frame.type === 'joined') {
          joinedRef.current = true;
          clearChatStart(sessionId);
          for (const waiting of waitingRef.current.splice(0)) socket.send(JSON.stringify(waiting));
          return;
        }
        if (frame.type === 'terminal_busy') {
          setTerminalBusy(sessionId, frame.state ?? 'working');
          busyRetry = setTimeout(() => sendInit(true), BUSY_RETRY_MS);
          return;
        }
        if (frame.type === 'event' || frame.type === 'reset' || frame.type === 'switching') clearBusy();
        if (frame.type === 'event' && frame.event && typeof frame.seq === 'number') {
          setSwitching(sessionId, null);
          receiveEvent(sessionId, frame.seq, frame.event);
          if (frame.event.kind === 'capabilities') rememberModels(frame.event.models);
        } else if (frame.type === 'reset' && typeof frame.epoch === 'number') {
          resetChat(sessionId, frame.epoch);
          for (const waiting of waitingRef.current) if (waiting.type === 'send') showSentMessage(sessionId, waiting.id as string, waiting.text as string);
        }
        else if (frame.type === 'switching') setSwitching(sessionId, frame.reason ?? 'Switching…');
        else if (frame.type === 'tool_servers') setToolServers(sessionId, frame.servers ?? [], frame.error ?? null);
        else if (frame.type === 'tool_server_sign_in' && frame.name && frame.url) setToolServerSignIn(sessionId, frame.name, frame.url);
        else if (frame.type === 'limits') setLimits(sessionId, { deniedTools: frame.deniedTools ?? [], mcpServers: frame.mcpServers ?? null, job: frame.job ?? null, liftable: frame.liftable === true });
        else if (frame.type === 'error') setProblem(sessionId, frame.message ?? 'Something went wrong');
      };
      socket.onclose = (event) => {
        if (socketRef.current === socket) socketRef.current = null;
        joinedRef.current = false;
        clearBusy();
        if (disposed) return;
        if (NO_RECONNECT.has(event.reason)) { setConnection(sessionId, 'superseded'); return; }
        setConnection(sessionId, 'closed');
        schedule();
      };
    };

    const schedule = () => {
      if (disposed) return;
      retry = setTimeout(() => { void connect(); }, backoff);
      backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
    };

    void connect();
    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      if (busyRetry) clearTimeout(busyRetry);
      sendInitRef.current = null;
      const socket = socketRef.current;
      socketRef.current = null;
      // A CONNECTING socket closes itself in onopen (closing it now only logs an error).
      if (socket && socket.readyState === WebSocket.OPEN) socket.close();
    };
  }, [paneId, projectId, sessionId, attempt, whenIdle, spaceId]);

  const sendFrame = useCallback((frame: Record<string, unknown>): boolean => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(frame));
    return true;
  }, []);

  useEffect(() => {
    senders.set(sessionId, sendFrame);
    return () => { if (senders.get(sessionId) === sendFrame) senders.delete(sessionId); };
  }, [sessionId, sendFrame]);

  return {
    send: useCallback((text: string, images: string[] = []) => {
      const id = `sent-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      showSentMessage(sessionId, id, text);
      const frame = { type: 'send', id, text, ...(images.length > 0 ? { images } : {}) };
      if (!joinedRef.current || !sendFrame(frame)) waitingRef.current.push(frame);
      return true;
    }, [sendFrame, sessionId]),
    start: useCallback(() => {
      if (joinedRef.current) sendFrame({ type: 'start' });
      else if (!waitingRef.current.some((frame) => frame.type === 'start')) waitingRef.current.push({ type: 'start' });
    }, [sendFrame]),
    interrupt: useCallback(() => sendFrame({ type: 'interrupt' }), [sendFrame]),
    answer: useCallback((requestId: string, answer: PermissionReply) => sendFrame({ type: 'answer', requestId, answer }), [sendFrame]),
    setMode: useCallback((mode: string) => sendFrame({ type: 'set_mode', mode }), [sendFrame]),
    setModel: useCallback((model: string) => sendFrame({ type: 'set_model', model }), [sendFrame]),
    setEffort: useCallback((effort: string) => sendFrame({ type: 'set_effort', effort }), [sendFrame]),
    stopAgent: useCallback((taskId: string) => sendFrame({ type: 'stop_agent', taskId }), [sendFrame]),
    restart: useCallback(() => sendFrame({ type: 'restart' }), [sendFrame]),
    askToolServers: useCallback(() => sendFrame({ type: 'tool_servers' }), [sendFrame]),
    changeToolServer: useCallback((name: string, action: ToolServerAction) => sendFrame({ type: 'tool_server', name, action }), [sendFrame]),
    takeOver: useCallback(() => sendInitRef.current?.(false), []),
    reconnect: useCallback(() => setAttempt((n) => n + 1), []),
  };
}
