// Diagnostic: fetch each service's WSDL. Read-only GET.
//
// NOTE (2026-08-28): this script used to append `?wsdl` to the runtime
// endpoint and got SAP's proprietary `<error>` page back, from which we
// wrongly concluded the binding was unconfigured in SOAMANAGER. `?wsdl` on
// the runtime endpoint is NOT this system's metadata URL. The real one is
// /sap/bc/srt/wsdl/flv_<flavour>/bndg_url/<endpoint path> and it has always
// returned HTTP 200 with a valid WSDL. Fixed below — see README,
// "Correccion al diagnostico anterior".
const HOSTS = { qa: 'sapqas.dpec.com.ar', prod: 'sapprd.dpec.com.ar' };
const env = (k, d = '') => (process.env[k] ?? d).trim();
const auth = Buffer.from(`${env('SAP_USER')}:${process.env.SAP_PASSWORD ?? ''}`,
  env('DPEC_BASIC_AUTH_CHARSET', 'utf8')).toString('base64');

// Flavour id as given by DPEC. If a future system answers 404 here, ask them
// for the WSDL URL rather than guessing it — that guess is what cost us weeks.
const FLAVOUR = env('DPEC_WSDL_FLAVOUR', 'flv_10002A111AD1');

const paths = {
  z_ws_sap_002: '/sap/bc/srt/rfc/sap/z_ws_sap_002/100/z_ws_sap_002/z_ws_sap_002',
  z_fica_deuda_ic_unif: '/sap/bc/srt/rfc/sap/z_fica_deuda_ic_unif/100/z_fica_deuda_ic_unif/z_fica_deuda_ic_unif',
};

for (const [name, path] of Object.entries(paths)) {
  const url = `https://${HOSTS[env('DPEC_ENV', 'qa')]}/sap/bc/srt/wsdl/${FLAVOUR}/bndg_url${path}?sap-client=100`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(20000),
    });
    const body = await res.text();
    const isWsdl = /<(wsdl:)?definitions/i.test(body);
    console.log(`\n  ${name}`);
    console.log(`    HTTP ${res.status}  ${res.headers.get('content-type') ?? ''}  ${body.length} bytes`);
    console.log(`    WSDL served: ${isWsdl ? 'YES — binding is configured' : 'NO'}`);
    if (!isWsdl) {
      const fault = body.match(/<faultstring[^>]*>([\s\S]*?)<\/faultstring>/i);
      const title = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      console.log(`    body: ${(fault?.[1] ?? title?.[1] ?? body.slice(0, 300)).trim().slice(0, 300)}`);
    }
  } catch (e) {
    console.log(`\n  ${name}\n    FAILED: ${e.cause?.code ?? e.message}`);
  }
}
