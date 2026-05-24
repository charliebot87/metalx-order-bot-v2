#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const sensitivePatterns = [
  ['P', 'V', 'T'].join('') + '_[A-Za-z0-9_]+',
  ['Js', 'Signature', 'Provider'].join(''),
  ['private', 'Key'].join(''),
  ['XPR', 'PRIVATE', 'KEY'].join('_'),
  ['PROTON', 'PRIVATE', 'KEY'].join('_'),
  ['WALLET', 'PRIVATE', 'KEY'].join('_'),
  ['SIGNING', 'KEY'].join('_'),
];
const pattern = new RegExp(sensitivePatterns.join('|'));
const allowList = new Set([
  'scripts/guard-no-private-keys.mjs',
  'src/security.ts',
  'README.md',
]);

const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .filter(file => !allowList.has(file));

const hits = [];
for (const file of files) {
  const fullPath = resolve(root, file);
  const text = readFileSync(fullPath, 'utf8');
  if (pattern.test(text)) hits.push(relative(root, fullPath));
}

if (hits.length > 0) {
  console.error('Refusing to continue: possible signing/private-key material in tracked files:');
  for (const hit of hits) console.error(`- ${hit}`);
  process.exit(1);
}

console.log('ok: no private-key/signing patterns found in tracked source files');
