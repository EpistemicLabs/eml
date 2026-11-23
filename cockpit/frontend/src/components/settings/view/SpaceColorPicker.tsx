import { useState } from 'react';

import { SPACE_COLORS, setSpaceColor, spaceTone } from '@/lib/space-color';
import { cn } from '@/lib/utils';
import { FOCUS } from '@/shared/view/ui';
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
    <div role="radiogroup" aria-label={`Colour of ${space.name}`} className="flex items-center">
      {SPACE_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          role="radio"
          aria-checked={color === space.color}
          aria-label={color}
          title={color}
          onClick={() => void pick(color)}
          className={cn('grid size-(--target-min) place-items-center rounded-full hover:bg-muted', FOCUS)}
        >
          {/* The swatch stays small; the button around it keeps the 24px target. The picked one is ringed. */}
          <span
            aria-hidden
            style={{ backgroundColor: spaceTone({ color }) }}
            className={cn('size-3.5 rounded-full', color === space.color && 'ring-2 ring-foreground ring-offset-2 ring-offset-card')}
          />
        </button>
      ))}
    </div>
  );
}
