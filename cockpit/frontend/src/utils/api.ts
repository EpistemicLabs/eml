// The cockpit host's control-plane API (no auth token — the host is loopback + same-origin).
import { SPACE_HEADER } from '@/lib/space-header';
import type { Project } from '@/types/app';

/** `space` names the space a request means; without it the open one's. */
const jsonInit = (method: string, body?: unknown, space?: string): RequestInit => ({
  method,
  headers: {
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    ...(space ? { [SPACE_HEADER]: space } : {}),
  },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export const api = {
  projects: () => fetch('/api/projects'),
  // A project id says nothing about its space: one folder has the same id in two.
  renameProject: (projectId: string, displayName: string, space?: string) =>
    fetch(`/api/projects/${encodeURIComponent(projectId)}`, jsonInit('PATCH', { displayName }, space)),
  setProjectStar: (projectId: string, isStarred: boolean, space?: string) =>
    fetch(`/api/projects/${encodeURIComponent(projectId)}`, jsonInit('PATCH', { isStarred }, space)),
  setProjectHidden: (projectId: string, hidden: boolean, space?: string) =>
    fetch(`/api/projects/${encodeURIComponent(projectId)}`, jsonInit('PATCH', { hidden }, space)),
  setProjectPath: (projectId: string, path: string | null, space?: string) =>
    fetch(`/api/projects/${encodeURIComponent(projectId)}`, jsonInit('PATCH', { path }, space)),
  /** A folder-only project joins a brain project of its space, which takes the folder and its sessions. */
  linkProject: (projectId: string, brainProjectId: string, space?: string) =>
    fetch(`/api/projects/${encodeURIComponent(projectId)}/link`, jsonInit('POST', { project: brainProjectId }, space)),
  deleteProject: (projectId: string, deleteData = false, space?: string) =>
    fetch(`/api/projects/${encodeURIComponent(projectId)}${deleteData ? '?deleteData=1' : ''}`, jsonInit('DELETE', undefined, space)),

  sessions: () => fetch('/api/sessions'),
  renameSession: (sessionId: string, title: string) =>
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, jsonInit('PATCH', { title })),
  setSessionPin: (sessionId: string, isPinned: boolean) =>
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, jsonInit('PATCH', { isPinned })),
  releaseSession: (sessionId: string, paneId: string) =>
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/release`, jsonInit('POST', { paneId })),
  deleteSession: (sessionId: string) =>
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, jsonInit('DELETE')),
  endShell: (shellId: string) =>
    fetch(`/api/plugins/shell/${encodeURIComponent(shellId)}`, jsonInit('DELETE')),

  about: () => fetch('/api/about'),
  claimSpawn: (id: string) => fetch(`/api/spawns/${encodeURIComponent(id)}/claim`, jsonInit('POST')),
  // Web push on this device (host push-api.ts).
  pushKey: (endpoint?: string) => fetch(`/api/push${endpoint ? `?endpoint=${encodeURIComponent(endpoint)}` : ''}`),
  pushSubscribe: (subscription: PushSubscriptionJSON, label: string) =>
    fetch('/api/push/subscription', jsonInit('PUT', { ...subscription, label })),
  pushUnsubscribe: (endpoint: string) => fetch('/api/push/subscription', jsonInit('DELETE', { endpoint })),
  pushTest: (endpoint: string) => fetch('/api/push/test', jsonInit('POST', { endpoint })),
  pushWatching: (sessionIds: string[], endpoint: string | null) =>
    fetch('/api/push/watching', jsonInit('POST', { sessionIds, ...(endpoint ? { endpoint } : {}) })),
  claudeLogin: (refresh = false) => fetch(`/api/agents/login${refresh ? '?refresh=1' : ''}`),
  setLoginMode: (mode: 'login' | 'token') => fetch('/api/agents/login', jsonInit('PATCH', { mode })),
  setPermissionMode: (permissionMode: 'auto' | 'bypassPermissions') =>
    fetch('/api/agents/login', jsonInit('PATCH', { permissionMode })),
  setClaudeLogin: (token: string) => fetch('/api/agents/login', jsonInit('PUT', { token })),
  clearClaudeLogin: () => fetch('/api/agents/login', jsonInit('DELETE')),

  listFolders: (path: string) => fetch(`/api/folders?path=${encodeURIComponent(path)}`),
  makeFolder: (path: string) => fetch('/api/folders', jsonInit('POST', { path })),
};

export type ProjectsResponse = { projects: Project[] };
