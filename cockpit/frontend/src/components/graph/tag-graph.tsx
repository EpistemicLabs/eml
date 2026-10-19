import { useMemo, useState } from "react";
import { Background, Controls, Panel, ReactFlow, type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { HoverContext, tagNodeTypes, type EngramNodeData, type TagHubNodeData } from "./nodes";
import { useEngramPanel } from "@/lib/engram-panel";
import { buildTagGraph, tagColor } from "@/lib/tag-graph";
import { useTheme } from "@/contexts/ThemeContext";
import type { Engram } from "@/lib/types";

// Ported from packages/web/components/graph/tag-graph.tsx (+ xyflow dark colour
// mode). The "tags" lens: engrams cluster around tag-hub backbone nodes. Same
// render discipline as RelationsGraph — the force layout is memoized on data,
// hover dimming is applied cheaply via HoverContext (node array stays
// identity-stable, so ReactFlow never re-measures → no flicker).
export function TagGraph({ engrams, showUntagged }: { engrams: Engram[]; showUntagged: boolean }) {
  const { open } = useEngramPanel();
  const { isDarkMode } = useTheme();
  const [hovered, setHovered] = useState<string | null>(null);

  const graph = useMemo(() => buildTagGraph(engrams), [engrams]);

  // Distinct tags present — drives the legend.
  const usedTags = useMemo(() => graph.hubs.map((h) => h.key), [graph.hubs]);

  // Neighborhood of the hovered node: an engram lights its hubs (+ itself); a hub
  // lights its member engrams (+ itself). Built from the engram→hub edges.
  const neighborhood = useMemo(() => {
    if (!hovered) return null;
    const set = new Set<string>([hovered]);
    for (const e of graph.edges) {
      if (e.source === hovered) set.add(e.target);
      if (e.target === hovered) set.add(e.source);
    }
    return set;
  }, [hovered, graph.edges]);

  // Nodes depend ONLY on data + showUntagged — never on hover (hover dimming is
  // read from context inside each card). Hubs first so they sit under the cards.
  const nodes: Node[] = useMemo(() => {
    const hubNodes: Node[] = graph.hubs.map((h) => {
      const data: TagHubNodeData = { tag: h.key, color: tagColor(h.key), memberCount: h.memberCount };
      return { id: h.id, type: "tagHub", position: h.position, data, draggable: true };
    });
    const engramSource = showUntagged ? [...graph.nodes, ...graph.unassigned] : graph.nodes;
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
  }, [graph, showUntagged]);

  const edges: Edge[] = useMemo(
    () =>
      graph.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        style: { stroke: tagColor(e.key), strokeWidth: 1, opacity: 0.4 },
      })),
    [graph.edges],
  );

  const hoverValue = useMemo(() => ({ hovered, neighbors: neighborhood }), [hovered, neighborhood]);

  if (graph.hubs.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 text-muted-foreground">
        <p>No tagged engrams in the selected filters.</p>
        <p className="text-xs">Tag engrams (eml_create_object object=tag, then the tags param) to grow the tag hubs.</p>
      </div>
    );
  }

  return (
    <HoverContext.Provider value={hoverValue}>
      <ReactFlow
        // Remount when the untagged ring is toggled so fitView re-runs — else the
        // huge ring lands off-screen and the toggle looks like a no-op.
        key={showUntagged ? "all" : "tagged"}
        nodes={nodes}
        edges={edges}
        nodeTypes={tagNodeTypes}
        colorMode={isDarkMode ? "dark" : "light"}
        fitView
        minZoom={0.05}
        style={{ width: "100%", height: "100%" }}
        proOptions={{ hideAttribution: true }}
        onNodeMouseEnter={(_, node) => setHovered(node.id)}
        onNodeMouseLeave={() => setHovered(null)}
        onNodeClick={(_, node) => {
          if (!node.id.startsWith("tag:")) open(node.id);
        }}
      >
        <Background />
        <Controls />
        <Panel position="top-left" className="rounded-md border border-border bg-card/90 px-3 py-2 text-xs shadow-sm backdrop-blur">
          <div className="mb-1 font-medium text-foreground">
            {graph.hubs.length} tag{graph.hubs.length === 1 ? "" : "s"} · {graph.nodes.length} tagged
          </div>
          <div className="text-muted-foreground">
            {graph.unassignedCount} untagged
            {!showUntagged && graph.unassignedCount > 0 && <> (hidden)</>}
          </div>
          <div className="mt-2 flex max-w-[220px] flex-wrap gap-x-2 gap-y-0.5">
            {usedTags.map((t) => (
              <span key={t} className="inline-flex items-center gap-1">
                <span className="inline-block h-2 w-2 rounded-full" style={{ background: tagColor(t) }} />
                <span className="text-muted-foreground">{t}</span>
              </span>
            ))}
          </div>
        </Panel>
      </ReactFlow>
    </HoverContext.Provider>
  );
}
