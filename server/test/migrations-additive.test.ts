import { describe, expect, it } from 'vitest';
import { migrations } from '../src/db/migrations.js';

/**
 * Rolling upgrades: while servers are replaced one at a time, the old version runs on the database the new one has
 * already upgraded. So a migration may only add (tables, columns with a default or nullable, indexes): never drop,
 * rename or retype what an earlier version still reads. Removing something takes two releases: stop using it in one,
 * drop it in a later one, named "… (contract)" so it's a deliberate choice.
 */
const FIRST_CHECKED = 43; // the rule applies from here on; earlier migrations shipped before it
const SUBTRACTIVE = [/\bDROP\s+(TABLE|COLUMN)\b/i, /\bRENAME\s+(COLUMN|TO)\b/i, /\bALTER\s+COLUMN\b[^;]*\b(TYPE|SET\s+NOT\s+NULL)\b/i, /\bADD\s+COLUMN\b[^;,]*\bNOT\s+NULL\b(?![^;,]*\bDEFAULT\b)/i];

describe('migrations only add (rolling upgrades)', () => {
  it('nothing from this version on drops, renames or retypes, unless marked "(contract)"', () => {
    const bad = migrations
      .filter((m) => m.version >= FIRST_CHECKED && !/\(contract\)/.test(m.name))
      .flatMap((m) => [m.sqlite, m.postgres ?? ''].flatMap((sql) => SUBTRACTIVE.filter((re) => re.test(sql)).map((re) => `${m.version} ${m.name}: ${re}`)));
    expect(bad).toEqual([]);
  });
  it('the rule catches what it should', () => {
    for (const sql of ['ALTER TABLE x DROP COLUMN y', 'DROP TABLE x', 'ALTER TABLE x RENAME COLUMN a TO b', 'ALTER TABLE x ADD COLUMN y TEXT NOT NULL']) expect(SUBTRACTIVE.some((re) => re.test(sql))).toBe(true);
    for (const sql of ['ALTER TABLE x ADD COLUMN y TEXT', "ALTER TABLE x ADD COLUMN y TEXT NOT NULL DEFAULT ''", 'CREATE TABLE IF NOT EXISTS x (id TEXT PRIMARY KEY)', 'CREATE INDEX i ON x (y)']) expect(SUBTRACTIVE.some((re) => re.test(sql))).toBe(false);
  });
});
