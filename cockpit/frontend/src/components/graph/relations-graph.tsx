import { useMemo, useState } from "react";
import {
  Background,
  Controls,
  MarkerType,
  Panel,
  ReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { HoverContext, nodeTypes, type EngramNodeData } from "./nodes";
import { useEngramPanel } from "@/lib/engram-panel";
import { buildGraph, relationColors, RELATION_COLORS } from "@/lib/graph";
import { useTheme } from "@/contexts/ThemeContext";
import type { Engram, Relation } from "@/lib/types";

// Ported from packages/web/components/graph/relations-graph.tsx (+ xyflow dark colour mode).

export function RelationsGraph({
  engrams,
  relations,
  showIsolated,
  showHistory,
}: {
  engrams: Engram[];
  relations: Relation[];
  showIsolated: boolean;
  showHistory: boolean;
}) {
  const { open } = useEngramPanel();
  const [hovered, setHovered] = useState<string | null>(null);
  const { isDarkMode } = useTheme();
  const colors = relationColors(isDarkMode);

  const graph = useMemo(
    () => buildGraph(engrams, relations, { showHistory }),
    [engrams, relations, showHistory],
  );

  const usedRelations = useMemo(() => {
    const seen = new Set<string>();
    for (const e of graph.edges) seen.add(e.relation);
    return [...seen] as (keyof typeof RELATION_COLORS)[];
  }, [graph.edges]);

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
    const all = showIsolated ? [...graph.nodes, ...graph.isolated] : graph.nodes;
    return all.map((n) => {
      const data: EngramNodeData = {
        label: n.label,
        engramType: n.engramType,
        degree: n.degree,
        isolated: n.isolated,
        historyCount: n.historyCount,
        review: n.review,
      };
      return { id: n.id, type: "engram", position: n.position, data, draggable: true };
    });
  }, [graph, showIsolated]);

  const edges: Edge[] = useMemo(() => {
    return graph.edges.map((e) => {
      const color = colors[e.relation] ?? colors.related_to;
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        style: { stroke: color, strokeWidth: e.relation === "related_to" ? 1 : 1.5, opacity: 0.55 },
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 12, height: 12 },
      } satisfies Edge;
    });
  }, [graph.edges, colors]);

  const hoverValue = useMemo(() => ({ hovered, neighbors: neighborhood }), [hovered, neighborhood]);

  return (
    <HoverContext.Provider value={hoverValue}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        colorMode={isDarkMode ? "dark" : "light"}
        fitView
        minZoom={0.05}
        style={{ width: "100%", height: "100%" }}
        proOptions={{ hideAttribution: true }}
        onNodeMouseEnter={(_, node) => setHovered(node.id)}
        onNodeMouseLeave={() => setHovered(null)}
        onNodeClick={(_, node) => open(node.id)}
      >
        <Background />
        <Controls />
        <Panel
          position="top-left"
          className="rounded-md border border-border bg-card/90 px-3 py-2 text-xs shadow-sm backdrop-blur"
        >
          <div className="mb-1 font-medium text-foreground">
            {graph.nodes.length} connected · {graph.edges.length} edges
          </div>
          <div className="text-muted-foreground">
            {graph.isolated.length} unconnected
            {graph.externalCount > 0 && <> · +{graph.externalCount} external</>}
            {graph.hiddenHistory > 0 && <> · ⧗{graph.hiddenHistory} history hidden</>}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-2 gap-y-0.5">
            {usedRelations.map((r) => (
              <span key={r} className="inline-flex items-center gap-1">
                <span className="inline-block h-2 w-3 rounded-sm" style={{ background: colors[r] }} />
                <span className="text-muted-foreground">{r}</span>
              </span>
            ))}
          </div>
        </Panel>
      </ReactFlow>
    </HoverContext.Provider>
  );
}
