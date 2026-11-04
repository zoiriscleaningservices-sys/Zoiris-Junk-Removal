#!/usr/bin/env node
/**
 * scripts/provision-owner.mjs
 * Secure CLI utility to provision the initial Zoiris Command Center owner
 * account or generate a 15-minute password recovery token on the server.
 *
 * Never stores credentials in source code or Git history.
 *
 * Examples:
 *   npm run owner:provision -- --email owner@zoirisjunkremoval.com --name "Zoiris Owner" --password "<12+ char password>"
 *   npm run owner:provision -- --recover owner@zoirisjunkremoval.com
 */
import { openZoirisDb } from '../server/db.mjs';
import { loadOrInitMasterKey } from '../server/crypto-totp.mjs';
import { createAuthManager } from '../server/auth.mjs';

function argVal(flag) {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : '';
}

const ctx = openZoirisDb();
const masterKey = loadOrInitMasterKey(ctx.paths.secretFile);
const auth = createAuthManager({ ctx, masterKey });

try {
  const recoverEmail = argVal('--recover');
  if (recoverEmail) {
    const res = auth.issueRecoveryToken(recoverEmail);
    if (!res) {
      console.error(`No active owner account found for "${recoverEmail}".`);
      process.exit(1);
    }
    console.log('\n  Zoiris Owner Recovery Token (valid for 15 minutes):');
    console.log(`  Account: ${res.owner.email}`);
    console.log(`  Token:   ${res.token}\n`);
    process.exit(0);
  }

  const email = argVal('--email') || process.env.OWNER_BOOTSTRAP_EMAIL || '';
  const displayName = argVal('--name') || process.env.OWNER_BOOTSTRAP_NAME || 'Zoiris Owner';
  const password = argVal('--password') || process.env.OWNER_BOOTSTRAP_PASSWORD || '';

  if (!email || !password) {
    console.error(
      'Usage: npm run owner:provision -- --email <owner-email> --name "<Owner Name>" --password "<12+ char password with letters & numbers>"'
    );
    process.exit(1);
  }

  const created = auth.provisionFirstOwner({
    email,
    displayName,
    password,
    allowCliBypass: true
  });
  console.log('\n  ✔ Zoiris Command Center owner account provisioned:');
  console.log(`    ID:    ${created.id}`);
  console.log(`    Name:  ${created.displayName}`);
  console.log(`    Email: ${created.email}`);
  console.log(`    Role:  ${created.role}\n`);
} catch (err) {
  console.error(`\n  ✖ Provisioning failed: ${err.message}\n`);
  process.exit(1);
} finally {
  ctx.close();
}
