// Kept: the desktop list (same material as the modal body, hairline
// border), row styling. Trimmed: the Agents/provider section with its
// logos (Agents is one plain tab here), the mobile pill bar, i18n.
import type { ComponentType } from 'react';

import { cn } from '@/lib/utils';
import { SETTINGS_MAIN_TABS } from '../constants/constants';
import type { SettingsMainTab } from '../types/types';

type SettingsSidebarProps = {
  activeTab: SettingsMainTab;
  onChange: (tab: SettingsMainTab) => void;
};

type IconComponent = ComponentType<{ className?: string }>;

export default function SettingsSidebar({ activeTab, onChange }: SettingsSidebarProps) {
  return (
    <aside className="flex w-56 flex-shrink-0 flex-col border-r border-foreground/8">
      <nav className="flex flex-col gap-0.5 p-3">
        {SETTINGS_MAIN_TABS.map((item) => (
          <SidebarItemRow
            key={item.id}
            icon={item.icon}
            label={item.label}
            isActive={activeTab === item.id}
            onClick={() => onChange(item.id)}
          />
        ))}
      </nav>
    </aside>
  );
}

type SidebarItemRowProps = {
  icon: IconComponent;
  label: string;
  isActive: boolean;
  onClick: () => void;
};

function SidebarItemRow({ icon: Icon, label, isActive, onClick }: SidebarItemRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium transition-colors duration-150',
        isActive
          ? 'bg-foreground/10 text-foreground'
          : 'text-muted-foreground hover:bg-foreground/6 hover:text-foreground active:bg-foreground/10',
      )}
    >
      <Icon className="h-4 w-4 flex-shrink-0" />
      {label}
    </button>
  );
}
