#!/usr/bin/env node
/**
 * build-preview — cross-platform preview build with ZOIRIS_PREVIEW=1 so draft
 * and approved records are rendered as noindex preview routes and robots.txt
 * disallows crawling.
 */
import { spawnSync } from 'node:child_process';

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const res = spawnSync(npx, ['astro', 'build'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, ZOIRIS_PREVIEW: '1' }
});
process.exit(res.status ?? 1);
