import { useCallback, useEffect, useRef, useState } from 'react';

import * as paneStore from '@/stores/usePaneStore';

import { receiveEvent, resetChat, resumePoint, setConnection, setProblem, setSwitching } from './chat-store';
import type { ChatEvent } from './chat-state';

// Reasons the host closes with on purpose: the session went elsewhere, so
// reconnecting would take it back.
const NO_RECONNECT = new Set(['superseded', 'deleted', 'timed out']);
const RECONNECT_MAX_MS = 5_000;

export type PermissionReply =
  | { decision: 'allow' }
  | { decision: 'always' }
  | { decision: 'deny' }
  | { decision: 'answer'; answers: Record<string, string> };

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

export function useChatSocket(paneId: string, projectId: string, sessionId: string) {
  const socketRef = useRef<WebSocket | null>(null);
  // Bumped by "Reconnect": starts the effect over.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // Set on cleanup, so StrictMode's double effect leaves one socket: every async
    // step checks it, and a socket still connecting closes once it is open.
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let backoff = 500;

    const connect = async () => {
      setConnection(sessionId, 'connecting');
      const nonce = await mintNonce();
      if (disposed) return;
      const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = nonce ? new WebSocket(`${scheme}//${window.location.host}/ws/chat?nonce=${encodeURIComponent(nonce)}`) : null;
      if (!socket) { schedule(); return; }
      socketRef.current = socket;

      socket.onopen = () => {
        if (disposed) { socket.close(); return; }
        backoff = 500;
        setConnection(sessionId, 'open');
        const desk = paneStore.getDeskOfPane(paneId);
        socket.send(JSON.stringify({
          type: 'init', paneId, projectId, sessionId, spaceId: desk?.spaceId ?? null, ...resumePoint(sessionId),
        }));
      };
      socket.onmessage = (message) => {
        if (disposed || typeof message.data !== 'string') return;
        const frame = JSON.parse(message.data) as { type: string; seq?: number; event?: ChatEvent; epoch?: number; reason?: string; message?: string };
        if (frame.type === 'event' && frame.event && typeof frame.seq === 'number') {
          setSwitching(sessionId, null);
          receiveEvent(sessionId, frame.seq, frame.event);
        } else if (frame.type === 'reset' && typeof frame.epoch === 'number') resetChat(sessionId, frame.epoch);
        else if (frame.type === 'switching') setSwitching(sessionId, frame.reason ?? 'Switching…');
        else if (frame.type === 'error') setProblem(sessionId, frame.message ?? 'Something went wrong');
      };
      socket.onclose = (event) => {
        if (socketRef.current === socket) socketRef.current = null;
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
      const socket = socketRef.current;
      socketRef.current = null;
      // A CONNECTING socket closes itself in onopen (closing it now only logs an error).
      if (socket && socket.readyState === WebSocket.OPEN) socket.close();
    };
  }, [paneId, projectId, sessionId, attempt]);

  const sendFrame = useCallback((frame: Record<string, unknown>): boolean => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(frame));
    return true;
  }, []);

  return {
    send: useCallback((text: string) => sendFrame({ type: 'send', text }), [sendFrame]),
    interrupt: useCallback(() => sendFrame({ type: 'interrupt' }), [sendFrame]),
    answer: useCallback((requestId: string, answer: PermissionReply) => sendFrame({ type: 'answer', requestId, answer }), [sendFrame]),
    reconnect: useCallback(() => setAttempt((n) => n + 1), []),
  };
}
