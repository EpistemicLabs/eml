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
  /** A plain new session opens with a greeting and the project's state (default on). */
  greetOnStart: boolean;
  /** Claude sessions open in the chat view instead of the terminal: this browser's choice, else the cockpit's chat view switch. */
  chatDefault: boolean;
  /** This browser's own choice of view; undefined follows the cockpit's switch. */
  chatOverride?: boolean;
  lastUpdated?: string;
};
