import { createContext, useContext } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { TYPE_COLORS, withAlpha } from "@/components/ui/badge";
import { CARD_W } from "@/lib/graph";
import type { EngramType, SubjectStatus } from "@/lib/types";
import { SUBJECT_STATUS_COLOR } from "@/lib/subject-graph";

// Ported from packages/web/components/graph/nodes.tsx (CSS vars retargeted to the
// cockpit tokens; the tag-hub node for the tags lens included).

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
  const color = TYPE_COLORS[d.engramType] ?? "var(--color-muted-foreground)";
  const centerHandle = {
    top: "50%", left: "50%", transform: "translate(-50%, -50%)",
    opacity: 0, width: 1, height: 1, minWidth: 1, minHeight: 1, border: "none",
  } as const;

  return (
    <div
      style={{ width: CARD_W, opacity: dimmed ? 0.12 : d.isolated ? 0.6 : 1, transition: "opacity 120ms" }}
      title={d.label}
    >
      <Handle type="target" position={Position.Top} style={centerHandle} />
      <div
        style={{
          borderRadius: 6,
          borderLeft: `4px solid ${color}`,
          borderTop: "1px solid var(--color-border)",
          borderRight: "1px solid var(--color-border)",
          borderBottom: "1px solid var(--color-border)",
          background: "var(--color-card)",
          padding: "5px 8px",
          boxShadow: highlighted
            ? `0 0 0 2px ${color}, 0 2px 6px rgba(0,0,0,0.4)`
            : "0 1px 2px rgba(0,0,0,0.3)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
          <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase", color }}>
            {d.engramType}
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
            {d.review && (
              <span style={{ fontSize: 10, lineHeight: 1, color: "var(--color-review)" }} title="Flagged for review">⚑</span>
            )}
            {d.historyCount >= 1 && (
              <span style={{ fontSize: 9, color: "var(--color-muted-foreground)" }} title={`${d.historyCount} superseded version(s)`}>
                ⧗{d.historyCount}
              </span>
            )}
            {d.degree >= 2 && <span style={{ fontSize: 9, color: "var(--color-muted-foreground)" }}>·{d.degree}</span>}
          </span>
        </div>
        <div
          style={{
            fontSize: 11, lineHeight: 1.2, color: "var(--color-foreground)",
            display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
          }}
        >
          {d.label}
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} style={centerHandle} />
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
  const centerHandle = {
    top: "50%", left: "50%", transform: "translate(-50%, -50%)",
    opacity: 0, width: 1, height: 1, minWidth: 1, minHeight: 1, border: "none",
  } as const;

  return (
    <div
      style={{ opacity: dimmed ? 0.15 : 1, transition: "opacity 120ms" }}
      title={`#${d.tag} · ${d.memberCount} engram${d.memberCount === 1 ? "" : "s"}`}
    >
      <Handle type="target" position={Position.Top} style={centerHandle} />
      <div
        // Tinted pill like the type chips — no solid fill with white text.
        style={{
          display: "inline-flex", alignItems: "center", gap: 6, borderRadius: 999, padding: "5px 11px",
          background: withAlpha(d.color, 0.16), border: `1px solid ${withAlpha(d.color, 0.5)}`, color: d.color,
          fontSize: 12, fontWeight: 700, letterSpacing: "0.01em", whiteSpace: "nowrap",
          boxShadow: highlighted ? `0 0 0 3px ${withAlpha(d.color, 0.3)}, 0 2px 8px rgba(0,0,0,0.45)` : "0 1px 3px rgba(0,0,0,0.4)",
        }}
      >
        <span>#{d.tag}</span>
        <span style={{ fontSize: 10, fontWeight: 700, background: withAlpha(d.color, 0.22), borderRadius: 999, padding: "0 6px", lineHeight: "16px" }}>
          {d.memberCount}
        </span>
      </div>
      <Handle type="source" position={Position.Bottom} style={centerHandle} />
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
  const color = closed ? SUBJECT_STATUS_COLOR.closed : d.color;
  const ring = SUBJECT_STATUS_COLOR[d.status];
  const count = d.totalCount > d.memberCount ? `${d.memberCount}/${d.totalCount}` : String(d.memberCount);
  const centerHandle = {
    top: "50%", left: "50%", transform: "translate(-50%, -50%)",
    opacity: 0, width: 1, height: 1, minWidth: 1, minHeight: 1, border: "none",
  } as const;

  return (
    <div
      style={{ opacity: dimmed ? 0.15 : closed ? 0.4 : 1, transition: "opacity 120ms" }}
      title={
        `${d.name} · ${d.status}` +
        ` · ${d.memberCount} here${d.totalCount > d.memberCount ? `, ${d.totalCount} across the brain` : ""}` +
        (d.description ? `\n${d.description}` : "")
      }
    >
      <Handle type="target" position={Position.Top} style={centerHandle} />
      <div
        style={{
          display: "flex", flexDirection: "column", gap: 2, maxWidth: 220, borderRadius: 10, padding: "6px 11px",
          background: withAlpha(color, 0.14),
          border: closed ? `2px dashed ${withAlpha(ring, 0.7)}` : `2px solid ${ring}`,
          boxShadow: highlighted ? `0 0 0 3px ${withAlpha(color, 0.3)}, 0 2px 8px rgba(0,0,0,0.45)` : "0 1px 3px rgba(0,0,0,0.4)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6, color, fontSize: 12, fontWeight: 700, whiteSpace: "nowrap" }}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", textDecoration: closed ? "line-through" : "none" }}>{d.name}</span>
          <span style={{ fontSize: 10, fontWeight: 700, background: withAlpha(color, 0.22), borderRadius: 999, padding: "0 6px", lineHeight: "16px" }}>
            {count}
          </span>
        </div>
        {d.description && (
          <div
            style={{
              fontSize: 10, lineHeight: 1.25, color: "var(--color-muted-foreground)",
              display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
            }}
          >
            {d.description}
          </div>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} style={centerHandle} />
    </div>
  );
}

export const subjectNodeTypes = { engram: EngramNode, subjectHub: SubjectHubNode };
