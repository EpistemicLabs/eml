import type { ReactNode } from 'react';

import type { SettingsMainTabMeta } from '../constants/constants';

/** A tab's heading with its icon; `children` sit right next to it, `description` just under it. */
export default function SettingsHeading({ tab, description, children }: { tab: SettingsMainTabMeta; description?: string; children?: ReactNode }) {
  const heading = (
    <div className="flex items-center gap-4">
      <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground">
        <tab.icon className="h-5 w-5 text-muted-foreground" />
        {tab.heading ?? tab.label}
      </h2>
      {children}
    </div>
  );
  if (!description) return heading;
  return (
    <div className="space-y-1">
      {heading}
      <p className="text-sm text-muted-foreground">{description}</p>
    </div>
  );
}
