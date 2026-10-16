// Builds the oasis helper's built-in data from an oasis-finder scan:
//   node scripts/oasis-data.ts <scan.json>
// Writes public/oasis-data/<world key>.json (oases only, no player names) and updates index.json.
// public/oasis-data/ is gitignored: it is deployed with the site but never pushed to GitHub.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compactScan, metaOf, type WorldMeta } from '../src/oasis/scanFormat.ts';

const input = process.argv[2];
if (!input) {
  console.error('Usage: node scripts/oasis-data.ts <scan.json>');
  process.exit(1);
}

const world = compactScan(JSON.parse(readFileSync(input, 'utf8')));
const meta = metaOf(world);
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'oasis-data');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `${meta.key}.json`), JSON.stringify(world));

let index: WorldMeta[] = [];
try {
  const old = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as unknown;
  if (Array.isArray(old)) index = old as WorldMeta[];
} catch {
  // first world
}
index = [...index.filter((m) => m.key !== meta.key), meta].sort((a, b) => a.key.localeCompare(b.key));
writeFileSync(join(dir, 'index.json'), JSON.stringify(index, null, 1));
console.log(`${meta.world}: ${meta.count} oases, scan of ${new Date(meta.scannedAt).toISOString()} -> public/oasis-data/${meta.key}.json`);
