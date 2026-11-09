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
  createProject: (payload: { path: string; customName?: string }) =>
    fetch('/api/projects', jsonInit('POST', payload)),
  // A project id says nothing about its space: one folder has the same id in two.
  renameProject: (projectId: string, displayName: string, space?: string) =>
    fetch(`/api/projects/${encodeURIComponent(projectId)}`, jsonInit('PATCH', { displayName }, space)),
  setProjectStar: (projectId: string, isStarred: boolean, space?: string) =>
    fetch(`/api/projects/${encodeURIComponent(projectId)}`, jsonInit('PATCH', { isStarred }, space)),
  setProjectHidden: (projectId: string, hidden: boolean, space?: string) =>
    fetch(`/api/projects/${encodeURIComponent(projectId)}`, jsonInit('PATCH', { hidden }, space)),
  setProjectPath: (projectId: string, path: string | null, space?: string) =>
    fetch(`/api/projects/${encodeURIComponent(projectId)}`, jsonInit('PATCH', { path }, space)),
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

  about: () => fetch('/api/about'),
  claimSpawn: (id: string) => fetch(`/api/spawns/${encodeURIComponent(id)}/claim`, jsonInit('POST')),
  // The zone a scheduled job's times read in when it names none (host jobs-api.ts).
  setTimeZone: (timeZone: string) => fetch('/api/jobs/time-zone', jsonInit('PUT', { timeZone })),
  // The Jobs view (host jobs-api.ts).
  jobs: () => fetch('/api/jobs'),
  jobAction: (jobId: string, action: 'pause' | 'resume' | 'delete' | 'run_now') =>
    fetch(`/api/jobs/${encodeURIComponent(jobId)}/${action}`, jsonInit('POST')),
  approveJob: (jobId: string) => fetch(`/api/jobs/${encodeURIComponent(jobId)}/approve`, jsonInit('POST')),
  setJobReply: (jobId: string, channel: 'mail' | 'slack' | 'whatsapp', mode: 'send' | 'draft') =>
    fetch(`/api/jobs/${encodeURIComponent(jobId)}/reply`, jsonInit('POST', { channel, mode })),
  setJobLimited: (jobId: string, limited: boolean) => fetch(`/api/jobs/${encodeURIComponent(jobId)}/limited`, jsonInit('POST', { limited })),
  grantJobTool: (jobId: string, tool: 'chrome' | 'SendMessage', minutes = 60) =>
    fetch(`/api/jobs/${encodeURIComponent(jobId)}/grant`, jsonInit('POST', { tool, minutes })),
  revokeJobTool: (jobId: string, tool: 'chrome' | 'SendMessage') =>
    fetch(`/api/jobs/${encodeURIComponent(jobId)}/revoke`, jsonInit('POST', { tool })),
  claudeLogin: (refresh = false) => fetch(`/api/agents/login${refresh ? '?refresh=1' : ''}`),
  setLoginMode: (mode: 'login' | 'token') => fetch('/api/agents/login', jsonInit('PATCH', { mode })),
  setPermissionMode: (permissionMode: 'auto' | 'bypassPermissions') =>
    fetch('/api/agents/login', jsonInit('PATCH', { permissionMode })),
  setRenderer: (renderer: 'default' | 'fullscreen') =>
    fetch('/api/agents/login', jsonInit('PATCH', { renderer })),
  setChatView: (chatView: boolean) =>
    fetch('/api/agents/login', jsonInit('PATCH', { chatView })),
  setRemoteControl: (remoteControl: boolean) =>
    fetch('/api/agents/login', jsonInit('PATCH', { remoteControl })),
  setClaudeLogin: (token: string) => fetch('/api/agents/login', jsonInit('PUT', { token })),
  clearClaudeLogin: () => fetch('/api/agents/login', jsonInit('DELETE')),

  listFolders: (path: string) => fetch(`/api/folders?path=${encodeURIComponent(path)}`),
  makeFolder: (path: string) => fetch('/api/folders', jsonInit('POST', { path })),
};

export type ProjectsResponse = { projects: Project[] };
