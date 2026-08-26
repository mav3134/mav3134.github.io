#!/usr/bin/env node
/**
 * Daily draft-room rankings refresh.
 *
 * Pulls FantasyPros consensus draft rankings (half PPR) and rewrites the rank
 * column of DRAFT_DB in index.html, re-sorting the table into ranking order.
 *
 * Projections (points and the per-stat columns) are NOT touched — those are
 * curated separately. Only the ranking/order changes, plus newly ranked players
 * getting added so they are draftable.
 *
 * The API key comes from the FANTASYPROS_API_KEY env var (a repo secret). It is
 * never written to disk: this repo is public.
 *
 *   node scripts/update-draft-rankings.mjs            # update index.html
 *   DRY_RUN=1 node scripts/update-draft-rankings.mjs  # report only
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = path.join(ROOT, 'index.html');
const KEY = process.env.FANTASYPROS_API_KEY;
const DRY = !!process.env.DRY_RUN;
/** Ranked players missing from the table are added if inside this rank. */
const ADD_THROUGH_RANK = 300;

if (!KEY) {
  console.error('FANTASYPROS_API_KEY is not set. Add it as a repository secret.');
  process.exit(1);
}

/* ── season: the NFL season a draft in this calendar month belongs to ── */
const now = new Date();
const season = Number(process.env.SEASON) ||
  (now.getUTCMonth() >= 1 ? now.getUTCFullYear() : now.getUTCFullYear() - 1);

const ENDPOINTS = [
  `https://api.fantasypros.com/public/v2/json/nfl/${season}/consensus-rankings?type=draft&scoring=HALF&position=ALL&week=0`,
  `https://api.fantasypros.com/public/v2/json/nfl/${season}/consensus-rankings?type=draft&scoring=HALF&position=ALL`,
];

const norm = (s) => String(s ?? '')
  .toLowerCase()
  .replace(/\b(jr|sr|ii|iii|iv|v)\.?$/g, '')
  .replace(/[^a-z]/g, '');

const num = (v) => {
  const n = Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

async function fetchRankings() {
  const errors = [];
  for (const url of ENDPOINTS) {
    let res;
    try {
      res = await fetch(url, { headers: { 'x-api-key': KEY, accept: 'application/json' } });
    } catch (e) {
      errors.push(`${url} -> network error: ${e.message}`);
      continue;
    }
    const body = await res.text();
    if (!res.ok) {
      errors.push(`${url} -> HTTP ${res.status}: ${body.slice(0, 300)}`);
      continue;
    }
    let json;
    try {
      json = JSON.parse(body);
    } catch {
      errors.push(`${url} -> not JSON: ${body.slice(0, 300)}`);
      continue;
    }
    const players = json.players ?? json.data ?? (Array.isArray(json) ? json : null);
    if (!Array.isArray(players) || players.length === 0) {
      errors.push(`${url} -> no players array. Top-level keys: ${Object.keys(json).join(', ')}`);
      continue;
    }
    console.log(`Rankings source: ${url.replace(/(x-api-key=)[^&]*/, '$1***')}`);
    return players;
  }
  throw new Error('Could not fetch rankings.\n  ' + errors.join('\n  '));
}

/* ── read the current table ── */
const html = fs.readFileSync(HTML, 'utf8');
const block = /var DRAFT_DB=\[\n([\s\S]*?)\n\];/.exec(html);
if (!block) throw new Error('DRAFT_DB block not found in index.html');
const rows = block[1]
  .split('\n')
  .map((l) => l.trim().replace(/,$/, ''))
  .filter(Boolean)
  .map((l) => JSON.parse(l));
if (rows.some((r) => r.length !== 14)) throw new Error('DRAFT_DB row with unexpected column count');
console.log(`Current table: ${rows.length} players`);

// team abbreviation -> the exact defense name this site uses ("Texans DEF")
const defByTeam = new Map(rows.filter((r) => r[3] === 'DEF').map((r) => [r[2], r[1]]));

const rankings = await fetchRankings();
console.log(`API returned ${rankings.length} ranked players`);

/* ── normalize the API payload ── */
const parsed = [];
for (const p of rankings) {
  const rank = num(p.rank_ecr ?? p.rank ?? p.rank_ave ?? p.ecr);
  if (!rank) continue;
  let pos = String(p.player_position_id ?? p.position_id ?? p.pos ?? '').toUpperCase();
  const team = String(p.player_team_id ?? p.team_id ?? p.team ?? '').toUpperCase();
  let name = String(p.player_name ?? p.name ?? '').trim();
  if (pos === 'DST' || pos === 'D/ST' || pos === 'DEF') {
    pos = 'DEF';
    name = defByTeam.get(team) ?? name;      // keep this site's naming
  }
  if (!name || !pos) continue;
  parsed.push({ name, team, pos, rank });
}
parsed.sort((a, b) => a.rank - b.rank);

if (parsed.length < 150) {
  throw new Error(`Only ${parsed.length} usable ranked players parsed — refusing to rewrite the table.`);
}

/* ── match against the existing table ── */
const byKey = new Map();      // name+pos
const byName = new Map();     // name only
for (const r of rows) {
  byKey.set(norm(r[1]) + '|' + r[3], r);
  if (!byName.has(norm(r[1]))) byName.set(norm(r[1]), r);
}

const newRank = new Map();    // row -> rank
const added = [];
let matched = 0, top100matched = 0;

for (const p of parsed) {
  const row = byKey.get(norm(p.name) + '|' + p.pos) ?? byName.get(norm(p.name));
  if (row) {
    if (!newRank.has(row)) { newRank.set(row, p.rank); matched++; if (p.rank <= 100) top100matched++; }
  } else if (p.rank <= ADD_THROUGH_RANK) {
    const row = [p.rank, p.name, p.team, p.pos, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    rows.push(row);
    newRank.set(row, p.rank);
    added.push(`${p.rank}. ${p.name} (${p.team} ${p.pos})`);
  }
}

/* ── sanity gate: a changed API shape must fail loudly, not silently wreck it ── */
const top100count = parsed.filter((p) => p.rank <= 100).length;
const hitRate = top100count ? top100matched / top100count : 0;
console.log(`Matched ${matched} of ${parsed.length} ranked players (top-100 hit rate ${(hitRate * 100).toFixed(0)}%)`);
if (hitRate < 0.7) {
  throw new Error(`Only ${(hitRate * 100).toFixed(0)}% of the top 100 matched the table — name format likely changed. Not rewriting.`);
}

/* ── apply ranks and re-sort: ranked first, then everything else in its old order ── */
const oldIndex = new Map(rows.map((r, i) => [r, i]));
for (const [row, rank] of newRank) row[0] = rank;
const unrankedBase = 10000;
rows.sort((a, b) => {
  const ar = newRank.has(a) ? newRank.get(a) : unrankedBase + oldIndex.get(a);
  const br = newRank.has(b) ? newRank.get(b) : unrankedBase + oldIndex.get(b);
  return ar - br;
});

const unranked = rows.length - newRank.size;
console.log(`Added ${added.length} newly ranked players; ${unranked} table players are unranked (kept at the bottom)`);
if (added.length) console.log('  ' + added.slice(0, 20).join('\n  ') + (added.length > 20 ? `\n  …and ${added.length - 20} more` : ''));

if (rows.some((r) => r.length !== 14)) throw new Error('built a row with the wrong column count — aborting');

/* ── write back, preserving the original one-row-per-line formatting ── */
const body = rows.map((r) => JSON.stringify(r)).join(',\n');
const updated = html.slice(0, block.index) + `var DRAFT_DB=[\n${body}\n];` +
  html.slice(block.index + block[0].length);

if (updated === html) {
  console.log('No ranking changes.');
  process.exit(0);
}
if (DRY) {
  console.log('DRY_RUN set — not writing index.html');
  process.exit(0);
}
fs.writeFileSync(HTML, updated);
console.log(`Updated ${rows.length} players in index.html`);
