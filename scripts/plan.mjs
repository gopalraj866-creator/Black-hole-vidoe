// Prints a GitHub Actions matrix: node scripts/plan.mjs <framesPerShard>
import fs from 'node:fs';
const tl = JSON.parse(fs.readFileSync(new URL('../data/timeline.json', import.meta.url)));
const size = parseInt(process.argv[2] || '300', 10);
const total = Math.round(tl.duration * tl.fps);
const include = [];
for (let s = 0, i = 0; s < total; s += size, i++) {
  include.push({ index: String(i).padStart(4, '0'), start: s, end: Math.min(s + size, total) });
}
process.stdout.write(JSON.stringify({ include }));
