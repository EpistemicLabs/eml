// The cockpit's settings tab list. `keywords` feed the command palette's
// "Settings: …" entries; `blurb` is the one-liner a not-yet-built tab shows.
import type { ComponentType } from 'react';
import {
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
    keywords: 'account plan free pro team subscription name profile user',
    icon: UserRound,
    blurb: 'You in this brain, and your plan.',
  },
  {
    id: 'agents',
    label: 'Agent',
    keywords: 'agent agents identity persona profile rules always on',
    icon: Bot,
    blurb: 'Your agent: its name, profile and the rules it always follows.',
  },
  {
    id: 'models',
    label: 'Models',
    keywords: 'models claude codex login sign in subscription permissions version update setup-token default',
    icon: Cpu,
    blurb: 'The agent CLIs sessions run with: sign-in, permissions and version for Claude Code and Codex (beta).',
  },
  {
    id: 'brain',
    label: 'Brain',
    keywords: 'brain spaces local token backup stats paths home folder config directory',
    icon: Brain,
    blurb: 'The brain instance: spaces, source, where the cockpit keeps its files, backups.',
  },
  {
    id: 'preferences',
    label: 'Preferences',
    keywords: 'preferences theme appearance dark light colors font sidebar sorting notifications alerts done badge browser',
    icon: SlidersHorizontal,
    blurb: 'Your personal setup: theme, sidebar ordering, notifications.',
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
    keywords: 'about version info updates license',
    icon: Info,
    blurb: 'Versions and updates.',
  },
];

export const KNOWN_MAIN_TABS: SettingsMainTab[] = SETTINGS_MAIN_TABS.map((tab) => tab.id);

export const DEFAULT_SETTINGS_TAB: SettingsMainTab = 'account';

export const DEFAULT_PROJECT_SORT_ORDER: ProjectSortOrder = 'name';
