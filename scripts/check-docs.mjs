#!/usr/bin/env node
/*
 * Documentation link check (issue #14).
 *
 * Every relative link and image in the shipped documentation must resolve to a
 * file in the repository, and every in-page anchor must match a heading. Absolute
 * URLs (badges, upstream sites) are not fetched: CI must not depend on the network
 * for a documentation check.
 *
 *   node scripts/check-docs.mjs
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const files = [
  'README.md',
  'README.ru.md',
  ...readdirSync(join(root, 'docs'), { recursive: true })
    .map((entry) => `docs/${String(entry).replace(/\\/g, '/')}`)
    .filter((entry) => entry.endsWith('.md')),
].sort();

const linkPattern = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const htmlPattern = /<(?:img|a)\b[^>]*?(?:src|href)="([^"]+)"/g;
const headingPattern = /^#{1,6}\s+(.+)$/gm;

/** GitHub-style heading anchor. */
const slug = (heading) =>
  heading
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');

const anchorsOf = (text) => {
  const anchors = new Set();
  for (const match of text.matchAll(headingPattern)) {
    anchors.add(slug(match[1]));
  }
  return anchors;
};

const problems = [];
let checked = 0;

for (const file of files) {
  const absolute = join(root, file);
  if (!existsSync(absolute)) {
    problems.push(`${file}: file does not exist`);
    continue;
  }
  const text = readFileSync(absolute, 'utf8');
  const anchors = anchorsOf(text);
  const targets = [...text.matchAll(linkPattern), ...text.matchAll(htmlPattern)].map((match) => match[1]);

  for (const target of targets) {
    if (/^(https?:|mailto:|tel:)/i.test(target)) continue;
    const [pathPart, anchorPart] = target.split('#');
    checked += 1;
    if (pathPart === '') {
      // In-page anchor: it must point at a real heading.
      if (anchorPart !== undefined && !anchors.has(anchorPart)) {
        problems.push(`${file}: anchor #${anchorPart} does not match a heading`);
      }
      continue;
    }
    const resolved = resolve(dirname(absolute), pathPart);
    if (!existsSync(resolved)) {
      problems.push(`${file}: ${pathPart} does not exist (from ${relative(root, dirname(absolute)) || '.'})`);
      continue;
    }
    if (anchorPart !== undefined && statSync(resolved).isFile()) {
      const targetAnchors = anchorsOf(readFileSync(resolved, 'utf8'));
      if (!targetAnchors.has(anchorPart)) {
        problems.push(`${file}: ${pathPart}#${anchorPart} does not match a heading`);
      }
    }
  }
}

for (const problem of problems) {
  console.error(`FAIL ${problem}`);
}
console.log(`docs check: ${files.length} files, ${checked} local links/images, ${problems.length} problems`);
process.exit(problems.length === 0 ? 0 : 1);
