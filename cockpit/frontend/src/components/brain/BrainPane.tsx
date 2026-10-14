// The `brain` pane-type — the brain next to a terminal, in one pane's width.
// First version: timeline | list over recent engrams,
// a live search, and type chips (click = hide/show, Shift/Cmd-click = solo).
// In a brain project the pane is scoped to that project (project | brain
// chip); no graph lens here (not readable at pane width). Rows open the
// global drawer.
import { useMemo, useState } from "react";

import { useList } from "@/lib/queries";
import type { Engram, EngramType } from "@/lib/types";
import type { Project } from "@/types/app";
import { EngramRow } from "@/components/engram-row";
import { Timeline } from "@/components/timeline/timeline";
import { TYPE_COLORS, TYPE_ORDER, typeChipStyle } from "@/components/ui/badge";
import { Input } from "@/shared/view/ui";
import { EmptyNote, Segmented } from "./ui";

type Lens = "timeline" | "list";

const LENSES: ReadonlyArray<{ value: Lens; label: string }> = [
  { value: "timeline", label: "timeline" },
  { value: "list", label: "list" },
];

type Reach = "project" | "brain";

const REACH: ReadonlyArray<{ value: Reach; label: string }> = [
  { value: "project", label: "project" },
  { value: "brain", label: "brain" },
];

export function BrainPane({ project = null }: { project?: Project | null }) {
  const [lens, setLens] = useState<Lens>("list");
  const [q, setQ] = useState("");
  const searching = q.trim().length > 0;

  // A pane in a brain project starts scoped to that project; the chip widens
  // it to the whole brain. Folder-only projects have no brain scope.
  const brainProjectId = project?.brainProjectId ?? null;
  const [reach, setReach] = useState<Reach>("project");
  const scope = brainProjectId && reach === "project" ? `project.${brainProjectId}` : undefined;

  // Recent engrams (newest first); a search swaps in its matches.
  const recent = useList({ limit: 200, order_by: "created_at", scope }, !searching);
  const found = useList({ search: q.trim(), limit: 100, scope }, searching);
  const query = searching ? found : recent;
  const all: Engram[] = useMemo(() => query.data?.engrams ?? [], [query.data]);

  // Type chips — same interaction as the project page's graph panel.
  const presentTypes = useMemo(() => {
    const seen = new Set<EngramType>();
    for (const e of all) seen.add(e.type);
    return TYPE_ORDER.filter((t) => seen.has(t));
  }, [all]);
  const [selected, setSelected] = useState<Set<EngramType> | null>(null);
  const activeTypes = selected ?? new Set(presentTypes);
  function pick(t: EngramType, additive: boolean) {
    if (additive) {
      const isSolo = activeTypes.size === 1 && activeTypes.has(t);
      setSelected(isSolo ? new Set(presentTypes) : new Set([t]));
      return;
    }
    const next = new Set(activeTypes);
    if (next.has(t)) next.delete(t);
    else next.add(t);
    setSelected(next);
  }

  const engrams = useMemo(() => all.filter((e) => activeTypes.has(e.type)), [all, activeTypes]);
  const ids = engrams.map((e) => e.id);

  return (
    <div className="@container flex h-full min-h-0 flex-col">
      {/* Toolbar: row 1 = lens switcher (+ scope in a
          brain project) and the search taking the rest of the width; row 2 =
          the type chips. */}
      <div className="flex flex-shrink-0 flex-col gap-2.5 border-b border-foreground/15 px-2 pt-2 pb-2.5">
        <div className="flex items-center gap-1.5">
          <Segmented value={lens} options={LENSES} onChange={setLens} ariaLabel="Brain lens" />
          {brainProjectId && (
            <Segmented value={reach} options={REACH} onChange={setReach} ariaLabel="Scope" />
          )}
          <div className="relative min-w-0 flex-1">
            <Input
              placeholder="Search the brain…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="h-7 text-ui"
            />
            {searching && (
              <button
                type="button"
                onClick={() => setQ("")}
                className="absolute top-1/2 right-2 -translate-y-1/2 text-caption text-muted-foreground hover:text-foreground"
              >
                ✕
              </button>
            )}
          </div>
        </div>
        {presentTypes.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {presentTypes.map((t) => {
              const on = activeTypes.has(t);
              const color = TYPE_COLORS[t];
              return (
                <button
                  key={t}
                  type="button"
                  onClick={(e) => pick(t, e.metaKey || e.shiftKey)}
                  title="Click to hide/show this type · Shift/Cmd-click to show only this type"
                  className="h-6 rounded-full border px-2 text-caption font-medium capitalize transition-opacity"
                  style={typeChipStyle(color, on)}
                >
                  {t}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1">
        {query.isLoading ? (
          <div className="p-3"><EmptyNote>{searching ? "Searching…" : "Loading brain…"}</EmptyNote></div>
        ) : query.error ? (
          <div className="p-3"><EmptyNote>Failed to reach the brain.</EmptyNote></div>
        ) : engrams.length === 0 ? (
          <div className="p-3"><EmptyNote>{searching ? `No matches for “${q.trim()}”.` : "Nothing yet."}</EmptyNote></div>
        ) : lens === "timeline" ? (
          <Timeline engrams={engrams} />
        ) : (
          <div className="flex h-full flex-col gap-1.5 overflow-y-auto px-2 pt-3 pb-2">
            {engrams.map((e) => (
              <EngramRow key={e.id} engram={e} showScope siblings={ids} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
