import type { ReactNode } from 'react';

import type { SettingsMainTabMeta } from '../constants/constants';

/** A tab's heading with its icon; `children` sit at its right end. */
export default function SettingsHeading({ tab, children }: { tab: SettingsMainTabMeta; children?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground">
        <tab.icon className="h-5 w-5 text-muted-foreground" />
        {tab.label}
      </h2>
      {children}
    </div>
  );
}
