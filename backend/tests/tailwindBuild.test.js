import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// frontend/tailwind.css is the build of the repo's own setup (frontend/package.json "build":
// tailwindcss -c tailwind.config.js -i tailwind.src.css, tailwindcss pinned) over the legacy pages and
// the markup ops.js renders. The committed file was an older build that lacked utilities the pages use
// (w-32 on the 2FA code field, tracking-widest, md:grid-cols-[200px_1fr] of api-docs, truncate, …).
// This checks the file against the pages without running tailwind: every class token the content
// uses that has the shape of a tailwind utility is a rule of tailwind.css (or of the pages' own CSS).

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FRONTEND = path.resolve(BACKEND, '..', 'frontend');
const read = (p) => fs.readFileSync(path.join(FRONTEND, p), 'utf8');

// the class selectors of a stylesheet, unescaped (".md\:grid-cols-\[200px_1fr\]" → "md:grid-cols-[200px_1fr]")
function cssClasses(css) {
  const out = new Set();
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.((?:\\.|[A-Za-z0-9_-])+)/g)) out.add(m[1].replace(/\\(.)/g, '$1'));
  return out;
}
const VARIANT = /^(?:(?:sm|md|lg|xl|2xl|hover|focus|active|disabled|first|last|odd|even|group-hover|focus-within|focus-visible|placeholder|dark):)+/;
const UTILITY = new RegExp('^-?(?:' + [
  'p[xytrbl]?', 'm[xytrbl]?', 'w', 'h', 'min-w', 'max-w', 'min-h', 'max-h', 'size', 'gap(?:-[xy])?', 'space-[xy]', 'inset(?:-[xy])?', 'top', 'right', 'bottom', 'left', 'z',
  'text', 'font', 'tracking', 'leading', 'bg', 'from', 'via', 'to', 'border(?:-[trblxy])?', 'rounded(?:-[a-z]+)?', 'ring(?:-offset)?', 'shadow', 'opacity',
  'grid-cols', 'grid-rows', 'col-span', 'row-span', 'col-start', 'col-end', 'items', 'justify', 'self', 'place-items', 'place-content', 'content', 'order',
  'flex', 'grow', 'shrink', 'basis', 'overflow(?:-[xy])?', 'whitespace', 'break', 'object', 'cursor', 'select', 'pointer-events', 'transition', 'duration', 'ease',
  'delay', 'animate', 'translate-[xy]', 'rotate', 'scale(?:-[xy])?', 'origin', 'divide(?:-[xy])?', 'outline', 'decoration', 'underline-offset', 'list', 'aspect',
  'backdrop-blur', 'blur', 'line-clamp', 'columns', 'accent', 'caret', 'fill', 'stroke',
].join('|') + ')-.+$');   // a prefix with a value; the bare ones are KEYWORDS
const KEYWORDS = new Set(['flex', 'grid', 'block', 'inline', 'inline-block', 'inline-flex', 'hidden', 'table', 'contents', 'truncate', 'uppercase', 'lowercase', 'capitalize',
  'italic', 'underline', 'line-through', 'no-underline', 'antialiased', 'sr-only', 'not-sr-only', 'relative', 'absolute', 'fixed', 'sticky', 'static', 'border', 'rounded',
  'shadow', 'ring', 'outline-none', 'container', 'grow', 'shrink', 'transition', 'transform', 'invisible', 'visible', 'tabular-nums', 'resize', 'shrink-0', 'grow-0',
  'blur', 'outline', 'filter', 'backdrop-filter', 'drop-shadow', 'collapse', 'isolate', 'ordinal', 'overline', 'border-collapse']);
function looksLikeUtility(token) {
  const base = token.replace(VARIANT, '').replace(/^!/, '');
  return KEYWORDS.has(base) || UTILITY.test(base);
}
// class tokens a file uses: class="…" in markup and template strings, className = '…', classList.add/toggle/remove('…')
function usedClasses(text) {
  const out = new Set();
  const add = (s) => { for (const t of s.split(/\s+/)) if (t && !/[${}'"+()<>=]/.test(t)) out.add(t); };
  for (const m of text.matchAll(/\bclass="([^"]*)"/g)) add(m[1]);
  for (const m of text.matchAll(/\bclass='([^']*)'/g)) add(m[1]);
  for (const m of text.matchAll(/\.className\s*=\s*['"]([^'"]*)['"]/g)) add(m[1]);
  for (const m of text.matchAll(/\.classList\.(?:add|toggle|remove)\(\s*['"]([^'"]+)['"]/g)) add(m[1]);
  return out;
}

describe('frontend/tailwind.css: the build of the repo setup, covering what the pages use', () => {
  const config = read('tailwind.config.js');
  const contentFiles = () => {
    const m = /content:\s*\[([^\]]*)\]/.exec(config);
    const globs = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    expect(globs).toEqual(['./*.html', './ops.js']);
    return [...fs.readdirSync(FRONTEND).filter((n) => n.endsWith('.html')), 'ops.js'];
  };

  it('pinned toolchain: exact tailwindcss / chart.js versions, the lockfile agrees, the build script uses the repo config', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.devDependencies).toEqual({ 'chart.js': '4.4.3', tailwindcss: '3.4.17' });
    expect(pkg.scripts.build).toBe('tailwindcss -c tailwind.config.js -i tailwind.src.css -o tailwind.css --minify');
    const lock = JSON.parse(read('package-lock.json'));
    expect(lock.packages[''].devDependencies).toEqual(pkg.devDependencies);
    expect(lock.packages['node_modules/tailwindcss'].version).toBe('3.4.17');
    expect(lock.packages['node_modules/chart.js'].version).toBe('4.4.3');
    expect(read('tailwind.src.css').trim()).toBe('@tailwind base;\n@tailwind components;\n@tailwind utilities;');
    expect(read('.gitignore')).toMatch(/^node_modules\/$/m);
  });

  it('a tailwind 3.4.17 minified build (preflight included)', () => {
    const css = read('tailwind.css');
    expect(css).toMatch(/^\*,:after,:before\{--tw-border-spacing-x:0/);
    expect(css).toContain('/*! tailwindcss v3.4.17 | MIT License | https://tailwindcss.com*/');
    expect(css.split('\n').length).toBeLessThanOrEqual(2);
  });

  it('every utility class the pages and ops.js use is in it (the ones the old build lacked included)', () => {
    const tw = cssClasses(read('tailwind.css'));
    for (const c of ['w-32', 'tracking-widest', 'min-w-0', 'md:grid-cols-[200px_1fr]', 'truncate', 'self-start', 'p-2', 'bg-white', 'whitespace-pre-wrap', 'md:grid-cols-3', 'py-8']) {
      expect(tw.has(c), c).toBe(true);
    }
    // the pages' own stylesheets / <style> blocks define the rest of their classes
    const own = new Set(['styles.css', 'aura-theme.css', 'landing/landing.css'].flatMap((f) => [...cssClasses(read(f))]));
    const missing = [];
    for (const f of contentFiles()) {
      const text = read(f);
      for (const m of text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)) for (const c of cssClasses(m[1])) own.add(c);
      for (const c of usedClasses(text)) {
        if (looksLikeUtility(c) && !tw.has(c) && !own.has(c)) missing.push(`${f}: ${c}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('the pages load it under a new cache-busting URL (static .css is cached immutable for 30 days)', () => {
    const pages = fs.readdirSync(FRONTEND).filter((n) => n.endsWith('.html') && read(n).includes('tailwind.css'));
    expect(pages.sort()).toEqual(['about.html', 'admin.html', 'api-docs.html', 'ops.html', 'settings.html', 'status.html', 'subscriptions.html']);
    for (const p of pages) expect(read(p), p).toContain('<link rel="stylesheet" href="tailwind.css?v=2"/>');
  });
});
