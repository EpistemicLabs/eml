// Settings tabs: Account · Models · Agents · Brain · Preferences ·
// Notifications · Plugins · Data · About.
export type SettingsMainTab =
  | 'account'
  | 'models'
  | 'agents'
  | 'brain'
  | 'preferences'
  | 'notifications'
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
  lastUpdated?: string;
};
