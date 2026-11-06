import { useState } from 'react';

import { SPACE_COLORS, setSpaceColor, spaceTone } from '@/lib/space-color';
import { cn } from '@/lib/utils';
import type { SpaceInfo } from '@/stores/useSpaceStore';

/** The palette as swatches; the one the space has is ringed. */
export function SpaceColorPicker({ space, onError }: { space: SpaceInfo; onError: (message: string | null) => void }) {
  const [busy, setBusy] = useState(false);
  const pick = async (color: (typeof SPACE_COLORS)[number]) => {
    if (busy || color === space.color) return;
    setBusy(true);
    onError(await setSpaceColor(space, color));
    setBusy(false);
  };
  return (
    <div role="radiogroup" aria-label={`Colour of ${space.name}`} className="flex items-center gap-1">
      {SPACE_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          role="radio"
          aria-checked={color === space.color}
          aria-label={color}
          title={color}
          onClick={() => void pick(color)}
          style={{ backgroundColor: spaceTone({ color }) }}
          className={cn(
            'h-3.5 w-3.5 rounded-full transition-transform hover:scale-110',
            color === space.color && 'ring-2 ring-foreground/70 ring-offset-1 ring-offset-card',
          )}
        />
      ))}
    </div>
  );
}
