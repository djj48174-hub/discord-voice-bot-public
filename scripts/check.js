'use strict';
// فحص صياغة كل ملفات جافاسكربت في المشروع (بدون node_modules)
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const root = path.join(__dirname, '..');
const skipDirs = new Set(['node_modules', '.git', 'bin', 'data', 'logs']);
const files = [];

(function walk(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (skipDirs.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.name.endsWith('.js')) files.push(full);
  }
})(root);

let bad = 0;
for (const f of files) {
  const r = cp.spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) {
    bad++;
    const err = String(r.stderr || '').trim().split('\n').slice(0, 6).join('\n');
    console.log(`❌ ${path.relative(root, f)}\n${err}\n`);
  }
}

console.log(
  bad
    ? `❌ ${bad} ملف فيه خطأ صياغة من ${files.length}`
    : `✅ كل الملفات سليمة (${files.length} ملف جافاسكربت)`,
);
process.exit(bad ? 1 : 0);
