// Run banner — printed before the first request (design §4, mechanism 5).
// Deliberately not an interactive prompt: interactive gates in a deadline
// script get bypassed with `yes |`, and the double-token PROD gate in
// config.ts already does the real work. This banner is for the human
// reading the terminal afterward.

import type { AppConfig } from '../config.js';

const BORDER = '='.repeat(70);

function describeTls(tls: AppConfig['tls']): string {
  if (tls.mode === 'custom-ca') return `custom-ca (${tls.caFile})`;
  return tls.mode;
}

export function printBanner(config: AppConfig): void {
  const loud = config.env === 'prod' || config.tls.mode === 'insecure';

  if (loud) {
    console.log(BORDER);
    if (config.env === 'prod') {
      console.log('  *** TARGETING PRODUCTION — DPEC_CONFIRM_PROD was set explicitly ***');
    }
    if (config.tls.mode === 'insecure') {
      console.log('  *** TLS CERTIFICATE VERIFICATION IS DISABLED — evidence is not proof of a valid chain ***');
    }
    console.log(BORDER);
  }

  console.log(`  run         ${config.runId}`);
  console.log(`  env         ${config.env.toUpperCase()}`);
  console.log(`  target      ${config.scheme}://${config.host}`);
  console.log(`  sap-client  ${config.sapClient}`);
  console.log(`  dry-run     ${config.dryRun ? 'YES' : 'no'}`);
  console.log(`  tls         ${describeTls(config.tls)}`);
  console.log('');
}
