// Ported from packages/web/lib/tag-graph.ts; generalized over the facet (v0.14).
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCollide,
  forceX,
  forceY,
  type SimulationNodeDatum,
} from "d3-force";
import { REVIEW_LABEL, type Engram, type EngramType } from "./types";
import { CARD_W, CARD_H } from "./graph";

// Pure facet-hub graph model (no React/xyflow) — shared by the "tags" lens and
// (v0.14) the "subjects" lens, which differ only in which facet ids an engram
// carries. Unlike the relations lens (engram→engram edges), the backbone here is
// HUB nodes: one hub per facet id present in the scope, each engram wired to the
// hubs of its ids. A d3-force sim then clusters engrams around shared hubs — so
// the project reads as clusters, WITHOUT inventing engram→engram edges. Scope is
// not a hub here: at project level every engram shares one scope, so that axis is
// constant. Engrams with no ids aren't forced into the cluster — they sit on a
// muted outer ring (shown on a toggle), mirroring the relations lens's isolated ring.

export interface FacetHubNode {
  id: string; // `<prefix>:<slug>`
  key: string; // the facet id (tag or subject slug)
  memberCount: number;
  /** Top-left position for xyflow (center − hub/2). */
  position: { x: number; y: number };
}

export interface FacetEngramNode {
  id: string;
  label: string;
  engramType: EngramType;
  /** How many of the scope's facet ids this engram carries (drives the ·N badge). */
  facetCount: number;
  /** Carries none — sits on the outer ring. */
  unassigned: boolean;
  /** Carries the `review` label — the nightly staleness flag (drives the ⚑). */
  review: boolean;
  position: { x: number; y: number };
}

export interface FacetEdge {
  id: string;
  source: string; // engram id
  target: string; // hub id
  key: string;
}

export interface FacetGraph {
  hubs: FacetHubNode[];
  /** Engrams carrying ≥1 id, force-laid-out around their hubs. */
  nodes: FacetEngramNode[];
  /** Engrams carrying none, on a deterministic outer ring. */
  unassigned: FacetEngramNode[];
  edges: FacetEdge[];
  unassignedCount: number;
}

// Hub footprint (nominal — drives collide spacing + the center→top-left offset).
export const HUB_W = 132;
export const HUB_H = 34;

function nodeLabel(e: Engram): string {
  if (e.title) return e.title;
  const line = e.content.split("\n").find((l) => l.trim()) ?? e.content;
  return line.slice(0, 48);
}

interface SimNode extends SimulationNodeDatum {
  id: string;
  isHub: boolean;
}

/**
 * @param facetsOf which ids an engram carries (tags, subjects)
 * @param prefix   hub node id prefix (`tag`, `subject`) — keeps hub ids apart from engram ids
 */
export function buildFacetGraph(
  engrams: Engram[],
  facetsOf: (e: Engram) => string[] | undefined,
  prefix: string,
): FacetGraph {
  const ids = (e: Engram) => facetsOf(e) ?? [];
  // Distinct ids present across the passed engrams → one hub each.
  const memberCount = new Map<string, number>();
  for (const e of engrams) {
    for (const t of ids(e)) {
      memberCount.set(t, (memberCount.get(t) ?? 0) + 1);
    }
  }
  const hubIds = [...memberCount.keys()].sort();

  const taggedEngrams = engrams.filter((e) => ids(e).length > 0);
  const untaggedEngrams = engrams.filter((e) => ids(e).length === 0);

  // Edges: engram → each of its hubs.
  const edges: FacetEdge[] = [];
  for (const e of taggedEngrams) {
    for (const t of ids(e)) {
      if (!memberCount.has(t)) continue;
      edges.push({
        id: `${prefix}e-${e.id}-${t}`,
        source: e.id,
        target: `${prefix}:${t}`,
        key: t,
      });
    }
  }

  // --- Force layout over engram + hub nodes (hub-and-spoke) ---
  const simNodes: SimNode[] = [
    ...hubIds.map((t) => ({ id: `${prefix}:${t}`, isHub: true })),
    ...taggedEngrams.map((e) => ({ id: e.id, isHub: false })),
  ];
  const simLinks = edges.map((e) => ({ source: e.source, target: e.target }));
  const engramR = Math.hypot(CARD_W, CARD_H) / 2 + 8;
  const hubR = Math.hypot(HUB_W, HUB_H) / 2 + 30;

  const sim = forceSimulation(simNodes)
    .force(
      "link",
      forceLink(simLinks)
        .id((d) => (d as SimNode).id)
        .distance(120)
        .strength(0.75),
    )
    // Hubs repel harder so distinct subjects spread into separate clusters.
    .force(
      "charge",
      forceManyBody<SimNode>().strength((d) => (d.isHub ? -1400 : -500)),
    )
    .force(
      "collide",
      forceCollide<SimNode>().radius((d) => (d.isHub ? hubR : engramR)),
    )
    .force("x", forceX(0).strength(0.05))
    .force("y", forceY(0).strength(0.05))
    .stop();
  // Run to a stable state synchronously (d3's default init is deterministic).
  for (let i = 0; i < 320; i++) sim.tick();

  const posById = new Map(simNodes.map((n) => [n.id, n]));

  const hubs: FacetHubNode[] = hubIds.map((t) => {
    const p = posById.get(`${prefix}:${t}`)!;
    return {
      id: `${prefix}:${t}`,
      key: t,
      memberCount: memberCount.get(t) ?? 0,
      position: { x: (p.x ?? 0) - HUB_W / 2, y: (p.y ?? 0) - HUB_H / 2 },
    };
  });

  const nodes: FacetEngramNode[] = taggedEngrams.map((e) => {
    const p = posById.get(e.id)!;
    return {
      id: e.id,
      label: nodeLabel(e),
      engramType: e.type,
      facetCount: ids(e).length,
      unassigned: false,
      review: e.labels?.includes(REVIEW_LABEL) ?? false,
      position: { x: (p.x ?? 0) - CARD_W / 2, y: (p.y ?? 0) - CARD_H / 2 },
    };
  });

  // --- Unassigned engrams on a deterministic outer ring ---
  let ringR = 0;
  for (const n of [...nodes, ...hubs]) {
    const cx = n.position.x + CARD_W / 2;
    const cy = n.position.y + CARD_H / 2;
    ringR = Math.max(ringR, Math.hypot(cx, cy));
  }
  ringR += 200; // gap between the cluster and the ring
  ringR = Math.max(
    ringR,
    (untaggedEngrams.length * (CARD_W + 24)) / (2 * Math.PI),
  );
  const unassigned: FacetEngramNode[] = untaggedEngrams.map((e, i) => {
    const angle = (i / Math.max(1, untaggedEngrams.length)) * Math.PI * 2;
    return {
      id: e.id,
      label: nodeLabel(e),
      engramType: e.type,
      facetCount: 0,
      unassigned: true,
      review: e.labels?.includes(REVIEW_LABEL) ?? false,
      position: {
        x: Math.cos(angle) * ringR - CARD_W / 2,
        y: Math.sin(angle) * ringR - CARD_H / 2,
      },
    };
  });

  return { hubs, nodes, unassigned, edges, unassignedCount: untaggedEngrams.length };
}
