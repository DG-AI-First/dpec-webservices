// DPEC indicated that external clients must use sapqasws (not sapqas).
// Probes both hosts side by side: WSDL fetch + real SOAP POST per service.
//   node --env-file=.env host-check.mjs

const HOSTS = ['sapqas.dpec.com.ar', 'sapqasws.dpec.com.ar'];
const NS = 'urn:sap-com:document:sap:rfc:functions';
const env = (k, d = '') => (process.env[k] ?? d).trim();
const auth = Buffer.from(`${env('SAP_USER')}:${process.env.SAP_PASSWORD ?? ''}`, 'utf8').toString('base64');

const SERVICES = [
  {
    slug: 'z_fica_deuda_ic_unif',
    operation: 'ZFicaDeudaIcUnif',
    path: '/sap/bc/srt/rfc/sap/z_fica_deuda_ic_unif/100/z_fica_deuda_ic_unif/z_fica_deuda_ic_unif',
    fields: [['PiCc', ''], ['PiFechaHasta', ''], ['PiI', ''], ['PiIc', env('DPEC_IC')], ['PiNumMax', '10']],
  },
  {
    slug: 'z_ws_sap_002',
    operation: 'ZWsSap002',
    path: '/sap/bc/srt/rfc/sap/z_ws_sap_002/100/z_ws_sap_002/z_ws_sap_002',
    fields: [['IAnlage', env('DPEC_ANLAGE')], ['ICantfact', '10'], ['IPartner', env('DPEC_PARTNER')]],
  },
];

const envelope = (svc) => `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="${NS}">
  <soapenv:Header/>
  <soapenv:Body>
    <urn:${svc.operation}>
${svc.fields.map(([n, v]) => `      <urn:${n}>${v}</urn:${n}>`).join('\n')}
    </urn:${svc.operation}>
  </soapenv:Body>
</soapenv:Envelope>`;

async function hit(url, init) {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
    return { status: res.status, body: await res.text() };
  } catch (e) {
    return { status: null, error: e.cause?.code ?? e.message };
  }
}

for (const host of HOSTS) {
  console.log(`\n${'='.repeat(66)}\n  ${host}\n${'='.repeat(66)}`);

  for (const svc of SERVICES) {
    const base = `https://${host}${svc.path}?sap-client=100`;
    console.log(`\n  ${svc.operation}`);

    const wsdl = await hit(`${base}&wsdl`, { headers: { Authorization: `Basic ${auth}` } });
    if (wsdl.status === null) {
      console.log(`    WSDL   fallo de red: ${wsdl.error}`);
    } else {
      const isWsdl = /<(wsdl:)?definitions/i.test(wsdl.body);
      const err = wsdl.body.match(/<errorText>([\s\S]*?)<\/errorText>/i)?.[1]?.trim();
      console.log(`    WSDL   HTTP ${wsdl.status} — ${isWsdl ? '*** WSDL VALIDO ***' : err ?? wsdl.body.slice(0, 80)}`);
    }

    const soap = await hit(base, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml;charset=UTF-8', SOAPAction: '""', Authorization: `Basic ${auth}` },
      body: envelope(svc),
    });
    if (soap.status === null) {
      console.log(`    SOAP   fallo de red: ${soap.error}`);
    } else {
      const ok = new RegExp(`${svc.operation}Response`, 'i').test(soap.body);
      const fault = soap.body.match(/<faultstring[^>]*>([\s\S]*?)<\/faultstring>/i)?.[1]?.trim();
      console.log(`    SOAP   HTTP ${soap.status} — ${ok ? '*** RESPUESTA CON DATOS ***' : fault?.slice(0, 90) ?? soap.body.slice(0, 90)}`);
      if (ok) console.log(`\n${soap.body}\n`);
    }
  }
}
