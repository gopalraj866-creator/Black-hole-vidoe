// Headless frame renderer.
//   node render.mjs --start=0 --end=300 --out=build/shards/shard_0000.mp4   (encode a frame range)
//   node render.mjs --snap=1,20,45                                          (PNG previews at those seconds)
import puppeteer from 'puppeteer';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return [m[1], m[2] ?? true];
}));
const tl = JSON.parse(fs.readFileSync(path.join(root, 'data/timeline.json'), 'utf8'));
const FPS = tl.fps, W = 1920, H = 1080;
const total = Math.round(tl.duration * FPS);

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.glsl': 'text/plain', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const u = decodeURI(req.url.split('?')[0]);
  const f = path.join(root, u === '/' ? '/web/index.html' : u);
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': mime[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}).listen(0, '127.0.0.1');
await once(server, 'listening');
const port = server.address().port;

const browser = await puppeteer.launch({
  headless: true,
  args: [
    '--no-sandbox', '--disable-setuid-sandbox', '--enable-webgl', '--ignore-gpu-blocklist',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    `--window-size=${W},${H}`, '--hide-scrollbars', '--force-device-scale-factor=1',
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
page.on('console', (m) => console.log('[page]', m.text()));
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(`http://127.0.0.1:${port}/web/index.html`, { waitUntil: 'load' });
await page.waitForFunction('window.__ready === true', { timeout: 180000 });

async function shot(t, opts) {
  await page.evaluate((tt) => window.renderAt(tt), t);
  const err = await page.evaluate(() => window.__error || null);
  if (err) throw new Error(err);
  return page.screenshot(opts);
}

if (args.snap) {
  fs.mkdirSync(path.join(root, 'build/snaps'), { recursive: true });
  for (const s of String(args.snap).split(',')) {
    const t = Number(s);
    const t0 = Date.now();
    const buf = await shot(t, { type: 'png' });
    const f = path.join(root, `build/snaps/t_${String(Math.round(t)).padStart(3, '0')}.png`);
    fs.writeFileSync(f, buf);
    console.log(`snap t=${t}s -> ${f} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }
  await browser.close(); server.close();
  process.exit(0);
}

const start = Number(args.start ?? 0), end = Math.min(Number(args.end ?? total), total);
const out = path.resolve(root, args.out || `build/shards/shard_${String(start).padStart(5, '0')}.mp4`);
fs.mkdirSync(path.dirname(out), { recursive: true });

const filter = '[0:v]split[a][b];[b]gblur=sigma=14[bl];[a][bl]blend=all_mode=screen:all_opacity=0.28[m];[m]noise=alls=3:allf=t,format=yuv420p[v]';
const ff = spawn('ffmpeg', [
  '-y', '-loglevel', 'error',
  '-f', 'image2pipe', '-framerate', String(FPS), '-vcodec', 'mjpeg', '-i', '-',
  '-filter_complex', filter, '-map', '[v]',
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-r', String(FPS), '-g', String(FPS * 2), '-an', out,
], { stdio: ['pipe', 'inherit', 'inherit'] });
const ffDone = new Promise((res, rej) => ff.on('close', (c) => (c === 0 ? res() : rej(new Error('ffmpeg exited ' + c)))));
ff.stdin.on('error', () => {});

const t0 = Date.now();
for (let f = start; f < end; f++) {
  const buf = await shot(f / FPS, { type: 'jpeg', quality: 96 });
  if (!ff.stdin.write(buf)) await once(ff.stdin, 'drain');
  const done = f - start + 1;
  if (done % 10 === 0 || f === end - 1) {
    const el = (Date.now() - t0) / 1000;
    console.log(`frame ${f + 1}/${end}  ${(el / done).toFixed(2)} s/frame  eta ${(((end - f - 1) * el) / done / 60).toFixed(1)} min`);
  }
}
ff.stdin.end();
await ffDone;
await browser.close();
server.close();
console.log('wrote', out);
