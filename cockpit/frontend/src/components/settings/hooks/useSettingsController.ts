// Kept: tab normalisation on open, the "saved" flash with its 2s reset.
// Every change is written when it is made (a toggle, a select — nothing to
// debounce). Trimmed: provider permissions/login, notification
// preferences over HTTP, code-editor state — the cockpit persists one small
// client-side blob (see utils/settingsStorage.ts).
import { useCallback, useEffect, useState } from 'react';

import { DEFAULT_SETTINGS_TAB, KNOWN_MAIN_TABS } from '../constants/constants';
import type { CockpitSettings, ProjectSortOrder, SaveStatus, SettingsMainTab } from '../types/types';
import { readSettings, writeSettings } from '../utils/settingsStorage';

type UseSettingsControllerArgs = {
  isOpen: boolean;
  initialTab: string;
};

const normalizeMainTab = (tab: string): SettingsMainTab => {
  // Older callers say "appearance", "theme" or "notifications" — all live in Preferences now.
  if (tab === 'appearance' || tab === 'theme' || tab === 'notifications') return 'preferences';
  return KNOWN_MAIN_TABS.includes(tab as SettingsMainTab) ? (tab as SettingsMainTab) : DEFAULT_SETTINGS_TAB;
};

export function useSettingsController({ isOpen, initialTab }: UseSettingsControllerArgs) {
  const [activeTab, setActiveTab] = useState<SettingsMainTab>(() => normalizeMainTab(initialTab));
  const [saveStatus, setSaveStatus] = useState<SaveStatus>(null);
  const [projectSortOrder, setProjectSortOrder] = useState<ProjectSortOrder>(() => readSettings().projectSortOrder);
  const [notifyOnDone, setNotifyOnDone] = useState<boolean>(() => readSettings().notifyOnDone);

  const loadSettings = useCallback(() => {
    const settings = readSettings();
    setProjectSortOrder(settings.projectSortOrder);
    setNotifyOnDone(settings.notifyOnDone);
  }, []);

  // Write one change at once. The debounced auto-save this replaces skipped
  // the first change after opening as "the load", so a first toggle was shown
  // but never stored.
  const save = useCallback((patch: Partial<CockpitSettings>) => {
    try {
      writeSettings(patch);
      setSaveStatus('success');
    } catch (error) {
      console.error('Error saving settings:', error);
      setSaveStatus('error');
    }
  }, []);

  const changeProjectSortOrder = useCallback((value: ProjectSortOrder) => {
    setProjectSortOrder(value);
    save({ projectSortOrder: value });
  }, [save]);

  const changeNotifyOnDone = useCallback((value: boolean) => {
    setNotifyOnDone(value);
    save({ notifyOnDone: value });
  }, [save]);

  // Re-sync tab + values every time the modal opens.
  useEffect(() => {
    if (!isOpen) return;
    setActiveTab(normalizeMainTab(initialTab));
    loadSettings();
  }, [initialTab, isOpen, loadSettings]);

  // Clear the "saved" flash after 2 seconds.
  useEffect(() => {
    if (saveStatus === null) return;
    const timer = window.setTimeout(() => setSaveStatus(null), 2000);
    return () => window.clearTimeout(timer);
  }, [saveStatus]);

  return {
    activeTab,
    setActiveTab,
    saveStatus,
    projectSortOrder,
    setProjectSortOrder: changeProjectSortOrder,
    notifyOnDone,
    setNotifyOnDone: changeNotifyOnDone,
  };
}
