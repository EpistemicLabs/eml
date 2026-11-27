// A window (90vh, max-w-settings) with the sections in a sidebar beside the open one; on a phone a
// full-screen sheet that shows the sections first and opens one with a back button (a navigation
// stack). Header with title, "saved" flash and close. The kit's Dialog closes it on Escape or a click
// beside it and keeps the focus inside while it is open.
// Trimmed: provider login modal, web-push wiring, the tabs the cockpit
// has no substrate for (Data renders a placeholder until it does).
import { useEffect, useState } from 'react';
import { ChevronLeft, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button, Dialog, DialogContent, DialogTitle } from '@/shared/view/ui';
import SettingsSidebar from './SettingsSidebar';
import PreferencesTab from './tabs/PreferencesTab';
import AboutTab from './tabs/AboutTab';
import AccountTab from './tabs/AccountTab';
import AgentTab from './tabs/AgentTab';
import ModelsTab from './tabs/ModelsTab';
import DataTab from './tabs/DataTab';
import AdvancedTab from './tabs/AdvancedTab';
import PluginsTab from './tabs/PluginsTab';
import SettingsHeading from './SettingsHeading';
import SpacesTab from './tabs/SpacesTab';
import { useSettingsController } from '../hooks/useSettingsController';
import { SETTINGS_MAIN_TABS } from '../constants/constants';
import type { SettingsProps } from '../types/types';

function Settings({ isOpen, onClose, initialTab }: SettingsProps) {
  const {
    activeTab,
    setActiveTab,
    saveStatus,
    projectSortOrder,
    setProjectSortOrder,
    greetOnStart,
    setGreetOnStart,
  } = useSettingsController({ isOpen, initialTab: initialTab ?? 'account' });
  // On a phone: the list of sections, or one section. Opened for a named tab, it shows that tab.
  const [showSection, setShowSection] = useState(initialTab !== undefined);
  useEffect(() => { if (isOpen) setShowSection(initialTab !== undefined); }, [isOpen, initialTab]);
  const openSection = (tab: typeof activeTab) => { setActiveTab(tab); setShowSection(true); };

  if (!isOpen) {
    return null;
  }

  const activeMeta = SETTINGS_MAIN_TABS.find((tab) => tab.id === activeTab) ?? SETTINGS_MAIN_TABS[0];

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        aria-labelledby="settings-title"
        data-phone-view={showSection ? 'section' : 'list'}
        className={cn(
          'flex h-(--size-settings) max-w-settings flex-col overflow-hidden',
          // Phone: a full-screen sheet clear of the notch and the home indicator.
          'max-md:top-0 max-md:left-0 max-md:h-full max-md:max-w-none max-md:transform-none max-md:animate-fade-in max-md:rounded-none max-md:border-0',
          'max-md:pt-[env(safe-area-inset-top)] max-md:pb-[env(safe-area-inset-bottom)]',
        )}
      >
        {/* Header */}
        <div className="flex flex-shrink-0 items-center justify-between gap-2 border-b border-border px-5 py-3 max-md:px-2">
          {showSection && (
            <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setShowSection(false)} aria-label="Back to all settings">
              <ChevronLeft aria-hidden />
            </Button>
          )}
          <DialogTitle id="settings-title" className="not-sr-only min-w-0 flex-1 truncate text-title font-semibold text-foreground">
            <span className={cn(showSection && 'max-md:hidden')}>Settings</span>
            {showSection && <span className="md:hidden">{activeMeta.label}</span>}
          </DialogTitle>
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
          <SettingsSidebar activeTab={activeTab} onChange={openSection} className={cn(showSection && 'max-md:hidden')} />

          <main className={cn('flex-1 overflow-y-auto', !showSection && 'max-md:hidden')}>
            <div key={activeTab} className="animate-fade-in space-y-8 p-6 max-md:p-4">
              {/* On a phone the bar above already names the section. */}
              {activeTab !== 'spaces' && activeTab !== 'agents' && activeTab !== 'about' && activeTab !== 'plugins' && <div className="max-md:hidden"><SettingsHeading tab={activeMeta} /></div>}

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

              {activeTab === 'advanced' && <AdvancedTab />}

              {activeTab === 'plugins' && <PluginsTab tab={activeMeta} />}
            </div>
          </main>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default Settings;
