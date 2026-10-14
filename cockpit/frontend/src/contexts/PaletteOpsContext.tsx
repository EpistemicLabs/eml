// Dispatch registry for a few app-level operations (open settings, refresh
// projects). Owners register implementations late; consumers get stable
// handles that look up the current implementation at call time. Nothing here
// is reactive state — registering never re-renders anyone.
import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';

export type PaletteOps = {
  openSettings: (tab?: string) => void;
  refreshProjects: () => Promise<void> | void;
};

type OpName = keyof PaletteOps;

// One slot per operation; `undefined` means "nothing registered".
type Registry = { [K in OpName]?: PaletteOps[K] };

const RegistryContext = createContext<Registry | null>(null);

export function PaletteOpsProvider({ children }: { children: ReactNode }) {
  // The same mutable object for the provider's whole lifetime, so the context
  // value never changes identity.
  const registry = useRef<Registry>({}).current;
  return <RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>;
}

/** Stable handles that forward to whatever is registered when they are called. */
export function usePaletteOps(): PaletteOps {
  const registry = useContext(RegistryContext);
  return useMemo<PaletteOps>(
    () => ({
      openSettings: (tab) => {
        registry?.openSettings?.(tab);
      },
      refreshProjects: () => registry?.refreshProjects?.(),
    }),
    [registry],
  );
}

/** Register implementations for the lifetime of the calling component. */
export function usePaletteOpsRegister(ops: Partial<PaletteOps>): void {
  const registry = useContext(RegistryContext);
  const { openSettings, refreshProjects } = ops;

  useEffect(() => {
    if (!registry) return;

    const previous: Registry = { ...registry };
    const installed: Registry = {};
    if (openSettings !== undefined) registry.openSettings = installed.openSettings = openSettings;
    if (refreshProjects !== undefined) registry.refreshProjects = installed.refreshProjects = refreshProjects;

    return () => {
      // Only restore slots that still hold what this effect put there; a later
      // registrant must not be clobbered by an earlier one's cleanup.
      if (installed.openSettings !== undefined && registry.openSettings === installed.openSettings) {
        registry.openSettings = previous.openSettings;
      }
      if (installed.refreshProjects !== undefined && registry.refreshProjects === installed.refreshProjects) {
        registry.refreshProjects = previous.refreshProjects;
      }
    };
  }, [registry, openSettings, refreshProjects]);
}
