import { useMemo, useState } from "react";
import { Background, Controls, Panel, ReactFlow, type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { HoverContext, subjectNodeTypes, type EngramNodeData, type SubjectHubNodeData } from "./nodes";
import { useEngramPanel } from "@/lib/engram-panel";
import { useSubjects } from "@/lib/queries";
import { buildSubjectGraph, subjectColor, SUBJECT_STATUS_COLOR } from "@/lib/subject-graph";
import { useTheme } from "@/contexts/ThemeContext";
import type { Engram, Subject } from "@/lib/types";

// v0.14: the "subjects" lens — engrams cluster around subject hubs. A structural
// clone of TagGraph (same facet-hub layout, same flicker-free hover model); the
// difference is the lifecycle: hubs carry a status ring + description from the
// subject registry, and closed strands are muted, not hidden (hub ~0.4, edges ~0.2).
export function SubjectGraph({ engrams, showWithoutSubject }: { engrams: Engram[]; showWithoutSubject: boolean }) {
  const { open } = useEngramPanel();
  const { isDarkMode } = useTheme();
  const [hovered, setHovered] = useState<string | null>(null);
  const subjectsQuery = useSubjects();

  const graph = useMemo(() => buildSubjectGraph(engrams), [engrams]);

  const registry = useMemo(() => {
    const byId = new Map<string, Subject>();
    for (const t of subjectsQuery.data?.subjects ?? []) byId.set(t.id, t);
    return byId;
  }, [subjectsQuery.data]);

  // Hubs in this view with their registry entry — drives the legend (active first).
  const usedSubjects = useMemo(
    () =>
      graph.hubs
        .map((h) => ({ id: h.key, subject: registry.get(h.key) }))
        .sort((a, b) => Number(a.subject?.status === "closed") - Number(b.subject?.status === "closed")),
    [graph.hubs, registry],
  );

  const neighborhood = useMemo(() => {
    if (!hovered) return null;
    const set = new Set<string>([hovered]);
    for (const e of graph.edges) {
      if (e.source === hovered) set.add(e.target);
      if (e.target === hovered) set.add(e.source);
    }
    return set;
  }, [hovered, graph.edges]);

  const nodes: Node[] = useMemo(() => {
    const hubNodes: Node[] = graph.hubs.map((h) => {
      const t = registry.get(h.key);
      const data: SubjectHubNodeData = {
        name: t?.name ?? h.key,
        description: t?.description ?? null,
        status: t?.status ?? "active",
        color: subjectColor(h.key),
        memberCount: h.memberCount,
        totalCount: t?.engram_count ?? h.memberCount,
      };
      return { id: h.id, type: "subjectHub", position: h.position, data, draggable: true };
    });
    const engramSource = showWithoutSubject ? [...graph.nodes, ...graph.unassigned] : graph.nodes;
    const engramNodes: Node[] = engramSource.map((n) => {
      const data: EngramNodeData = {
        label: n.label,
        engramType: n.engramType,
        degree: n.facetCount,
        isolated: n.unassigned,
        historyCount: 0,
        review: n.review,
      };
      return { id: n.id, type: "engram", position: n.position, data, draggable: true };
    });
    return [...hubNodes, ...engramNodes];
  }, [graph, registry, showWithoutSubject]);

  const edges: Edge[] = useMemo(
    () =>
      graph.edges.map((e) => {
        const closed = registry.get(e.key)?.status === "closed";
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          style: {
            stroke: closed ? SUBJECT_STATUS_COLOR.closed : subjectColor(e.key),
            strokeWidth: 1,
            opacity: closed ? 0.2 : 0.45,
          },
        };
      }),
    [graph.edges, registry],
  );

  const hoverValue = useMemo(() => ({ hovered, neighbors: neighborhood }), [hovered, neighborhood]);

  if (graph.hubs.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 text-muted-foreground">
        <p>No engrams in a subject in the selected filters.</p>
        <p className="text-xs">Create a subject (eml_create_object object=subject) and assign it via the subjects param to grow the strands.</p>
      </div>
    );
  }

  return (
    <HoverContext.Provider value={hoverValue}>
      <ReactFlow
        // Remount when the without a subject ring is toggled so fitView re-runs.
        key={showWithoutSubject ? "all" : "subjectd"}
        nodes={nodes}
        edges={edges}
        nodeTypes={subjectNodeTypes}
        colorMode={isDarkMode ? "dark" : "light"}
        fitView
        minZoom={0.05}
        style={{ width: "100%", height: "100%" }}
        proOptions={{ hideAttribution: true }}
        onNodeMouseEnter={(_, node) => setHovered(node.id)}
        onNodeMouseLeave={() => setHovered(null)}
        onNodeClick={(_, node) => {
          if (!node.id.startsWith("subject:")) open(node.id);
        }}
      >
        <Background />
        <Controls />
        <Panel position="top-left" className="rounded-md border border-border bg-card/90 px-3 py-2 text-xs shadow-sm backdrop-blur">
          <div className="mb-1 font-medium text-foreground">
            {graph.hubs.length} subject{graph.hubs.length === 1 ? "" : "s"} · {graph.nodes.length} in a subject
          </div>
          <div className="text-muted-foreground">
            {graph.unassignedCount} without a subject
            {!showWithoutSubject && graph.unassignedCount > 0 && <> (hidden)</>}
          </div>
          <div className="mt-2 flex max-w-[240px] flex-col gap-0.5">
            {usedSubjects.map(({ id, subject }) => {
              const closed = subject?.status === "closed";
              return (
                <span key={id} className="inline-flex items-center gap-1.5" style={{ opacity: closed ? 0.55 : 1 }}>
                  <span
                    className="inline-block h-2 w-2 shrink-0 rounded-full"
                    style={{
                      background: closed ? "transparent" : subjectColor(id),
                      border: `1.5px solid ${closed ? SUBJECT_STATUS_COLOR.closed : SUBJECT_STATUS_COLOR.active}`,
                    }}
                  />
                  <span className={`truncate text-muted-foreground ${closed ? "line-through" : ""}`}>{subject?.name ?? id}</span>
                </span>
              );
            })}
          </div>
        </Panel>
      </ReactFlow>
    </HoverContext.Provider>
  );
}
