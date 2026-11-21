// Kept: backdrop + frosted window (90vh, max-w-4xl), header with title,
// "saved" flash and close, sidebar + fading content. The kit's Dialog closes it
// on Escape or a click beside it and keeps the focus inside while it is open.
// Trimmed: provider login modal, web-push wiring, the tabs the cockpit
// has no substrate for (Data renders a placeholder until it does).
import { X } from 'lucide-react';

import { Button, Dialog, DialogContent, DialogTitle } from '@/shared/view/ui';
import SettingsSidebar from './SettingsSidebar';
import PreferencesTab from './tabs/PreferencesTab';
import AboutTab from './tabs/AboutTab';
import AccountTab from './tabs/AccountTab';
import AgentTab from './tabs/AgentTab';
import ModelsTab from './tabs/ModelsTab';
import DataTab from './tabs/DataTab';
import PluginsTab from './tabs/PluginsTab';
import SettingsHeading from './SettingsHeading';
import SpacesTab from './tabs/SpacesTab';
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
    greetOnStart,
    setGreetOnStart,
  } = useSettingsController({ isOpen, initialTab });

  if (!isOpen) {
    return null;
  }

  const activeMeta = SETTINGS_MAIN_TABS.find((tab) => tab.id === activeTab) ?? SETTINGS_MAIN_TABS[0];

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        aria-labelledby="settings-title"
        className="flex h-(--size-settings) max-w-4xl flex-col overflow-hidden"
      >
        {/* Header */}
        <div className="flex flex-shrink-0 items-center justify-between border-b border-border px-5 py-3">
          <DialogTitle id="settings-title" className="not-sr-only text-title font-semibold text-foreground">Settings</DialogTitle>
          <div className="flex items-center gap-2">
            {saveStatus === 'success' && (
              <span className="text-ui text-muted-foreground">Settings saved</span>
            )}
            {saveStatus === 'error' && (
              <span className="text-ui text-stopped-ink">Failed to save settings</span>
            )}
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              aria-label="Close settings"
            >
              <X aria-hidden />
            </Button>
          </div>
        </div>

        {/* Body: sidebar + content */}
        <div className="flex min-h-0 flex-1">
          <SettingsSidebar activeTab={activeTab} onChange={setActiveTab} />

          <main className="flex-1 overflow-y-auto">
            <div key={activeTab} className="animate-fade-in space-y-8 p-6">
              {activeTab !== 'spaces' && activeTab !== 'agents' && activeTab !== 'about' && <SettingsHeading tab={activeMeta} />}

              {activeTab === 'account' && <AccountTab />}

              {activeTab === 'agents' && <AgentTab tab={activeMeta} />}

              {activeTab === 'models' && <ModelsTab onCloseSettings={onClose} />}

              {activeTab === 'spaces' && <SpacesTab tab={activeMeta} />}

              {activeTab === 'preferences' && (
                <PreferencesTab
                  projectSortOrder={projectSortOrder}
                  onProjectSortOrderChange={setProjectSortOrder}
                  greetOnStart={greetOnStart}
                  onGreetOnStartChange={setGreetOnStart}
                />
              )}

              {activeTab === 'about' && <AboutTab />}

              {activeTab === 'data' && <DataTab tab={activeMeta} />}

              {activeTab === 'plugins' && <PluginsTab />}
            </div>
          </main>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default Settings;
