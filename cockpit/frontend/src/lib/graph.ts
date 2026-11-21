import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCollide,
  forceX,
  forceY,
  type SimulationNodeDatum,
} from "d3-force";
import { type Engram, type EngramType, type Relation, type RelationType } from "./types";

// Pure graph model (no React/xyflow import) so it stays testable. Ported verbatim
// from packages/web/lib/graph.ts. The graph is the RELATION network: nodes are
// engrams, edges are real engram→engram relations; a d3-force sim clusters
// connected engrams, isolated ones sit on a muted outer ring.

export interface GraphNode {
  id: string;
  label: string;
  engramType: EngramType;
  degree: number;
  isolated: boolean;
  historyCount: number;
  review: boolean;
  position: { x: number; y: number };
}

export const CARD_W = 168;
export const CARD_H = 48;

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  relation: RelationType;
}

export interface Graph {
  nodes: GraphNode[];
  isolated: GraphNode[];
  edges: GraphEdge[];
  externalCount: number;
  hiddenHistory: number;
}

export interface BuildOptions {
  showHistory?: boolean;
}

function nodeLabel(e: Engram): string {
  if (e.title) return e.title;
  const line = e.content.split("\n").find((l) => l.trim()) ?? e.content;
  return line.slice(0, 48);
}

interface SimNode extends SimulationNodeDatum {
  id: string;
}

export function buildGraph(
  engrams: Engram[],
  relations: Relation[],
  opts: BuildOptions = {},
): Graph {
  const showHistory = opts.showHistory ?? false;

  const historyById = new Map<string, number>();
  let hiddenHistory = 0;
  for (const r of relations) {
    if (r.relation === "supersedes") {
      historyById.set(r.source_id, (historyById.get(r.source_id) ?? 0) + 1);
      if (!showHistory) hiddenHistory++;
    }
  }

  const effEngrams = showHistory
    ? engrams
    : engrams.filter((e) => e.status !== "superseded");
  const effRelations = showHistory
    ? relations
    : relations.filter((r) => r.relation !== "supersedes");

  const byId = new Map(effEngrams.map((e) => [e.id, e]));

  const inEdges: GraphEdge[] = [];
  let externalCount = 0;
  const degree = new Map<string, number>();
  for (const r of effRelations) {
    const hasSrc = byId.has(r.source_id);
    const hasTgt = byId.has(r.target_id);
    if (hasSrc && hasTgt) {
      if (r.source_id === r.target_id) continue;
      inEdges.push({
        id: `r-${r.id}`,
        source: r.source_id,
        target: r.target_id,
        relation: r.relation,
      });
      degree.set(r.source_id, (degree.get(r.source_id) ?? 0) + 1);
      degree.set(r.target_id, (degree.get(r.target_id) ?? 0) + 1);
    } else if (hasSrc || hasTgt) {
      externalCount++;
    }
  }

  const connectedIds = new Set<string>();
  for (const e of inEdges) {
    connectedIds.add(e.source);
    connectedIds.add(e.target);
  }

  const simNodes: SimNode[] = [...connectedIds].map((id) => ({ id }));
  const simLinks = inEdges.map((e) => ({ source: e.source, target: e.target }));
  const collideR = Math.hypot(CARD_W, CARD_H) / 2 + 10;

  const sim = forceSimulation(simNodes)
    .force(
      "link",
      forceLink(simLinks)
        .id((d) => (d as SimNode).id)
        .distance(150)
        .strength(0.5),
    )
    .force("charge", forceManyBody().strength(-650))
    .force("collide", forceCollide<SimNode>().radius(collideR))
    .force("x", forceX(0).strength(0.04))
    .force("y", forceY(0).strength(0.04))
    .stop();
  for (let i = 0; i < 320; i++) sim.tick();

  const posById = new Map(simNodes.map((n) => [n.id, n]));

  const nodes: GraphNode[] = [...connectedIds].map((id) => {
    const e = byId.get(id)!;
    const deg = degree.get(id) ?? 0;
    const p = posById.get(id)!;
    return {
      id,
      label: nodeLabel(e),
      engramType: e.type,
      degree: deg,
      isolated: false,
      historyCount: historyById.get(id) ?? 0,
      review: e.review_due,
      position: { x: (p.x ?? 0) - CARD_W / 2, y: (p.y ?? 0) - CARD_H / 2 },
    };
  });

  const isolatedEngrams = effEngrams.filter((e) => !connectedIds.has(e.id));
  let ringR = 0;
  for (const n of nodes) {
    const cx = n.position.x + CARD_W / 2;
    const cy = n.position.y + CARD_H / 2;
    ringR = Math.max(ringR, Math.hypot(cx, cy));
  }
  ringR += 180;
  ringR = Math.max(ringR, (isolatedEngrams.length * (CARD_W + 24)) / (2 * Math.PI));
  const isolated: GraphNode[] = isolatedEngrams.map((e, i) => {
    const angle = (i / Math.max(1, isolatedEngrams.length)) * Math.PI * 2;
    const cx = Math.cos(angle) * ringR;
    const cy = Math.sin(angle) * ringR;
    return {
      id: e.id,
      label: nodeLabel(e),
      engramType: e.type,
      degree: 0,
      isolated: true,
      historyCount: historyById.get(e.id) ?? 0,
      review: e.review_due,
      position: { x: cx - CARD_W / 2, y: cy - CARD_H / 2 },
    };
  });

  return { nodes, isolated, edges: inEdges, externalCount, hiddenHistory };
}

export const RELATION_TYPES: readonly RelationType[] = [
  "supersedes", "supports", "contradicts", "derived_from", "refines", "related_to", "blocks", "part_of",
];

/**
 * Relation colours as concrete values, read from the --relation-* tokens of the element the graph
 * renders in (so the theme and the v2 scope apply). React Flow builds the arrow marker's id from
 * the colour, so a var() would not do here; read again when the theme changes.
 */
export function readRelationColors(el: Element): Record<RelationType, string> {
  const style = getComputedStyle(el);
  return Object.fromEntries(RELATION_TYPES.map((r) => [r, style.getPropertyValue(`--relation-${r}`).trim()])) as Record<RelationType, string>;
}
