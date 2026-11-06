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
  /** How it stands for the user, why, and since when; saved by the host, it outlives the process. */
  attention?: { kind: 'question' | 'review' | 'failed' | 'done'; reason: string | null; at: string } | null;
  /** The main pane of a desk, on any device. */
  deskMain?: boolean;
  /** Started by another session. */
  worker?: boolean;
  parentSessionId?: string | null;
  readAt?: string | null;
  /** A turn ended and nobody has seen the result. */
  resultAt?: string | null;
  archivedAt?: string | null;
  /** Background tasks of its own still running (chat sessions); archiving would kill them. */
  backgroundTasks?: number;
  __provider?: LLMProvider;
  /** The owning project's id. */
  __projectId?: string;
  /** Set by the All view: the pane store's key of the session's space (null = main); the click opens it there. */
  __spaceKey?: string | null;
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
  /** The space the sidebar listed it from; the host does not send it. */
  __spaceId?: string;
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
