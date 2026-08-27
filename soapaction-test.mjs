// Rules out the last open doubt: is the HTTP 500 caused by OUR empty SOAPAction
// header, or by DPEC's missing service configuration? Tries every plausible value.
// QA only — never points at production.

const HOST = 'sapqas.dpec.com.ar';
const PATH = '/sap/bc/srt/rfc/sap/z_fica_deuda_ic_unif/100/z_fica_deuda_ic_unif/z_fica_deuda_ic_unif';
const NS = 'urn:sap-com:document:sap:rfc:functions';

const env = (k, d = '') => (process.env[k] ?? d).trim();
const auth = Buffer.from(`${env('SAP_USER')}:${process.env.SAP_PASSWORD ?? ''}`, 'utf8').toString('base64');

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="${NS}">
  <soapenv:Header/>
  <soapenv:Body>
    <urn:ZFicaDeudaIcUnif>
      <urn:PiCc></urn:PiCc>
      <urn:PiFechaHasta></urn:PiFechaHasta>
      <urn:PiI></urn:PiI>
      <urn:PiIc>0010084434</urn:PiIc>
      <urn:PiNumMax>10</urn:PiNumMax>
    </urn:ZFicaDeudaIcUnif>
  </soapenv:Body>
</soapenv:Envelope>`;

// null means: omit the header entirely — SAP sometimes rejects a present-but-empty one.
const VARIANTS = [
  ['omitido (sin header)', null],
  ['vacio ""', '""'],
  ['vacio sin comillas', ''],
  ['nombre de operacion', '"ZFicaDeudaIcUnif"'],
  ['urn completo', `"${NS}:ZFicaDeudaIcUnif"`],
  ['urn + Request', `"${NS}:ZFicaDeudaIcUnifRequest"`],
];

for (const [label, value] of VARIANTS) {
  const headers = {
    'Content-Type': 'text/xml;charset=UTF-8',
    Authorization: `Basic ${auth}`,
  };
  if (value !== null) headers.SOAPAction = value;

  try {
    const res = await fetch(`https://${HOST}${PATH}?sap-client=100`, {
      method: 'POST', headers, body: xml, signal: AbortSignal.timeout(20000),
    });
    const body = await res.text();
    const fault = body.match(/<faultstring[^>]*>([\s\S]*?)<\/faultstring>/i)?.[1]?.trim() ?? '';
    // A fault that names SOAPAction would mean the header IS the problem.
    const mentionsAction = /soapaction|action/i.test(fault);
    const ok = /ZFicaDeudaIcUnifResponse/i.test(body);

    console.log(`\n  ${label.padEnd(24)} HTTP ${res.status}`);
    if (ok) console.log(`    >>> RESPUESTA VALIDA <<<`);
    else if (fault) console.log(`    fault: ${fault.slice(0, 110)}${mentionsAction ? '   [MENCIONA ACTION]' : ''}`);
    else console.log(`    sin fault, ${body.length} bytes`);
  } catch (e) {
    console.log(`\n  ${label.padEnd(24)} FALLO: ${e.cause?.code ?? e.message}`);
  }
}
