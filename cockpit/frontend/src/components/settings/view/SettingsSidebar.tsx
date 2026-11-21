// Kept: the desktop list (same material as the modal body, hairline
// border), row styling. Trimmed: the Agents/provider section with its
// logos (Agents is one plain tab here), the mobile pill bar, i18n.
import type { ComponentType } from 'react';
import { ChevronRight } from 'lucide-react';

import { cn } from '@/lib/utils';
import { ROW } from '@/shared/view/ui';
import { SETTINGS_MAIN_TABS } from '../constants/constants';
import type { SettingsMainTab } from '../types/types';

type SettingsSidebarProps = {
  activeTab: SettingsMainTab;
  onChange: (tab: SettingsMainTab) => void;
  className?: string;
};

type IconComponent = ComponentType<{ className?: string }>;

/** The sections: a sidebar beside the open one on a wide screen, the whole first screen on a phone. */
export default function SettingsSidebar({ activeTab, onChange, className }: SettingsSidebarProps) {
  return (
    <aside className={cn('flex w-56 flex-shrink-0 flex-col overflow-y-auto border-r border-border max-md:w-full max-md:border-r-0', className)}>
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
      className={cn(
        ROW,
        'min-h-(--target-comfortable) gap-3 px-3 font-medium max-md:min-h-(--target-touch) max-md:text-foreground max-md:aria-[current=page]:bg-transparent',
        isActive ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      <Icon aria-hidden className="size-4 flex-shrink-0" />
      <span className="flex-1">{label}</span>
      <ChevronRight aria-hidden className="size-4 flex-shrink-0 text-muted-foreground md:hidden" />
    </button>
  );
}
