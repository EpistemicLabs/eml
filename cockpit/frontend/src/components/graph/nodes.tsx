import { createContext, useContext } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { CARD_W } from "@/lib/graph";
import type { EngramType, SubjectStatus } from "@/lib/types";
import { SUBJECT_STATUS_COLOR } from "@/lib/subject-graph";
import { cn } from "@/lib/utils";
import { typeColor } from "@/shared/view/ui/EngramType";

/** Edges start and end in the middle of a node: its handles sit there, invisible and point-sized. */
const CENTER_HANDLE = "!top-1/2 !left-1/2 !size-px !min-h-0 !min-w-0 !-translate-x-1/2 !-translate-y-1/2 !border-0 !opacity-0";
/** The floating legend in a graph's corner. */
export const GRAPH_PANEL = "glass rounded-lg px-3 py-2 text-ui shadow-overlay";
/** Edges: a thin line at a low, token-set opacity, so the nodes stay in front. */
export const edgeStyle = (stroke: string, faint = false) => ({ stroke, strokeWidth: "var(--width-graph-line)", opacity: faint ? "var(--opacity-graph-edge-faint)" : "var(--opacity-graph-edge)" });
/** Nodes fade (not blink) as the hover moves across the graph. */
const FADE = "transition-opacity duration-(--duration-fast)";

// The graph's nodes in tokens v2 (the tag-hub and subject-hub nodes for their lenses included).

export interface EngramNodeData {
  label: string;
  engramType: EngramType;
  degree: number;
  isolated: boolean;
  historyCount: number;
  review?: boolean;
  [key: string]: unknown;
}

export interface HoverState {
  hovered: string | null;
  neighbors: Set<string> | null;
}
export const HoverContext = createContext<HoverState>({
  hovered: null,
  neighbors: null,
});

export function EngramNode({ id, data }: NodeProps) {
  const d = data as EngramNodeData;
  const { neighbors } = useContext(HoverContext);
  const dimmed = neighbors ? !neighbors.has(id) : false;
  const highlighted = neighbors?.has(id) === true;
  const color = typeColor(d.engramType);

  return (
    <div
      // Width from the layout model (CARD_W), so nodes and the force layout agree.
      style={{ width: CARD_W }}
      className={cn(FADE, dimmed ? "opacity-(--opacity-graph-dim)" : d.isolated && "opacity-(--opacity-graph-isolated)")}
      title={d.label}
    >
      <Handle type="target" position={Position.Top} className={CENTER_HANDLE} />
      {/* The type's hue is the node's edge (a graph node may carry it); the text stays monochrome. */}
      <div
        className={cn(
          "rounded-md border border-l-(length:--width-graph-edge) border-border bg-card px-2 py-1",
          highlighted ? "shadow-overlay ring-2 ring-foreground" : "shadow-card",
        )}
        style={{ borderLeftColor: color }}
      >
        <div className="flex items-center justify-between gap-1.5">
          <span className="text-caption leading-none font-semibold tracking-label text-muted-foreground uppercase">{d.engramType}</span>
          <span className="flex items-center gap-1 text-caption leading-none text-muted-foreground">
            {d.review && <span className="text-you-ink" title="Flagged for review">⚑</span>}
            {d.historyCount >= 1 && <span title={`${d.historyCount} superseded version(s)`}>⧗{d.historyCount}</span>}
            {d.degree >= 2 && <span>·{d.degree}</span>}
          </span>
        </div>
        <div className="mt-0.5 line-clamp-2 text-caption text-foreground">{d.label}</div>
      </div>
      <Handle type="source" position={Position.Bottom} className={CENTER_HANDLE} />
    </div>
  );
}

export const nodeTypes = { engram: EngramNode };

// --- Tag lens ---

export interface TagHubNodeData {
  tag: string;
  color: string;
  memberCount: number;
  [key: string]: unknown;
}

// Backbone hub for the tags lens: a colored pill labelled by the tag, with its
// member count. Reads the same HoverContext as EngramNode (dim non-neighbors,
// ring on highlight) so the whole lens shares one flicker-free hover model. Two
// invisible center handles so edges render pill-center → card-center.
export function TagHubNode({ id, data }: NodeProps) {
  const d = data as TagHubNodeData;
  const { neighbors } = useContext(HoverContext);
  const dimmed = neighbors ? !neighbors.has(id) : false;
  const highlighted = neighbors?.has(id) === true;

  return (
    <div
      className={cn(FADE, dimmed && "opacity-(--opacity-graph-hub-dim)")}
      title={`#${d.tag} · ${d.memberCount} engram${d.memberCount === 1 ? "" : "s"}`}
    >
      <Handle type="target" position={Position.Top} className={CENTER_HANDLE} />
      {/* A monochrome pill; the tag's own hue is only its dot. */}
      <div
        className={cn(
          "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-border-strong bg-card px-3 py-1 text-ui font-bold text-foreground",
          highlighted ? "shadow-overlay ring-2 ring-foreground" : "shadow-card",
        )}
      >
        <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: d.color }} />
        <span>#{d.tag}</span>
        <span className="rounded-full bg-muted px-1.5 text-caption font-bold">{d.memberCount}</span>
      </div>
      <Handle type="source" position={Position.Bottom} className={CENTER_HANDLE} />
    </div>
  );
}

export const tagNodeTypes = { engram: EngramNode, tagHub: TagHubNode };

// --- Subject lens (v0.14) ---

export interface SubjectHubNodeData {
  name: string;
  description: string | null;
  status: SubjectStatus;
  color: string;
  /** Members in this view (the project). */
  memberCount: number;
  /** Members across the whole brain — subjects are cross-scope. */
  totalCount: number;
  [key: string]: unknown;
}

// Backbone hub for the subjects lens. Same hover model as TagHubNode, but the
// lifecycle is what must read at a glance (spec §B.4): a status ring (active =
// full ring in the status green; closed = dashed grey, name struck through, the
// whole hub muted) and the description under the name. The count shows
// "here/total" when the strand reaches beyond this project.
export function SubjectHubNode({ id, data }: NodeProps) {
  const d = data as SubjectHubNodeData;
  const { neighbors } = useContext(HoverContext);
  const dimmed = neighbors ? !neighbors.has(id) : false;
  const highlighted = neighbors?.has(id) === true;
  const closed = d.status === "closed";
  const count = d.totalCount > d.memberCount ? `${d.memberCount}/${d.totalCount}` : String(d.memberCount);

  return (
    <div
      className={cn(FADE, dimmed ? "opacity-(--opacity-graph-hub-dim)" : closed && "opacity-(--opacity-graph-closed)")}
      title={
        `${d.name} · ${d.status}` +
        ` · ${d.memberCount} here${d.totalCount > d.memberCount ? `, ${d.totalCount} across the brain` : ""}` +
        (d.description ? `\n${d.description}` : "")
      }
    >
      <Handle type="target" position={Position.Top} className={CENTER_HANDLE} />
      {/* The lifecycle reads at a glance: active = solid ring in the text colour, closed = dashed
          grey ring with the name struck through. The subject's hue is only its dot. */}
      <div
        className={cn(
          "flex max-w-(--size-graph-hub) flex-col gap-0.5 rounded-lg border-2 bg-card px-3 py-1.5",
          closed ? "border-dashed border-border-strong" : "border-foreground",
          highlighted ? "shadow-overlay ring-2 ring-foreground" : "shadow-card",
        )}
      >
        <div className="flex items-center gap-1.5 whitespace-nowrap text-ui font-bold text-foreground">
          <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: closed ? SUBJECT_STATUS_COLOR.closed : d.color }} />
          <span className={cn("truncate", closed && "line-through")}>{d.name}</span>
          <span className="rounded-full bg-muted px-1.5 text-caption font-bold">{count}</span>
        </div>
        {d.description && <div className="line-clamp-2 text-caption text-muted-foreground">{d.description}</div>}
      </div>
      <Handle type="source" position={Position.Bottom} className={CENTER_HANDLE} />
    </div>
  );
}

export const subjectNodeTypes = { engram: EngramNode, subjectHub: SubjectHubNode };
