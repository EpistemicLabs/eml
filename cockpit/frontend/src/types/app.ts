/** Agent-CLI provider ids the host knows. */
export type LLMProvider = 'claude' | 'codex';

/** Live PTY state of a session in the host registry. */
export type SessionState = 'running' | 'detached' | 'ended';

/** The agent's turn state, fed by the agent's hooks through the host. */
export type TurnState = 'idle' | 'working' | 'done' | 'waiting';

export interface ProjectSession {
  id: string;
  /** Display name: user title, else the provider's title, else the first prompt; '' when none. */
  summary?: string;
  /** The user-chosen title only. */
  title?: string | null;
  createdAt?: string;
  /** Last real message, falling back to creation. */
  lastActivity?: string;
  messageCount?: number;
  lastMessageAt?: string | null;
  model?: string | null;
  contextTokens?: number | null;
  isPinned?: boolean;
  paneId?: string | null;
  /** The brain task this session advances (a task run). */
  taskId?: string | null;
  state?: SessionState;
  /** Value at fetch time; the live source is the turn store. */
  turnState?: TurnState;
  turnSince?: string | null;
  __provider?: LLMProvider;
  /** The owning project's id. */
  __projectId?: string;
  [key: string]: unknown;
}

export interface ProjectSessionMeta {
  total?: number;
  hasMore?: boolean;
  [key: string]: unknown;
}

export type ProjectKind = 'brain' | 'folder';

export type BrainProjectStatus = 'active' | 'paused' | 'archived';

export interface Project {
  projectId: string;
  kind?: ProjectKind;
  brainProjectId?: string | null;
  brainStatus?: BrainProjectStatus | null;
  /** Linked by the user / made by the cockpit / none yet. */
  folderKind?: 'user' | 'cockpit' | 'none';
  goal?: string | null;
  displayName: string;
  customName?: string | null;
  /** Null for a brain project without a folder. */
  fullPath: string | null;
  /** Same value as fullPath. */
  path?: string | null;
  isStarred?: boolean;
  /** Hidden from the sidebar. */
  hidden?: boolean;
  createdAt?: string;
  sessions?: ProjectSession[];
  sessionMeta?: ProjectSessionMeta;
  [key: string]: unknown;
}
