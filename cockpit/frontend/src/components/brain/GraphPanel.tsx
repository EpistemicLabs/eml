// The project page's graph lenses. Logic ported from
// packages/web/components/graph/graph-panel.tsx: lens switch (timeline |
// subjects | tags), per-type chips (click = solo, Shift/Cmd-click = hide/show),
// Active only, ⚑ Review N, Show without subject (subjects), Show untagged (tags),
// All / None — over the project's engrams (limit 500, profiles excluded).
// Rendered with the cockpit's chip and segmented-control idiom (./ui.tsx)
// instead of web's buttons.
// v0.14 (spec §B.4): Subjects is the second lens; the relations lens is off the
// toggle until the relations graph is dense enough to be useful — the data and
// components/graph/relations-graph.tsx stay.
import { useMemo, useState } from "react";

import { useProjectEngrams } from "@/lib/queries";
import { type EngramType } from "@/lib/types";
import { TagGraph } from "@/components/graph/tag-graph";
import { SubjectGraph } from "@/components/graph/subject-graph";
import { Timeline } from "@/components/timeline/timeline";
import { TYPE_COLORS, TYPE_ORDER, typeChipStyle } from "@/components/ui/badge";
import { BrainCard, EmptyNote, Segmented, ToggleChip } from "./ui";

type ViewMode = "timeline" | "subjects" | "tags";

const LENSES: ReadonlyArray<{ value: ViewMode; label: string }> = [
  { value: "timeline", label: "timeline" },
  { value: "subjects", label: "subjects" },
  { value: "tags", label: "tags" },
];

const REVIEW_ACCENT = "var(--color-review)"; // amber, same hue as the decision type

export default function GraphPanel({ projectId, height = "h-[560px]" }: { projectId: string; height?: string }) {
  const engramsQuery = useProjectEngrams(projectId, { limit: 500 });

  // Profiles are an identity facet, not project work — kept out of the project
  // graph (chips + nodes) entirely.
  const allEngrams = useMemo(
    () => (engramsQuery.data?.engrams ?? []).filter((e) => e.type !== "profile"),
    [engramsQuery.data],
  );

  const presentTypes = useMemo(() => {
    const seen = new Set<EngramType>();
    for (const e of allEngrams) seen.add(e.type);
    return TYPE_ORDER.filter((t) => seen.has(t));
  }, [allEngrams]);

  const [selected, setSelected] = useState<Set<EngramType> | null>(null);
  const activeTypes = selected ?? new Set(presentTypes);

  const [showUntagged, setShowUntagged] = useState(false);
  const [showWithoutSubject, setShowWithoutSubject] = useState(false);
  const [showReviewOnly, setShowReviewOnly] = useState(false);
  const [activeOnly, setActiveOnly] = useState(false);
  const [view, setView] = useState<ViewMode>("timeline");

  // How many engrams are due for a review — drives the ⚑ filter
  // (shown only when there's something to filter to).
  const reviewCount = useMemo(
    () => allEngrams.filter((e) => e.review_due).length,
    [allEngrams],
  );

  const engrams = useMemo(
    () =>
      allEngrams.filter(
        (e) =>
          activeTypes.has(e.type) &&
          (!showReviewOnly || e.review_due) &&
          (!activeOnly || e.status === "active" || e.status === "planned"),
      ),
    [allEngrams, activeTypes, showReviewOnly, activeOnly],
  );

  // Plain click = solo (show only this type; click the soloed type again to
  // restore all). Shift/Cmd-click = add or remove this type from what is shown
  // (a hidden chip fades).
  function pick(t: EngramType, additive: boolean) {
    if (!additive) {
      const isSolo = activeTypes.size === 1 && activeTypes.has(t);
      setSelected(isSolo ? new Set(presentTypes) : new Set([t]));
      return;
    }
    const next = new Set(activeTypes);
    if (next.has(t)) next.delete(t);
    else next.add(t);
    setSelected(next);
  }

  const loading = engramsQuery.isLoading;

  return (
    <BrainCard className="flex flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-1.5 p-3">
        <div className="mr-2">
          <Segmented value={view} options={LENSES} onChange={setView} ariaLabel="Graph lens" />
        </div>
        {presentTypes.map((t) => {
          const on = activeTypes.has(t);
          const color = TYPE_COLORS[t];
          return (
            <button
              key={t}
              type="button"
              onClick={(e) => pick(t, e.metaKey || e.shiftKey)}
              title="Click: only this type (again: all) · Shift/Cmd-click: add/remove this type"
              className="h-6 rounded-full border px-2.5 text-caption font-medium capitalize transition-opacity"
              style={typeChipStyle(color, on)}
            >
              {t}
            </button>
          );
        })}
        <div className="ml-auto flex flex-wrap items-center gap-1">
          <ToggleChip
            active={activeOnly}
            onClick={() => setActiveOnly((v) => !v)}
            title="Show only active / planned engrams — hide superseded, invalidated, resolved"
          >
            Active only
          </ToggleChip>
          {reviewCount > 0 && (
            <button
              type="button"
              onClick={() => setShowReviewOnly((v) => !v)}
              title="Show only engrams flagged for review"
              className="inline-flex h-6 items-center gap-1 rounded-full border px-2.5 text-caption font-medium transition-colors"
              style={{
                borderColor: REVIEW_ACCENT,
                color: showReviewOnly ? "var(--color-background)" : REVIEW_ACCENT,
                backgroundColor: showReviewOnly ? REVIEW_ACCENT : "transparent",
              }}
            >
              ⚑ Review {reviewCount}
            </button>
          )}
          {view === "subjects" && (
            <ToggleChip active={showWithoutSubject} onClick={() => setShowWithoutSubject((v) => !v)}>
              {showWithoutSubject ? "Hide" : "Show"} without subject
            </ToggleChip>
          )}
          {view === "tags" && (
            <ToggleChip active={showUntagged} onClick={() => setShowUntagged((v) => !v)}>
              {showUntagged ? "Hide" : "Show"} untagged
            </ToggleChip>
          )}
          <ToggleChip active={false} onClick={() => setSelected(new Set(presentTypes))}>All</ToggleChip>
          <ToggleChip active={false} onClick={() => setSelected(new Set<EngramType>())}>None</ToggleChip>
        </div>
      </div>

      <div className={`${height} w-full border-t border-border`}>
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <EmptyNote>Loading…</EmptyNote>
          </div>
        ) : view === "timeline" ? (
          <Timeline engrams={engrams} />
        ) : view === "subjects" ? (
          <SubjectGraph engrams={engrams} showWithoutSubject={showWithoutSubject} />
        ) : (
          <TagGraph engrams={engrams} showUntagged={showUntagged} />
        )}
      </div>
    </BrainCard>
  );
}
