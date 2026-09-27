import { sql, type RawBuilder } from 'kysely';

/**
 * The few SQL functions that differ between SQLite and Postgres, for raw queries. The dialect is set when
 * the database is opened (one per process).
 */
export type Dialect = 'sqlite' | 'postgres';
let dialect: Dialect = 'sqlite';

export function setDialect(d: Dialect): void {
  dialect = d;
}
export function currentDialect(): Dialect {
  return dialect;
}

/** Element `i` of a JSON array stored as text (negative counts from the end). */
export function jsonAt(column: string, i: number): RawBuilder<string> {
  return dialect === 'postgres' ? sql<string>`((${sql.ref(column)})::jsonb->>${sql.lit(i)})` : sql<string>`json_extract(${sql.ref(column)}, ${sql.lit(i < 0 ? `$[#${i}]` : `$[${i}]`)})`;
}

/** The distinct values of an expression, joined with commas. */
export function concatDistinct(expr: RawBuilder<unknown>): RawBuilder<string | null> {
  return dialect === 'postgres' ? sql<string | null>`string_agg(DISTINCT ${expr}, ',')` : sql<string | null>`group_concat(DISTINCT ${expr})`;
}

/** 1 when a condition holds, else 0 (Postgres booleans aren't numbers). */
export function asInt(cond: RawBuilder<unknown>): RawBuilder<number> {
  return sql<number>`(CASE WHEN ${cond} THEN 1 ELSE 0 END)`;
}

/** The larger of a column and a value (SQLite's two-argument max, Postgres's GREATEST). */
export function greatest(column: string, value: number): RawBuilder<number> {
  return dialect === 'postgres' ? sql<number>`GREATEST(${sql.ref(column)}, ${value}::bigint)` : sql<number>`max(${sql.ref(column)}, ${value})`;
}
