import type { Engram } from "./types";
import { buildFacetGraph, type FacetGraph } from "./facet-graph";

// The "tags" lens model: the shared facet-hub graph over `engram.tags`
// (ported from packages/web/lib/tag-graph.ts; builder moved to ./facet-graph).
export function buildTagGraph(engrams: Engram[]): FacetGraph {
  return buildFacetGraph(engrams, (e) => e.tags, "tag");
}

// Stable color per tag: a deterministic hue from the tag id, so every tag keeps
// its color without a hardcoded vocabulary.
export function tagColor(tag: string): string {
  return hashColor(tag);
}

/**
 * Deterministic muted hue per id — the palette for tags and subjects. The
 * lightness is a CSS variable (index.css), so the hue reads on both themes.
 */
export function hashColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return `hsl(${h} 45% var(--hash-lightness))`;
}
