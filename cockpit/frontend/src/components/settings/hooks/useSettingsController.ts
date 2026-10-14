// Kept: tab normalisation on open, the "saved" flash with its 2s reset, the
// debounced auto-save. Trimmed: provider permissions/login, notification
// preferences over HTTP, code-editor state — the cockpit persists one small
// client-side blob (see utils/settingsStorage.ts).
import { useCallback, useEffect, useRef, useState } from 'react';

import { DEFAULT_SETTINGS_TAB, KNOWN_MAIN_TABS } from '../constants/constants';
import type { ProjectSortOrder, SaveStatus, SettingsMainTab } from '../types/types';
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

  const saveSettings = useCallback(() => {
    try {
      writeSettings({ projectSortOrder, notifyOnDone });
      setSaveStatus('success');
    } catch (error) {
      console.error('Error saving settings:', error);
      setSaveStatus('error');
    }
  }, [projectSortOrder, notifyOnDone]);

  // Re-sync tab + values every time the modal opens.
  useEffect(() => {
    if (!isOpen) return;
    setActiveTab(normalizeMainTab(initialTab));
    loadSettings();
  }, [initialTab, isOpen, loadSettings]);

  // Auto-save with debounce; skipped for the load that follows open.
  const autoSaveTimerRef = useRef<number | null>(null);
  const isInitialLoadRef = useRef(true);

  useEffect(() => {
    if (isInitialLoadRef.current) {
      isInitialLoadRef.current = false;
      return;
    }
    if (autoSaveTimerRef.current !== null) window.clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = window.setTimeout(saveSettings, 500);
    return () => {
      if (autoSaveTimerRef.current !== null) window.clearTimeout(autoSaveTimerRef.current);
    };
  }, [saveSettings]);

  useEffect(() => {
    if (isOpen) isInitialLoadRef.current = true;
  }, [isOpen]);

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
    setProjectSortOrder,
    notifyOnDone,
    setNotifyOnDone,
  };
}
