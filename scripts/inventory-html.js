#!/usr/bin/env node
/**
 * Collects a frozen inventory of all interactive/critical elements across
 * every HTML in frontend/. Used BEFORE the restyle to capture the current
 * state, AFTER the restyle to verify no logic-bearing attribute changed.
 *
 * Usage:
 *   node scripts/inventory-html.js > INVENTORY_BEFORE.md
 *   # restyle...
 *   node scripts/inventory-html.js > INVENTORY_AFTER.md
 *   diff INVENTORY_BEFORE.md INVENTORY_AFTER.md    # must be empty
 *
 * Uses zero deps — regex-based extraction. Good enough for this codebase:
 * we're checking a flat list of attributes, not building a DOM.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', 'frontend');
const FILES = fs.readdirSync(ROOT)
  .filter((f) => f.endsWith('.html'))
  .sort();

function attrs(tag) {
  const out = {};
  const re = /([a-zA-Z_:][a-zA-Z0-9_:\-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let m;
  while ((m = re.exec(tag))) out[m[1]] = (m[2] ?? m[3] ?? m[4] ?? '');
  return out;
}

function extract(html, tagName) {
  const hits = [];
  const re = new RegExp(`<${tagName}\\b([^>]*)>`, 'gi');
  let m;
  while ((m = re.exec(html))) hits.push(attrs(m[1]));
  return hits;
}

// Extract <form> with nested <input name=...> names
function extractForms(html) {
  const re = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  const out = [];
  let m;
  while ((m = re.exec(html))) {
    const formAttrs = attrs(m[1]);
    const inner = m[2];
    const inputs = [];
    const inputRe = /<(input|select|textarea|button)\b([^>]*)>/gi;
    let im;
    while ((im = inputRe.exec(inner))) {
      const a = attrs(im[2]);
      if (a.name || a.type || a.id) {
        inputs.push({
          tag: im[1], name: a.name || '', type: a.type || '',
          id: a.id || '', required: a.required !== undefined ? 'y' : '',
        });
      }
    }
    out.push({
      id: formAttrs.id || '', action: formAttrs.action || '',
      method: (formAttrs.method || 'get').toLowerCase(),
      name: formAttrs.name || '', inputs,
    });
  }
  return out;
}

function extractScripts(html) {
  const out = [];
  // External
  const srcRe = /<script\b([^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*)>\s*<\/script>/gi;
  let m;
  while ((m = srcRe.exec(html))) out.push({ type: 'external', src: m[2] });
  // Inline (hashed, so content change is detected without dumping code)
  const inlineRe = /<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  while ((m = inlineRe.exec(html))) {
    const code = m[1] || '';
    const h = crypto.createHash('sha256').update(code).digest('hex').slice(0, 16);
    out.push({ type: 'inline', sha256: h, bytes: code.length });
  }
  return out;
}

function extractFetchURLs(html) {
  // Captures API-ish URLs appearing in inline <script> OR as data-url attributes
  const out = new Set();
  const re = /(?:fetch|axios\.\w+|API_BASE|\/api\/)[^"'`]{0,80}/g;
  let m;
  while ((m = re.exec(html))) out.add(m[0].slice(0, 80));
  return [...out].sort();
}

console.log('# INVENTORY — frontend HTML');
console.log(`Generated ${new Date().toISOString()}\n`);

for (const f of FILES) {
  const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
  console.log(`\n## ${f}\n`);
  console.log(`- size: ${html.length} bytes`);
  console.log(`- sha256: ${crypto.createHash('sha256').update(html).digest('hex').slice(0, 16)}`);

  // Forms
  const forms = extractForms(html);
  if (forms.length) {
    console.log(`\n### forms (${forms.length})`);
    for (const fm of forms) {
      console.log(`- id=\`${fm.id}\` action=\`${fm.action}\` method=\`${fm.method}\` inputs=${fm.inputs.length}`);
      for (const i of fm.inputs) {
        console.log(`  - ${i.tag} name=\`${i.name}\` type=\`${i.type}\` id=\`${i.id}\` req=\`${i.required}\``);
      }
    }
  }

  // Buttons with id/onclick/data-*
  const buttons = extract(html, 'button').filter((a) => a.id || a.onclick || Object.keys(a).some((k) => k.startsWith('data-')));
  if (buttons.length) {
    console.log(`\n### buttons with id/onclick/data-* (${buttons.length})`);
    for (const b of buttons) {
      const data = Object.entries(b).filter(([k]) => k.startsWith('data-')).map(([k, v]) => `${k}=${v}`).join(' ');
      console.log(`- id=\`${b.id || ''}\` onclick=\`${(b.onclick || '').slice(0, 60)}\` type=\`${b.type || ''}\` ${data}`);
    }
  }

  // Links with href/data-*
  const links = extract(html, 'a').filter((a) => a.href || a.onclick || Object.keys(a).some((k) => k.startsWith('data-')));
  if (links.length) {
    console.log(`\n### links (${links.length})`);
    for (const a of links) {
      const data = Object.entries(a).filter(([k]) => k.startsWith('data-')).map(([k, v]) => `${k}=${v}`).join(' ');
      console.log(`- href=\`${a.href || ''}\` id=\`${a.id || ''}\` target=\`${a.target || ''}\` ${data}`);
    }
  }

  // Scripts
  const scripts = extractScripts(html);
  if (scripts.length) {
    console.log(`\n### scripts (${scripts.length})`);
    for (const s of scripts) {
      if (s.type === 'external') console.log(`- external: \`${s.src}\``);
      else console.log(`- inline: sha256=${s.sha256} bytes=${s.bytes}`);
    }
  }

  // API URLs
  const urls = extractFetchURLs(html);
  if (urls.length) {
    console.log(`\n### api-ish urls (${urls.length})`);
    for (const u of urls) console.log(`- \`${u}\``);
  }
}
