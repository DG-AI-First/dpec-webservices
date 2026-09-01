// Banner de inicio, impreso antes del primer request. No es un prompt
// interactivo: eso se saltea con `yes |`, y el doble token de PROD en
// config.ts ya hace el trabajo real. Este banner es para quien lee la
// terminal después.

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
