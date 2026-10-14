import type { Engram } from "./types";
import { buildFacetGraph, type FacetGraph } from "./facet-graph";
import { hashColor } from "./tag-graph";

// v0.14: the "subjects" lens model — the shared facet-hub graph over
// `engram.subjects`. Structurally the tag lens; what differs is on the hubs
// (status ring, description, brain-wide member count), see SubjectHubNode.
export function buildSubjectGraph(engrams: Engram[]): FacetGraph {
  return buildFacetGraph(engrams, (e) => e.subjects, "subject");
}

/** Subjects are an open vocabulary — every subject gets a stable hashed hue. */
export function subjectColor(id: string): string {
  return hashColor(id);
}

/** Status colours shared by the lens hubs and the detail chips. */
export const SUBJECT_STATUS_COLOR = { active: "var(--subject-active)", closed: "var(--color-muted-foreground)" } as const;
