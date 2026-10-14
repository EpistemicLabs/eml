// The cockpit's settings tab list. `keywords` feed the command palette's
// "Settings: …" entries; `blurb` is the one-liner a not-yet-built tab shows.
import type { ComponentType } from 'react';
import {
  Bell,
  Bot,
  Brain,
  Cpu,
  Database,
  Info,
  Puzzle,
  SlidersHorizontal,
  UserRound,
} from 'lucide-react';

import type { ProjectSortOrder, SettingsMainTab } from '../types/types';

export type SettingsMainTabMeta = {
  id: SettingsMainTab;
  label: string;
  keywords: string;
  icon: ComponentType<{ className?: string }>;
  blurb: string;
};

export const SETTINGS_MAIN_TABS: SettingsMainTabMeta[] = [
  {
    id: 'account',
    label: 'Account',
    keywords: 'account subscription eml login profile',
    icon: UserRound,
    blurb: 'Your EML account: sign-in and subscription.',
  },
  {
    id: 'models',
    label: 'Models',
    keywords: 'models claude login subscription permissions model setup-token isolation',
    icon: Cpu,
    blurb: 'Claude sign-in (Max subscription), permission mode, default model — and what the cockpit keeps separate from your local Claude setup.',
  },
  {
    id: 'agents',
    label: 'Agents',
    keywords: 'agents agent identity persona setup',
    icon: Bot,
    blurb: 'Set up your own agent here: its name and identity, how it works with you and what it brings into every session. Not available yet — sessions currently run as the agent your brain was set up with.',
  },
  {
    id: 'brain',
    label: 'Brain',
    keywords: 'brain local hosted token backup stats paths home folder config directory',
    icon: Brain,
    blurb: 'The brain instance: its source (local or hosted), where the cockpit keeps its files, identity, backup and restore.',
  },
  {
    id: 'preferences',
    label: 'Preferences',
    keywords: 'preferences theme appearance dark light colors font sidebar sorting',
    icon: SlidersHorizontal,
    blurb: 'Your personal setup: theme, sidebar ordering, and more to come.',
  },
  {
    id: 'notifications',
    label: 'Notifications',
    keywords: 'notifications alerts done idle badge browser',
    icon: Bell,
    blurb: 'Finished-session badges and optional browser notifications.',
  },
  {
    id: 'plugins',
    label: 'Plugins',
    keywords: 'plugins extensions community install ports localhost',
    icon: Puzzle,
    blurb: 'Community plugins: install, enable and manage extensions for the cockpit.',
  },
  {
    id: 'data',
    label: 'Data',
    keywords: 'data import export migrate settings sessions',
    icon: Database,
    blurb: 'Import & export: bring settings and sessions over from an existing setup, export them again.',
  },
  {
    id: 'about',
    label: 'About',
    keywords: 'about version info updates',
    icon: Info,
    blurb: 'Versions and updates.',
  },
];

export const KNOWN_MAIN_TABS: SettingsMainTab[] = SETTINGS_MAIN_TABS.map((tab) => tab.id);

// Until Account has content, the modal opens on the first tab that does.
export const DEFAULT_SETTINGS_TAB: SettingsMainTab = 'preferences';

export const DEFAULT_PROJECT_SORT_ORDER: ProjectSortOrder = 'name';
