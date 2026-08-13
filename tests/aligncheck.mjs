#!/usr/bin/env node
// Does the app ask the database for things the database has?
//
// Every screen talks to Supabase over PostgREST, which resolves table names,
// column names, function names and argument names at request time. TypeScript
// sees none of it: a column removed from supabase_schema.sql leaves a `.select`
// in a page compiling perfectly and failing the moment a user opens the screen.
// The UI stub in uitest.mjs does not catch it either, because a stub answers
// whatever it is asked.
//
// So this reads the real schema into a real Postgres, asks it what exists, and
// holds every call site in src/ up against the answer.
//
//   node tests/aligncheck.mjs
//
// Needs the local Postgres described in tests/README.md.

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const PSQL = '/usr/lib/postgresql/16/bin/psql';
const DB = `align${process.pid}`;

const psql = (db, sql) =>
  execFileSync(PSQL, ['-h', '/var/run/postgresql', '-U', 'postgres', '-d', db, '-At', '-c', sql], {
    encoding: 'utf8',
  }).trim();

const psqlFile = (db, file) =>
  execFileSync(PSQL, ['-h', '/var/run/postgresql', '-U', 'postgres', '-d', db, '-q', '-f', file], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

// ---------------------------------------------------------------- the schema

console.log('loading supabase_schema.sql into a scratch database…');
psql('postgres', `CREATE DATABASE ${DB}`);
let introspect;
try {
  psqlFile(DB, '/home/pgtest/prelude.sql');
  // Supabase provisions this; the schema only adds tables to it.
  psql(DB, 'CREATE PUBLICATION supabase_realtime');
  psqlFile(DB, join(ROOT, 'supabase_schema.sql'));

  const rows = (sql) => psql(DB, sql).split('\n').filter(Boolean);

  introspect = {
    columns: new Map(), // table -> Set(column)
    functions: new Map(), // name -> Set(argument name)
    constraints: new Set(),
    published: new Set(),
    granted: new Set(),
  };

  for (const line of rows(
    `SELECT table_name || '|' || column_name FROM information_schema.columns
     WHERE table_schema = 'public'`
  )) {
    const [t, c] = line.split('|');
    if (!introspect.columns.has(t)) introspect.columns.set(t, new Set());
    introspect.columns.get(t).add(c);
  }

  for (const line of rows(
    `SELECT p.proname || '|' || COALESCE(array_to_string(p.proargnames, ','), '')
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'`
  )) {
    const [name, args] = line.split('|');
    if (!introspect.functions.has(name)) introspect.functions.set(name, new Set());
    for (const a of (args || '').split(',').filter(Boolean)) {
      introspect.functions.get(name).add(a.replace(/^p_/, ''));
      introspect.functions.get(name).add(a);
    }
  }

  for (const c of rows(`SELECT conname FROM pg_constraint`)) introspect.constraints.add(c);

  for (const t of rows(
    `SELECT tablename FROM pg_publication_tables WHERE pubname = 'supabase_realtime'`
  ))
    introspect.published.add(t);

  for (const g of rows(
    `SELECT DISTINCT p.proname FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname='public'
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')`
  ))
    introspect.granted.add(g);
} finally {
  try {
    psql('postgres', `DROP DATABASE IF EXISTS ${DB}`);
  } catch {
    /* the scratch database is disposable */
  }
}

const { columns, functions, constraints, published, granted } = introspect;

// ------------------------------------------------------------- the call sites

const sources = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(ts|tsx)$/.test(path)) sources.push(path);
  }
})(join(ROOT, 'src'));

const problems = [];
const counts = { tables: 0, columns: 0, rpcs: 0, embeds: 0, realtime: 0 };

// PostgREST select lists nest: `id, user:users!fk(name)`. Split on the commas
// that are not inside parentheses, so an embed is one entry rather than several.
function splitTop(list) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of list) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

// The keys of the outermost object literal, ignoring anything nested inside a
// value. `{ p_splits: [{ user_id: … }] }` passes one argument, not two.
function topLevelKeys(block) {
  const keys = [];
  let depth = 0;
  for (let i = 0; i < block.length; i++) {
    const ch = block[i];
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') {
      depth--;
      if (depth === 0) break;
    } else if (depth === 1) {
      const rest = block.slice(i).match(/^([a-z_][\w]*)\s*:/);
      if (rest && /[{,\s]/.test(block[i - 1] ?? '{')) {
        keys.push(rest[1]);
        i += rest[0].length - 1;
      }
    }
  }
  return keys;
}

function checkSelect(file, table, list) {
  for (const entry of splitTop(list)) {
    if (entry === '*') continue;

    // An embed: `alias:other_table!constraint(cols)` or `other_table(cols)`.
    const embed = entry.match(/^(?:([\w]+):)?([\w]+)(?:!([\w]+))?\s*\(([\s\S]*)\)$/);
    if (embed) {
      const [, , target, hint, inner] = embed;
      counts.embeds++;
      // !inner / !left are join modifiers, not constraint names.
      if (hint && hint !== 'inner' && hint !== 'left' && !constraints.has(hint))
        problems.push(`${file}: embed hint "${hint}" is not a constraint in the schema`);
      // Two foreign keys into the same table need a hint or PostgREST refuses.
      if (!hint && columns.has(target)) {
        const fks = psqlCacheFks(table, target);
        if (fks > 1)
          problems.push(
            `${file}: ${table} -> ${target} is ambiguous (${fks} foreign keys) and has no !constraint hint`
          );
      }
      if (columns.has(target)) checkSelect(file, target, inner);
      continue;
    }

    // A plain column, possibly aliased or cast: `alias:column::text`.
    const col = entry.replace(/^\w+:/, '').split('::')[0].trim();
    if (!col || col.includes('(')) continue;
    counts.columns++;
    const cols = columns.get(table);
    if (cols && !cols.has(col))
      problems.push(`${file}: ${table} has no column "${col}"`);
  }
}

// Foreign-key counts between two tables, resolved once each.
const fkCache = new Map();
let fkRows = null;
function psqlCacheFks(from, to) {
  if (!fkRows) {
    fkRows = [];
    // Re-derive from the constraint names already collected: cheaper than a
    // second database. Names follow <table>_<column>_fkey by convention, and
    // the schema keeps that convention throughout.
    for (const name of constraints) {
      const m = name.match(/^(.+)_(.+)_fkey$/);
      if (m) fkRows.push({ table: m[1], column: m[2] });
    }
  }
  const key = `${from}->${to}`;
  if (fkCache.has(key)) return fkCache.get(key);
  // A column named <singular-of-target>_id, or any column whose fkey name
  // mentions the target, counts as a link.
  const singular = to.replace(/s$/, '');
  const n = fkRows.filter(
    (r) => r.table === from && (r.column === `${singular}_id` || r.column.endsWith(`_${singular}`))
  ).length;
  fkCache.set(key, n);
  return n;
}

for (const path of sources) {
  const file = relative(ROOT, path);
  const src = readFileSync(path, 'utf8');

  // .from('table') … .select('…'). The tail stops at the next .from( so one
  // query's filters are never read as another's.
  for (const m of src.matchAll(/\.from\(\s*'([\w]+)'\s*\)([\s\S]*?)(?=\.from\(|$)/g)) {
    const table = m[1];
    counts.tables++;
    if (!columns.has(table)) {
      problems.push(`${file}: .from("${table}") — no such table in the schema`);
      continue;
    }
    const tail = m[2].slice(0, 900);
    const sel = tail.match(/\.select\(\s*(?:'([^']*)'|`([^`]*)`)/);
    if (sel) checkSelect(file, table, (sel[1] ?? sel[2]).replace(/\s+/g, ' '));

    // Column filters and ordering resolve server-side too.
    for (const f of tail.matchAll(
      /\.(?:eq|neq|gt|gte|lt|lte|like|ilike|is|in|contains|order)\(\s*'([\w.]+)'/g
    )) {
      const ref = f[1];
      if (ref.includes('.')) continue; // embedded-table filter, checked by its own select
      counts.columns++;
      if (!columns.get(table).has(ref))
        problems.push(`${file}: ${table} has no column "${ref}" (filter or order)`);
    }
  }

  // .rpc('name', { arg: … }) — only the outermost keys are arguments; anything
  // nested is part of a JSON payload the function parses itself.
  for (const m of src.matchAll(/\.rpc\(\s*'([\w]+)'\s*(?:,\s*(\{[\s\S]{0,800}))?/g)) {
    const [, name, argBlock] = m;
    counts.rpcs++;
    if (!functions.has(name)) {
      problems.push(`${file}: .rpc("${name}") — no such function in the schema`);
      continue;
    }
    if (!granted.has(name))
      problems.push(`${file}: .rpc("${name}") — defined but not granted to authenticated`);
    for (const arg of topLevelKeys(argBlock || ''))
      if (!functions.get(name).has(arg))
        problems.push(`${file}: .rpc("${name}") passes "${arg}", which it does not accept`);
  }

  // Realtime subscriptions need the table in the publication, or the screen
  // silently never updates and people refresh by hand.
  for (const m of src.matchAll(/useLiveRefresh\(\s*[^,]+,\s*\[([^\]]*)\]/g)) {
    for (const t of m[1].matchAll(/'([\w]+)'/g)) {
      counts.realtime++;
      if (!columns.has(t[1]))
        problems.push(`${file}: subscribes to "${t[1]}", which is not a table`);
      else if (!published.has(t[1]))
        problems.push(
          `${file}: subscribes to "${t[1]}", which is not in the realtime publication`
        );
    }
  }
}

// ------------------------------------------------------------------- verdict

console.log(
  `checked ${counts.tables} table refs, ${counts.columns} column refs, ` +
    `${counts.rpcs} rpc calls, ${counts.embeds} embeds, ${counts.realtime} realtime subscriptions`
);

if (problems.length === 0) {
  console.log('\nSCREENS AND SCHEMA AGREE');
  process.exit(0);
}

console.log(`\n${problems.length} MISMATCH${problems.length === 1 ? '' : 'ES'}:`);
for (const p of problems) console.log(`  - ${p}`);
process.exit(1);
