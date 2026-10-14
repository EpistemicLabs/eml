// Ported from packages/web/lib/views.ts (verbatim).
// Work / Life separation is a *view* over one brain, not separate data.
// v0 uses a hardcoded scope allowlist; the long-term convention (a tag on
// projects/entities) is an open design question in packages/web/PLAN.md §5.

export type ViewFilter = "all" | "work" | "life";

// Scopes considered "Life". Match by exact scope or prefix (e.g. "entity.family").
// Empty by default — until Life scopes exist, everything reads as Work.
export const LIFE_SCOPES: string[] = [];

export function isLifeScope(scope: string): boolean {
  return LIFE_SCOPES.some((s) => scope === s || scope.startsWith(`${s}.`));
}

/** Does a project (scope = project.<id>) belong to the given view? */
export function projectInView(projectId: string, view: ViewFilter): boolean {
  if (view === "all") return true;
  const life = isLifeScope(`project.${projectId}`);
  return view === "life" ? life : !life;
}
