// Test de integración del server HTTP: node:http real contra un puerto
// efímero, con un stub SOAP también de node:http (misma técnica que
// test/exit-contract.test.ts usa para su stub). Sin red real.
//
// callOperationLive.ts no tiene test unitario propio (mismo criterio que
// soap/transport.ts: es la capa de I/O) -- se ejerce acá, en vivo contra el stub.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';

// Response.json() de Node tipa Promise<unknown> a propósito; estos tests
// sólo necesitan leer el shape esperado, no validarlo estructuralmente.
async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

interface ErrorBody {
  readonly error: { readonly codigo: string; readonly mensaje: string };
}
interface HealthBody {
  readonly status: string;
}
interface DeudaOkBody {
  readonly partner: string;
  readonly documentos: ReadonlyArray<{ readonly betrw: string }>;
}
interface FacturasOkBody {
  readonly partner: string;
  readonly facturas: readonly unknown[];
}

import { Secret } from '../src/config.js';
import { makeLiveOperationCaller, type LiveCallerConfig } from '../src/http/callOperationLive.js';
import { createRequestListener } from '../src/http/router.js';

function xmlResponse(operationName: string, bodyXml: string): string {
  return (
    '<soap-env:Envelope xmlns:soap-env="http://schemas.xmlsoap.org/soap/envelope/">' +
    `<soap-env:Body><${operationName}Response>${bodyXml}</${operationName}Response></soap-env:Body>` +
    '</soap-env:Envelope>'
  );
}

const ZZCS_ROW =
  '<item><PARTNER>0030002708</PARTNER><TYPE>BUP001</TYPE><IDNUMBER_DNI>30955882</IDNUMBER_DNI>' +
  '<IDNUMBER_CUIT></IDNUMBER_CUIT><IDNUMBER_CUIL></IDNUMBER_CUIL><IDNUMBER_CI></IDNUMBER_CI>' +
  '<IDNUMBER_OTR></IDNUMBER_OTR><NAME1_TEXT></NAME1_TEXT><STREET_IC></STREET_IC>' +
  '<HOUSE_NUM1_IC></HOUSE_NUM1_IC><FLOOR_IC></FLOOR_IC><ROOMNUMBER_IC></ROOMNUMBER_IC>' +
  '<CITY1_IC></CITY1_IC><POST_CODE1_IC></POST_CODE1_IC><ANLAGE>0060002445</ANLAGE>' +
  '<TARIFTYP></TARIFTYP><EQUNR></EQUNR><GERNR></GERNR><ABLEINH></ABLEINH><STREET_IN></STREET_IN>' +
  '<HOUSE_NUM1_IN></HOUSE_NUM1_IN><FLOOR_IN></FLOOR_IN><ROOMNUMBER_IN></ROOMNUMBER_IN>' +
  '<CITY1_IN></CITY1_IN><POST_CODE1_IN></POST_CODE1_IN><EINZDAT></EINZDAT><AUSZDAT></AUSZDAT>' +
  '<STATUS></STATUS><FACT_ADEUDADAS></FACT_ADEUDADAS><DEUDA></DEUDA><DISC_STATUS></DISC_STATUS>' +
  '<SMTP_ADDR></SMTP_ADDR><TEL_NUMBER></TEL_NUMBER><MOB_NUMBER></MOB_NUMBER><EQFNR></EQFNR>' +
  '<LOCKREASON></LOCKREASON><DESCRIPCION></DESCRIPCION></item>';

/** Decide la respuesta canned según el endpointPath que golpea cada operación (ver services/*.ts). */
function stubResponseFor(url: string, mode: 'ok' | 'no-encontrado' | 'rechazado' | 'e9011' | 'hang'): string | null {
  if (url.includes('zzcs_info_ic_ws')) {
    if (mode === 'no-encontrado') return xmlResponse('ZZCS_INFO_IC_WS', '<OU_INFO_IC_WS/><OU_RESULTADO>0</OU_RESULTADO>');
    if (mode === 'rechazado') return xmlResponse('ZZCS_INFO_IC_WS', '<OU_INFO_IC_WS/><OU_RESULTADO>99</OU_RESULTADO>');
    if (mode === 'hang') return null; // nunca responde: dispara el deadline propio del server
    return xmlResponse('ZZCS_INFO_IC_WS', `<OU_INFO_IC_WS>${ZZCS_ROW}</OU_INFO_IC_WS><OU_RESULTADO>0</OU_RESULTADO>`);
  }
  if (url.includes('z_fica_deuda_ic_unif')) {
    return xmlResponse(
      'ZFicaDeudaIcUnif',
      '<PoDocumentos><item><Budat>20260101</Budat><Faedn>20260201</Faedn><Xblnr>1</Xblnr>' +
        '<Ltext>Factura</Ltext><Betrw>26.58</Betrw><TotalAmnt>26.58</TotalAmnt><CodBarraVisual></CodBarraVisual></item>' +
        '</PoDocumentos><PoMensaje/>',
    );
  }
  if (url.includes('z_ws_sap_002')) {
    if (mode === 'e9011') return xmlResponse('ZWsSap002', '<EMsgnro>E9011</EMsgnro><EMsgtxt>Instalación desconectada</EMsgtxt><TFact/>');
    return xmlResponse(
      'ZWsSap002',
      '<EMsgnro>000</EMsgnro><EMsgtxt>OK</EMsgtxt><TFact><item><Opbel>1</Opbel><Exbel>e1</Exbel>' +
        '<Faedn>20260201</Faedn><TotalAmnt>10.00</TotalAmnt></item></TFact>',
    );
  }
  return null;
}

function startStub(mode: 'ok' | 'no-encontrado' | 'rechazado' | 'e9011' | 'hang'): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const body = stubResponseFor(req.url ?? '', mode);
      if (body === null) return; // hang: nunca contesta, simula el RFC colgado (ver hallazgos-tecnicos.md)
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, port });
    });
  });
}

function buildConfig(port: number): LiveCallerConfig {
  return {
    scheme: 'http',
    host: `127.0.0.1:${port}`,
    sapClient: '100',
    user: 'wsuser',
    password: new Secret('wspass'),
    basicAuthCharset: 'utf8',
    timeoutMs: 10_000,
    tls: { mode: 'default' },
  };
}

async function withServer(
  mode: 'ok' | 'no-encontrado' | 'rechazado' | 'e9011' | 'hang',
  deadlineMs: number,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const stub = await startStub(mode);
  const call = makeLiveOperationCaller(buildConfig(stub.port));
  const listener = createRequestListener({ call, deadlineMs });
  const server = createServer((req, res) => {
    void listener(req, res);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const appPort = typeof address === 'object' && address ? address.port : 0;

  try {
    await fn(`http://127.0.0.1:${appPort}`);
  } finally {
    stub.server.closeAllConnections();
    server.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => stub.server.close(() => resolve())),
      new Promise<void>((resolve) => server.close(() => resolve())),
    ]);
  }
}

describe('GET /health', () => {
  it('responde 200 sin tocar el upstream SOAP', async () => {
    const call = (async () => {
      throw new Error('el health check nunca debe invocar al upstream');
    }) as never;
    const listener = createRequestListener({ call, deadlineMs: 1000 });
    const server = createServer((req, res) => {
      void listener(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(res.status, 200);
      const body = await readJson<HealthBody>(res);
      assert.equal(body.status, 'ok');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('GET /api/deuda', () => {
  it('200: cadena completa DNI -> PARTNER -> documentos', async () => {
    await withServer('ok', 5000, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/deuda?dni=30955882`);
      assert.equal(res.status, 200);
      const body = await readJson<DeudaOkBody>(res);
      assert.equal(body.partner, '0030002708');
      assert.equal(body.documentos.length, 1);
      assert.equal(body.documentos[0]?.betrw, '26.58');
    });
  });

  it('400: dni ausente', async () => {
    await withServer('ok', 5000, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/deuda`);
      assert.equal(res.status, 400);
      const body = await readJson<ErrorBody>(res);
      assert.equal(body.error.codigo, 'DNI_INVALIDO');
    });
  });

  it('404: DNI sin filas (SAP respondió, no encontrado)', async () => {
    await withServer('no-encontrado', 5000, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/deuda?dni=99999999`);
      assert.equal(res.status, 404);
    });
  });

  it('502: OU_RESULTADO rechazado por ZZCS', async () => {
    await withServer('rechazado', 5000, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/deuda?dni=1`);
      assert.equal(res.status, 502);
      const body = await readJson<ErrorBody>(res);
      assert.equal(body.error.codigo, '99');
    });
  });

  it('504: SAP cuelga (DNI inexistente cuelga ZZCS, ver hallazgos-tecnicos.md) -- deadline propio del server, no el del cliente SOAP', async () => {
    await withServer('hang', 200, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/deuda?dni=1`);
      assert.equal(res.status, 504);
    });
  });

  it('404: ruta desconocida', async () => {
    await withServer('ok', 5000, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/no-existe`);
      assert.equal(res.status, 404);
    });
  });
});

describe('GET /api/facturas', () => {
  it('200: cadena completa DNI -> PARTNER/ANLAGE -> facturas', async () => {
    await withServer('ok', 5000, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/facturas?dni=30955882`);
      assert.equal(res.status, 200);
      const body = await readJson<FacturasOkBody>(res);
      assert.equal(body.partner, '0030002708');
      assert.equal(body.facturas.length, 1);
    });
  });

  it('409: E9011 (cliente desconectado) -- codigo/mensaje verbatim, no un 502 genérico', async () => {
    await withServer('e9011', 5000, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/facturas?dni=30955882`);
      assert.equal(res.status, 409);
      const body = await readJson<ErrorBody>(res);
      assert.equal(body.error.codigo, 'E9011');
      assert.equal(body.error.mensaje, 'Instalación desconectada');
    });
  });
});
