// The cockpit host's control-plane API (no auth token — the host is loopback + same-origin).
import type { Project } from '@/types/app';

const jsonInit = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export const api = {
  projects: () => fetch('/api/projects'),
  createProject: (payload: { path: string; customName?: string }) =>
    fetch('/api/projects', jsonInit('POST', payload)),
  renameProject: (projectId: string, displayName: string) =>
    fetch(`/api/projects/${encodeURIComponent(projectId)}`, jsonInit('PATCH', { displayName })),
  setProjectStar: (projectId: string, isStarred: boolean) =>
    fetch(`/api/projects/${encodeURIComponent(projectId)}`, jsonInit('PATCH', { isStarred })),
  setProjectHidden: (projectId: string, hidden: boolean) =>
    fetch(`/api/projects/${encodeURIComponent(projectId)}`, jsonInit('PATCH', { hidden })),
  setProjectPath: (projectId: string, path: string | null) =>
    fetch(`/api/projects/${encodeURIComponent(projectId)}`, jsonInit('PATCH', { path })),
  deleteProject: (projectId: string, deleteData = false) =>
    fetch(`/api/projects/${encodeURIComponent(projectId)}${deleteData ? '?deleteData=1' : ''}`, jsonInit('DELETE')),

  sessions: () => fetch('/api/sessions'),
  renameSession: (sessionId: string, title: string) =>
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, jsonInit('PATCH', { title })),
  setSessionPin: (sessionId: string, isPinned: boolean) =>
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, jsonInit('PATCH', { isPinned })),
  stopSession: (sessionId: string, paneId: string) =>
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/stop`, jsonInit('POST', { paneId })),
  deleteSession: (sessionId: string) =>
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, jsonInit('DELETE')),

  about: () => fetch('/api/about'),
  claimSpawn: (id: string) => fetch(`/api/spawns/${encodeURIComponent(id)}/claim`, jsonInit('POST')),
  claudeLogin: (refresh = false) => fetch(`/api/agents/login${refresh ? '?refresh=1' : ''}`),
  setLoginMode: (mode: 'login' | 'token') => fetch('/api/agents/login', jsonInit('PATCH', { mode })),
  setPermissionMode: (permissionMode: 'auto' | 'bypassPermissions') =>
    fetch('/api/agents/login', jsonInit('PATCH', { permissionMode })),
  setRenderer: (renderer: 'default' | 'fullscreen') =>
    fetch('/api/agents/login', jsonInit('PATCH', { renderer })),
  setRemoteControl: (remoteControl: boolean) =>
    fetch('/api/agents/login', jsonInit('PATCH', { remoteControl })),
  setClaudeLogin: (token: string) => fetch('/api/agents/login', jsonInit('PUT', { token })),
  clearClaudeLogin: () => fetch('/api/agents/login', jsonInit('DELETE')),

  listFolders: (path: string) => fetch(`/api/folders?path=${encodeURIComponent(path)}`),
  makeFolder: (path: string) => fetch('/api/folders', jsonInit('POST', { path })),
};

export type ProjectsResponse = { projects: Project[] };
