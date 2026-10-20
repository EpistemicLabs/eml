// Settings tabs: Account · Agent · Models · Brain · Preferences · Plugins ·
// Data · About.
export type SettingsMainTab =
  | 'account'
  | 'models'
  | 'agents'
  | 'brain'
  | 'preferences'
  | 'plugins'
  | 'data'
  | 'about';

export type ProjectSortOrder = 'name' | 'date';
export type SaveStatus = 'success' | 'error' | null;

export type SettingsProps = {
  isOpen: boolean;
  onClose: () => void;
  initialTab?: string;
};

/** What the cockpit persists client-side (localStorage `cockpit-settings`). */
export type CockpitSettings = {
  projectSortOrder: ProjectSortOrder;
  /** Browser notification when a session finishes while the cockpit isn't in front. */
  notifyOnDone: boolean;
  /** A plain new session opens with a greeting and the project's state (default on). */
  greetOnStart: boolean;
  lastUpdated?: string;
};
