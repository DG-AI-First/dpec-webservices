// Diagnostic: is the service PUBLISHED but failing to execute, or not properly
// configured at all? A reachable WSDL means published. Read-only GET.
const HOSTS = { qa: 'sapqas.dpec.com.ar', prod: 'sapprd.dpec.com.ar' };
const env = (k, d = '') => (process.env[k] ?? d).trim();
const auth = Buffer.from(`${env('SAP_USER')}:${process.env.SAP_PASSWORD ?? ''}`,
  env('DPEC_BASIC_AUTH_CHARSET', 'utf8')).toString('base64');

const paths = {
  z_ws_sap_002: '/sap/bc/srt/rfc/sap/z_ws_sap_002/100/z_ws_sap_002/z_ws_sap_002',
  z_fica_deuda_ic_unif: '/sap/bc/srt/rfc/sap/z_fica_deuda_ic_unif/100/z_fica_deuda_ic_unif/z_fica_deuda_ic_unif',
};

for (const [name, path] of Object.entries(paths)) {
  const url = `https://${HOSTS[env('DPEC_ENV', 'qa')]}${path}?sap-client=100&wsdl`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(20000),
    });
    const body = await res.text();
    const isWsdl = /<(wsdl:)?definitions/i.test(body);
    console.log(`\n  ${name}`);
    console.log(`    HTTP ${res.status}  ${res.headers.get('content-type') ?? ''}  ${body.length} bytes`);
    console.log(`    WSDL served: ${isWsdl ? 'YES — service is published' : 'NO'}`);
    if (!isWsdl) {
      const fault = body.match(/<faultstring[^>]*>([\s\S]*?)<\/faultstring>/i);
      const title = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      console.log(`    body: ${(fault?.[1] ?? title?.[1] ?? body.slice(0, 300)).trim().slice(0, 300)}`);
    }
  } catch (e) {
    console.log(`\n  ${name}\n    FAILED: ${e.cause?.code ?? e.message}`);
  }
}
