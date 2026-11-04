// @ts-check
import { defineConfig } from 'astro/config';
import { readFileSync } from 'node:fs';

/**
 * Zoiris Junk Removal — Astro configuration.
 *
 * The public site is fully static. The production origin comes from the
 * SITE_URL environment variable, falling back to the configured website in
 * src/data/business.json. Hosting-provider specifics live in /deploy, never here.
 */
const business = JSON.parse(readFileSync(new URL('./src/data/business.json', import.meta.url), 'utf8'));
const redirectList = JSON.parse(readFileSync(new URL('./src/data/redirects.json', import.meta.url), 'utf8'));
const redirects = Object.fromEntries(
  redirectList.map((/** @type {{ from: string; to: string; status: 301 | 302 }} */ r) => [
    r.from,
    { status: r.status, destination: r.to }
  ])
);
const site = (process.env.SITE_URL || business.website).replace(/\/+$/, '');

export default defineConfig({
  site,
  output: 'static',
  trailingSlash: 'always',
  redirects,
  build: {
    format: 'directory',
    inlineStylesheets: 'auto'
  },
  compressHTML: true,
  devToolbar: { enabled: false }
});
