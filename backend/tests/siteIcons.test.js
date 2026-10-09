import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

// The icons the pages and the service worker name exist, at the sizes they are named for, made from
// the logo (frontend/logo.png: the red bolt on dark). Before, /favicon.svg, /favicon-32.png and the
// web-push icons were missing: the SPA fallback answered the landing's HTML for them.

const require = createRequire(import.meta.url);
const { PNG } = require('pngjs');
const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FRONTEND = path.resolve(BACKEND, '..', 'frontend');
const png = (p) => PNG.sync.read(fs.readFileSync(path.join(FRONTEND, p)));

function pagesAndScripts() {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'vendor') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(html|js|css|webmanifest|json)$/.test(e.name) && e.name !== 'package-lock.json') out.push(p);
    }
  };
  walk(FRONTEND);
  return out;
}

describe('site icons', () => {
  it('every local icon a page links (<link rel=icon|apple-touch-icon>) is a file', () => {
    const missing = [];
    let n = 0;
    for (const f of pagesAndScripts().filter((p) => p.endsWith('.html'))) {
      const html = fs.readFileSync(f, 'utf8');
      for (const m of html.matchAll(/<link\b[^>]*\brel="(?:icon|apple-touch-icon|shortcut icon)"[^>]*>/g)) {
        const href = (/\bhref="([^"]+)"/.exec(m[0]) || [])[1] || '';
        if (!href.startsWith('/')) continue;   // data: icons of the landing
        n += 1;
        if (!fs.existsSync(path.join(FRONTEND, href.split('?')[0]))) missing.push(`${path.relative(FRONTEND, f)}: ${href}`);
      }
    }
    expect(n).toBeGreaterThan(15);
    expect(missing).toEqual([]);
  });

  it('/favicon.svg: the logo\'s bolt in its red on the dark ground, a plain SVG (no script, no external reference)', () => {
    const svg = fs.readFileSync(path.join(FRONTEND, 'favicon.svg'), 'utf8');
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 32 32">/);
    expect(svg).toContain('d="M13.5 2L5 13.5h6L9.5 22 19 9.5h-6.2L13.5 2z"');   // the bolt of the landing / app logo
    expect(svg).toContain('fill="#ff2a4d"');
    expect(svg).not.toMatch(/<script|href=|url\(|on[a-z]+=/i);
  });

  it('/favicon-32.png 32×32, icon-192 192×192 (opaque, the logo), badge 96×96 white on transparent', () => {
    const fav = png('favicon-32.png');
    expect([fav.width, fav.height]).toEqual([32, 32]);
    const icon = png('assets/img/icon-192.png');
    expect([icon.width, icon.height]).toEqual([192, 192]);
    // the logo's colours: a dark ground and the bolt red in the middle
    const px = (img, x, y) => { const i = (img.width * y + x) * 4; return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]]; };
    const [r, g, b] = px(icon, 96, 96);
    expect(r).toBeGreaterThan(200); expect(g).toBeLessThan(90); expect(b).toBeLessThan(120);
    expect(px(icon, 3, 3).slice(0, 3).every((c) => c < 40)).toBe(true);
    const [fr, fg] = px(fav, 16, 16);
    expect(fr).toBeGreaterThan(200); expect(fg).toBeLessThan(90);
    // Android paints only the badge's alpha: white where the bolt is, transparent around it
    const badge = png('assets/img/badge.png');
    expect([badge.width, badge.height]).toEqual([96, 96]);
    expect(px(badge, 2, 2)[3]).toBe(0);
    expect(px(badge, 48, 48)).toEqual([255, 255, 255, 255]);
    let opaque = 0;
    for (let i = 3; i < badge.data.length; i += 4) if (badge.data[i] > 128) opaque += 1;
    expect(opaque / (96 * 96)).toBeGreaterThan(0.08);   // the bolt covers ~14% of the square
    expect(opaque / (96 * 96)).toBeLessThan(0.6);
  });

  it('sw.js names the two notification icons, both present', () => {
    const sw = fs.readFileSync(path.join(FRONTEND, 'sw.js'), 'utf8');
    expect(sw).toContain("icon: '/assets/img/icon-192.png',");
    expect(sw).toContain("badge: '/assets/img/badge.png',");
    for (const f of ['assets/img/icon-192.png', 'assets/img/badge.png']) expect(fs.existsSync(path.join(FRONTEND, f)), f).toBe(true);
  });

  it('the unused 1.5 MB assets/img/chm-log.jpg is gone, and nothing names it', () => {
    expect(fs.existsSync(path.join(FRONTEND, 'assets', 'img', 'chm-log.jpg'))).toBe(false);
    for (const f of pagesAndScripts()) expect(fs.readFileSync(f, 'utf8').includes('chm-log.jpg'), path.relative(FRONTEND, f)).toBe(false);
  });
});
