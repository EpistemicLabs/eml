// CSV for the media viewer: parse (quotes, the delimiter guessed), sort and filter.

export interface Table {
  head: string[];
  rows: string[][];
  /** Per column: every filled cell is a number. */
  numeric: boolean[];
}

/** The delimiter a CSV file uses: tab, semicolon or comma, by what its first line holds most of. */
export function guessDelimiter(text: string, tsv: boolean): string {
  if (tsv) return '\t';
  const line = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'));
  const counts = ['\t', ';', ','].map((d) => [d, line.split(d).length - 1] as const);
  const best = counts.reduce((a, b) => (b[1] > a[1] ? b : a));
  return best[1] > 0 ? best[0] : ',';
}

/** RFC 4180 rows: quoted fields may hold the delimiter, line breaks and doubled quotes. */
export function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quoted) {
      if (ch === '"') {
        if (body[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && body[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += ch;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

/** A cell as a number when it reads as one (1,234.5 · 1.45 · -3 · 12%), else null. */
export function cellNumber(cell: string): number | null {
  const t = cell.trim().replace(/%$/, '').replace(/(\d),(?=\d{3}\b)/g, '$1');
  if (!t || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return null;
  return Number(t);
}

export function toTable(text: string, tsv: boolean): Table {
  const rows = parseCsv(text, guessDelimiter(text, tsv));
  const [head = [], ...body] = rows;
  const width = Math.max(head.length, ...body.map((r) => r.length));
  const fullHead = Array.from({ length: width }, (_, i) => head[i] ?? `Column ${i + 1}`);
  const numeric = fullHead.map((_, c) => {
    const filled = body.map((r) => r[c] ?? '').filter((v) => v.trim() !== '');
    return filled.length > 0 && filled.every((v) => cellNumber(v) !== null);
  });
  return { head: fullHead, rows: body, numeric };
}

export interface View {
  filter: string;
  sort: { column: number; dir: 1 | -1 } | null;
}

/** The rows that hold every word of the filter, sorted by the chosen column. */
export function viewRows(table: Table, view: View): string[][] {
  const words = view.filter.toLowerCase().split(/\s+/).filter(Boolean);
  let rows = words.length
    ? table.rows.filter((r) => { const line = r.join(' ').toLowerCase(); return words.every((w) => line.includes(w)); })
    : table.rows.slice();
  if (view.sort) {
    const { column, dir } = view.sort;
    const numeric = table.numeric[column];
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    rows = rows.sort((a, b) => {
      const x = a[column] ?? '';
      const y = b[column] ?? '';
      if (numeric) return ((cellNumber(x) ?? -Infinity) - (cellNumber(y) ?? -Infinity)) * dir;
      return collator.compare(x, y) * dir;
    });
  }
  return rows;
}

/** A header click: ascending, then descending, then back to the file's order. */
export function nextSort(current: View['sort'], column: number): View['sort'] {
  if (!current || current.column !== column) return { column, dir: 1 };
  return current.dir === 1 ? { column, dir: -1 } : null;
}
