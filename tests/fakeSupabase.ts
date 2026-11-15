/**
 * Minimal in-memory stand-in for the Supabase JS query builder.
 *
 * Only the subset used by src/lib/tournamentEngine.ts is implemented.
 * Every awaited query yields to the event loop first (like a real network
 * round-trip), so two concurrent engine calls interleave exactly the way two
 * clicks / two jury devices would against the real database.
 *
 * Optional unique indexes emulate PostgreSQL unique constraints: a multi-row
 * insert is atomic (all rows or none), like a single INSERT statement.
 */

type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;

export interface FakeDbOptions {
  /** table -> list of functions computing a unique key for a row */
  uniqueIndexes?: Record<string, Array<(row: Row) => string>>;
  /** milliseconds of fake latency per query (0 = just yield a tick) */
  latencyMs?: number;
}

let idCounter = 0;
const newId = () => `id-${++idCounter}`;

export class FakeDb {
  tables: Record<string, Row[]> = {};
  queryLog: string[] = [];
  constructor(private opts: FakeDbOptions = {}) {}

  table(name: string): Row[] {
    if (!this.tables[name]) this.tables[name] = [];
    return this.tables[name];
  }

  seed(name: string, rows: Row[]) {
    this.table(name).push(...rows.map((r) => ({ id: newId(), ...r })));
  }

  async tick() {
    const ms = this.opts.latencyMs ?? 0;
    await new Promise((r) => setTimeout(r, ms));
  }

  checkUnique(name: string, candidate: Row[], ignoreIds: Set<unknown> = new Set()) {
    const idx = this.opts.uniqueIndexes?.[name];
    if (!idx) return null;
    for (const keyFn of idx) {
      const seen = new Set(
        this.table(name)
          .filter((r) => !ignoreIds.has(r.id))
          .map(keyFn)
      );
      for (const row of candidate) {
        const k = keyFn(row);
        if (seen.has(k)) {
          return { message: `duplicate key value violates unique constraint (${k})`, code: '23505' };
        }
        seen.add(k);
      }
    }
    return null;
  }

  from(name: string) {
    return new QueryBuilder(this, name);
  }
}

class QueryBuilder implements PromiseLike<{ data: unknown; error: unknown }> {
  private op: 'select' | 'insert' | 'update' | 'delete' = 'select';
  private filters: Filter[] = [];
  private payload: Row | Row[] | null = null;
  private returning = false;
  private mode: 'many' | 'single' | 'maybeSingle' = 'many';
  private orders: Array<{ col: string; asc: boolean }> = [];

  constructor(private db: FakeDb, private name: string) {}

  select(_cols?: string) {
    if (this.op === 'select') this.op = 'select';
    else this.returning = true;
    return this;
  }
  insert(rows: Row | Row[]) {
    this.op = 'insert';
    this.payload = rows;
    return this;
  }
  update(patch: Row) {
    this.op = 'update';
    this.payload = patch;
    return this;
  }
  delete() {
    this.op = 'delete';
    return this;
  }
  eq(col: string, val: unknown) {
    this.filters.push((r) => r[col] === val);
    return this;
  }
  neq(col: string, val: unknown) {
    this.filters.push((r) => r[col] !== val);
    return this;
  }
  in(col: string, vals: unknown[]) {
    this.filters.push((r) => vals.includes(r[col]));
    return this;
  }
  is(col: string, val: unknown) {
    this.filters.push((r) => (r[col] ?? null) === val);
    return this;
  }
  order(col: string, o?: { ascending?: boolean }) {
    this.orders.push({ col, asc: o?.ascending !== false });
    return this;
  }
  single() {
    this.mode = 'single';
    return this;
  }
  maybeSingle() {
    this.mode = 'maybeSingle';
    return this;
  }

  private shape(rows: Row[]) {
    const copy = rows.map((r) => ({ ...r }));
    if (this.mode === 'many') return { data: copy, error: null };
    if (copy.length === 1) return { data: copy[0], error: null };
    if (copy.length === 0 && this.mode === 'maybeSingle') return { data: null, error: null };
    return { data: null, error: { message: `expected single row, got ${copy.length}` } };
  }

  private async execute() {
    await this.db.tick();
    const table = this.db.table(this.name);
    const match = (r: Row) => this.filters.every((f) => f(r));
    this.db.queryLog.push(`${this.op} ${this.name}`);

    if (this.op === 'select') {
      let rows = table.filter(match);
      for (const o of [...this.orders].reverse()) {
        rows = [...rows].sort((a, b) => {
          const av = a[o.col] as number;
          const bv = b[o.col] as number;
          if (av === bv) return 0;
          if (av === null || av === undefined) return 1;
          if (bv === null || bv === undefined) return -1;
          return (av < bv ? -1 : 1) * (o.asc ? 1 : -1);
        });
      }
      return this.shape(rows);
    }

    if (this.op === 'insert') {
      const list = (Array.isArray(this.payload) ? this.payload : [this.payload!]).map((r) => ({
        id: newId(),
        ...r,
      }));
      const err = this.db.checkUnique(this.name, list);
      if (err) return { data: null, error: err };
      table.push(...list);
      if (!this.returning) return { data: null, error: null };
      return this.shape(list);
    }

    if (this.op === 'update') {
      const targets = table.filter(match);
      const patched = targets.map((r) => ({ ...r, ...(this.payload as Row) }));
      const err = this.db.checkUnique(this.name, patched, new Set(targets.map((t) => t.id)));
      if (err) return { data: null, error: err };
      targets.forEach((r) => Object.assign(r, this.payload));
      return this.returning ? this.shape(targets) : { data: null, error: null };
    }

    // delete
    const keep = table.filter((r) => !match(r));
    const removed = table.filter(match);
    this.db.tables[this.name] = keep;
    return this.returning ? this.shape(removed) : { data: null, error: null };
  }

  then<T1 = { data: unknown; error: unknown }, T2 = never>(
    onfulfilled?: ((value: { data: unknown; error: unknown }) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null
  ): PromiseLike<T1 | T2> {
    return this.execute().then(onfulfilled, onrejected);
  }
}
