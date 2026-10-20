// Kept: backdrop + frosted window (90vh, max-w-4xl), header with title,
// "saved" flash and close, sidebar + fading content, Escape to close.
// Trimmed: provider login modal, web-push wiring, the tabs the cockpit
// has no substrate for (Plugins/Data render a placeholder until they do).
import { useEffect } from 'react';
import { X } from 'lucide-react';

import { Button } from '@/shared/view/ui';
import SettingsSidebar from './SettingsSidebar';
import SettingsPlaceholder from './SettingsPlaceholder';
import PreferencesTab from './tabs/PreferencesTab';
import AboutTab from './tabs/AboutTab';
import AccountTab from './tabs/AccountTab';
import AgentTab from './tabs/AgentTab';
import ModelsTab from './tabs/ModelsTab';
import BrainTab from './tabs/BrainTab';
import { useSettingsController } from '../hooks/useSettingsController';
import { SETTINGS_MAIN_TABS } from '../constants/constants';
import type { SettingsProps } from '../types/types';

function Settings({ isOpen, onClose, initialTab = 'account' }: SettingsProps) {
  const {
    activeTab,
    setActiveTab,
    saveStatus,
    projectSortOrder,
    setProjectSortOrder,
    notifyOnDone,
    setNotifyOnDone,
    greetOnStart,
    setGreetOnStart,
  } = useSettingsController({ isOpen, initialTab });

  // Escape closes — registered in the capture phase so a focused terminal
  // underneath doesn't swallow it (same reason DeskTabBar's ⌘1–9 does).
  useEffect(() => {
    if (!isOpen) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [isOpen, onClose]);

  if (!isOpen) {
    return null;
  }

  const activeMeta = SETTINGS_MAIN_TABS.find((tab) => tab.id === activeTab) ?? SETTINGS_MAIN_TABS[0];

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/20 p-4 backdrop-blur-md"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className="frosted flex h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-[20px]"
      >
        {/* Header */}
        <div className="flex flex-shrink-0 items-center justify-between border-b border-foreground/8 px-5 py-3">
          <h2 className="text-base font-semibold text-foreground">Settings</h2>
          <div className="flex items-center gap-2">
            {saveStatus === 'success' && (
              <span className="text-xs text-muted-foreground">Settings saved</span>
            )}
            {saveStatus === 'error' && (
              <span className="text-xs text-destructive">Failed to save settings</span>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={onClose}
              aria-label="Close settings"
              className="h-10 w-10 p-0 text-muted-foreground hover:text-foreground active:bg-foreground/10"
            >
              <X className="h-5 w-5" />
            </Button>
          </div>
        </div>

        {/* Body: sidebar + content */}
        <div className="flex min-h-0 flex-1">
          <SettingsSidebar activeTab={activeTab} onChange={setActiveTab} />

          <main className="flex-1 overflow-y-auto">
            <div key={activeTab} className="settings-content-enter space-y-8 p-6">
              {activeTab === 'account' && <AccountTab />}

              {activeTab === 'agents' && <AgentTab />}

              {activeTab === 'models' && <ModelsTab onCloseSettings={onClose} />}

              {activeTab === 'brain' && <BrainTab />}

              {activeTab === 'preferences' && (
                <PreferencesTab
                  projectSortOrder={projectSortOrder}
                  onProjectSortOrderChange={setProjectSortOrder}
                  notifyOnDone={notifyOnDone}
                  onNotifyOnDoneChange={setNotifyOnDone}
                  greetOnStart={greetOnStart}
                  onGreetOnStartChange={setGreetOnStart}
                />
              )}

              {activeTab === 'about' && <AboutTab />}

              {(activeTab === 'plugins' || activeTab === 'data') && <SettingsPlaceholder tab={activeMeta} />}
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}

export default Settings;
