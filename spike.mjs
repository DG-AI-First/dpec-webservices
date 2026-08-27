#!/usr/bin/env node
// Throwaway instrument, NOT the deliverable. Its job is to answer the empirical
// unknowns (SOAPAction, http vs https, TLS chain, real response shape) so the
// real probe gets built on facts instead of on a reconstruction of a screenshot.
//
//   node --env-file=.env spike.mjs facturas
//   node --env-file=.env spike.mjs deuda
//
// No dependencies. No npm install. Raw XML in, raw XML out.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const HOSTS = { qa: 'sapqas.dpec.com.ar', prod: 'sapprd.dpec.com.ar' };
const NS = 'urn:sap-com:document:sap:rfc:functions';

const env = (k, d = '') => (process.env[k] ?? d).trim();

const OPS = {
  facturas: {
    operation: 'ZWsSap002',
    path: '/sap/bc/srt/rfc/sap/z_ws_sap_002/100/z_ws_sap_002/z_ws_sap_002',
    // PascalCase = the wire format. The doc's "iAnlageField" names are .NET proxy
    // artifacts and would be silently ignored by SAP, yielding a plausible empty result.
    fields: () => [
      ['IAnlage', env('DPEC_ANLAGE')],
      ['ICantfact', env('DPEC_CANTFACT', '10')],
      ['IPartner', env('DPEC_PARTNER')],
    ],
  },
  deuda: {
    operation: 'ZFicaDeudaIcUnif',
    path: '/sap/bc/srt/rfc/sap/z_fica_deuda_ic_unif/100/z_fica_deuda_ic_unif/z_fica_deuda_ic_unif',
    fields: () => [
      ['PiCc', env('DPEC_CC')],
      ['PiFechaHasta', env('DPEC_FECHA_HASTA')],
      ['PiI', env('DPEC_I')],
      ['PiIc', env('DPEC_IC')],
      ['PiNumMax', env('DPEC_NUM_MAX', '10')],
    ],
  },
};

const escapeXml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
           .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

function buildEnvelope(op) {
  const body = op.fields()
    .map(([name, value]) => `      <urn:${name}>${escapeXml(value)}</urn:${name}>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="${NS}">
  <soapenv:Header/>
  <soapenv:Body>
    <urn:${op.operation}>
${body}
    </urn:${op.operation}>
  </soapenv:Body>
</soapenv:Envelope>`;
}

// Native fetch reports every network failure as "TypeError: fetch failed".
// The actionable code is buried in the cause chain, sometimes two levels deep.
function diagnose(err) {
  const codes = [];
  let c = err;
  for (let i = 0; i < 5 && c; i++) {
    if (c.code) codes.push(c.code);
    if (Array.isArray(c.errors)) c.errors.forEach((e) => e?.code && codes.push(e.code));
    c = c.cause;
  }
  const seen = codes.join(', ') || err.message;
  const hint =
    /SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO|CERT_HAS_EXPIRED|ALTNAME/.test(seen)
      ? 'TLS: DPEC likely uses an internal CA. Ask them for the CA .pem.'
    : /ENOTFOUND|EAI_AGAIN/.test(seen)
      ? 'DNS: host does not resolve. VPN required?'
    : /ECONNREFUSED|EHOSTUNREACH|ECONNRESET|ETIMEDOUT/.test(seen)
      ? 'Network: firewall or port blocked.'
    : /Abort/.test(seen)
      ? 'Timeout. Raise DPEC_TIMEOUT_MS.'
      : 'Unrecognized. Full chain printed above.';
  return { seen, hint };
}

async function main() {
  const which = process.argv[2] ?? 'facturas';
  const op = OPS[which];
  if (!op) { console.error(`Unknown service "${which}". Use: facturas | deuda`); process.exit(2); }

  const target = env('DPEC_ENV', 'qa');
  if (!Object.hasOwn(HOSTS, target)) {
    console.error(`DPEC_ENV must be exactly "qa" or "prod" (got "${target}"). Refusing to guess.`);
    process.exit(2);
  }
  if (target === 'prod' && env('DPEC_CONFIRM_PROD') !== 'I_UNDERSTAND_THIS_HITS_PRODUCTION') {
    console.error('DPEC_ENV=prod requires DPEC_CONFIRM_PROD=I_UNDERSTAND_THIS_HITS_PRODUCTION');
    process.exit(2);
  }

  const user = env('SAP_USER'), pass = process.env.SAP_PASSWORD ?? '';
  if (!user || !pass) { console.error('SAP_USER / SAP_PASSWORD missing. Copy .env.example to .env.'); process.exit(2); }

  const url = `${env('DPEC_SCHEME', 'https')}://${HOSTS[target]}${op.path}?sap-client=${env('DPEC_SAP_CLIENT', '100')}`;
  const xml = buildEnvelope(op);
  const runDir = join('evidence', 'spike-' + new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, `${which}.request.xml`), xml);

  console.log(`\n  target      ${target.toUpperCase()}  ${url}`);
  console.log(`  service     ${op.operation}`);
  console.log(`  soapAction  "${env('DPEC_SOAP_ACTION')}"`);
  console.log(`  evidence    ${runDir}\n`);
  if (target === 'prod') console.log('  *** HITTING PRODUCTION ***\n');

  const auth = Buffer.from(`${user}:${pass}`, env('DPEC_BASIC_AUTH_CHARSET', 'utf8'))
    .toString('base64');

  let res, raw;
  const started = Date.now();
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml;charset=UTF-8',
        SOAPAction: `"${env('DPEC_SOAP_ACTION')}"`,
        Authorization: `Basic ${auth}`,
      },
      body: xml,
      signal: AbortSignal.timeout(Number(env('DPEC_TIMEOUT_MS', '30000'))),
    });
    // Read the body ALWAYS, whatever the status. SOAP 1.1 faults ride on HTTP 500,
    // and the faultstring is exactly what tells us the correct SOAPAction.
    raw = await res.text();
  } catch (err) {
    const { seen, hint } = diagnose(err);
    console.error(`  TRANSPORT FAILURE after ${Date.now() - started}ms`);
    console.error(`  codes: ${seen}`);
    console.error(`  ${hint}\n`);
    console.error(err);
    process.exit(4);
  }

  writeFileSync(join(runDir, `${which}.response.xml`), raw);
  console.log(`  HTTP ${res.status} ${res.statusText}  (${Date.now() - started}ms, ${raw.length} bytes)\n`);

  if (res.status === 401 || res.status === 403) {
    console.error(`  AUTH REJECTED. Reached SAP fine, credentials refused for ${target.toUpperCase()}.`);
    console.error(`  If these creds are for the other environment, flip DPEC_ENV.`);
    console.error(`  If the password has non-ASCII chars, try DPEC_BASIC_AUTH_CHARSET=latin1.\n`);
    process.exit(2);
  }

  const fault = raw.match(/<faultstring[^>]*>([\s\S]*?)<\/faultstring>/i);
  if (fault) {
    console.error(`  SOAP FAULT: ${fault[1].trim()}`);
    console.error(`  (read it carefully — a SOAPAction complaint names the value SAP wants)\n`);
  }

  console.log('--- RAW RESPONSE ---------------------------------------------');
  console.log(raw);
  console.log('--------------------------------------------------------------');
  console.log(`\n  Saved to ${runDir}\n`);
  process.exit(fault ? 3 : 0);
}

main();
