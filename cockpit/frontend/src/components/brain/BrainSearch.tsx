// The search page of the brain surface. Data flow ported from
// packages/web/app/search/page.tsx: the query lives in the surface location
// (`{view:'search', q}`), results come from GET /list?search=…&limit=50,
// rows open the global drawer (paging within the result list). Refining the
// query replaces the location (no back-stack growth); "← Dashboard" returns
// to the dashboard — web relied on its sidebar Home link for that.
import { useState, type FormEvent } from "react";

import { useList } from "@/lib/queries";
import { EngramRow } from "@/components/engram-row";
import { Button, Input } from "@/shared/view/ui";
import { BackLink, useBrainNav } from "./BrainSurface";
import { EmptyNote, ListPanel } from "./ui";

export default function BrainSearch({ q }: { q: string }) {
  const { home, replace } = useBrainNav();
  const [input, setInput] = useState(q);
  const active = q.trim().length > 0;
  const results = useList({ search: q, limit: 50 }, active);
  const engrams = results.data?.engrams ?? [];
  const ids = engrams.map((e) => e.id);

  function submit(e: FormEvent) {
    e.preventDefault();
    const next = input.trim();
    if (next && next !== q) replace({ view: "search", q: next });
  }

  const count = results.data?.count ?? 0;
  const summary = !active
    ? "Type to search the whole brain."
    : results.isLoading
      ? "Searching…"
      : `${count} result${count === 1 ? "" : "s"} for “${q}”`;

  return (
    <div className="flex flex-col gap-4">
      <BackLink onClick={home}>← Dashboard</BackLink>

      <form onSubmit={submit} className="flex gap-2">
        <Input placeholder="Search the brain…" value={input} autoFocus onChange={(e) => setInput(e.target.value)} />
        <Button type="submit" variant="secondary" size="sm" className="h-9">Search</Button>
      </form>

      <ListPanel title="Results" action={<span className="text-caption text-muted-foreground">{summary}</span>}>
        {results.error ? (
          <EmptyNote>{(results.error as Error).message}</EmptyNote>
        ) : !active ? null : results.isLoading ? (
          <EmptyNote>Searching…</EmptyNote>
        ) : engrams.length === 0 ? (
          <EmptyNote>No matches for “{q}”.</EmptyNote>
        ) : (
          engrams.map((e) => <EngramRow key={e.id} engram={e} showScope siblings={ids} />)
        )}
      </ListPanel>
    </div>
  );
}
