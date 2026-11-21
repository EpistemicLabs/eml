// Kept: the desktop list (same material as the modal body, hairline
// border), row styling. Trimmed: the Agents/provider section with its
// logos (Agents is one plain tab here), the mobile pill bar, i18n.
import type { ComponentType } from 'react';

import { cn } from '@/lib/utils';
import { ROW } from '@/shared/view/ui';
import { SETTINGS_MAIN_TABS } from '../constants/constants';
import type { SettingsMainTab } from '../types/types';

type SettingsSidebarProps = {
  activeTab: SettingsMainTab;
  onChange: (tab: SettingsMainTab) => void;
};

type IconComponent = ComponentType<{ className?: string }>;

export default function SettingsSidebar({ activeTab, onChange }: SettingsSidebarProps) {
  return (
    <aside className="flex w-56 flex-shrink-0 flex-col border-r border-border">
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
      aria-current={isActive ? 'page' : undefined}
      className={cn(ROW, 'min-h-(--target-comfortable) gap-3 px-3 font-medium', isActive ? 'text-foreground' : 'text-muted-foreground hover:text-foreground')}
    >
      <Icon aria-hidden className="size-4 flex-shrink-0" />
      {label}
    </button>
  );
}
