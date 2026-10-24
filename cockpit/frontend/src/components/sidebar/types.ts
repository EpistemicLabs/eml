import type { Project, ProjectSession } from '@/types/app';

export type SidebarViewMode = 'projects' | 'conversations';

export type ProjectSortOrder = 'name' | 'date';

/** The fixed props of the sidebar component. */
export interface SidebarProps {
  projects: Project[];
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  onProjectSelect: (project: Project) => void;
  onSessionSelect: (session: ProjectSession) => void;
  onNewSession: (project: Project) => void;
  onSessionDelete?: (sessionId: string) => void;
  onProjectDelete?: (projectId: string) => void;
  isLoading: boolean;
  onRefresh: () => Promise<void> | void;
  onShowSettings: () => void;
  onSetFolder: (project: Project) => void;
}

/** The compact layout's sidebar: a drawer the page opens and closes. */
export interface SidebarDrawer {
  open: boolean;
  onClose: () => void;
}

export interface PendingProjectDelete {
  project: Project;
  sessionCount: number;
}

export interface PendingSessionDelete {
  projectId: string;
  sessionId: string;
  title: string;
}

export interface RenameState {
  id: string;
  draft: string;
}

export interface ProjectGroups {
  pinned: Project[];
  brain: Project[];
  folder: Project[];
}

export interface ConversationEntry {
  project: Project;
  session: ProjectSession;
}

export interface ConversationGroup {
  label: 'Pinned' | 'Today' | 'Yesterday' | 'Last 7 days' | 'Older';
  entries: ConversationEntry[];
}

export interface SidebarError {
  /** Bumped per report so a repeated message restarts the dismiss timer. */
  id: number;
  message: string;
}
