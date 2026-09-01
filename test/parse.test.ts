import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ParseError } from '../src/errors.js';
import { parseXml, toArray, findFault, unwrapBody } from '../src/soap/parser.js';

// ---------------------------------------------------------------------------
// toArray: la trampa de coerción de arrays. fast-xml-parser colapsa un
// elemento repetido a escalar si aparece una sola vez, y coerciona un
// elemento auto-cerrado en el allowlist isArray a [''] en vez de [].
// Detalle: docs/hallazgos-tecnicos.md#la-trampa-de-coercion-de-arrays-array-coercion-trap
// ---------------------------------------------------------------------------
describe('toArray — direct unit cases', () => {
  it('undefined -> []', () => {
    assert.deepEqual(toArray(undefined), []);
  });

  it('null -> []', () => {
    assert.deepEqual(toArray(null), []);
  });

  it('empty string -> [] (self-closed tag, element not in the isArray allowlist)', () => {
    assert.deepEqual(toArray(''), []);
  });

  it('empty object -> [] (<TFact></TFact>, element not in the isArray allowlist)', () => {
    assert.deepEqual(toArray({}), []);
  });

  it('[""] -> [] (self-closed tag, element IS in the isArray allowlist — the gotcha)', () => {
    assert.deepEqual(toArray(['']), []);
  });

  it('[{}] -> [] (empty-tag-in-array variant of the same gotcha)', () => {
    assert.deepEqual(toArray([{}]), []);
  });

  it('a single scalar object -> one-element array', () => {
    assert.deepEqual(toArray({ Opbel: '1' }), [{ Opbel: '1' }]);
  });

  it('a flat array of 3 rows -> unchanged, length 3', () => {
    const rows = [{ Opbel: '1' }, { Opbel: '2' }, { Opbel: '3' }];
    assert.deepEqual(toArray(rows), rows);
  });

  it('item-wrapped single value ({item: [...]}) unwraps to the inner rows', () => {
    const wrapped = { item: [{ Opbel: '1' }, { Opbel: '2' }] };
    assert.deepEqual(toArray(wrapped), [{ Opbel: '1' }, { Opbel: '2' }]);
  });

  it('item-wrapped-inside-array ([{item: [...]}]) unwraps to the inner rows (the real SAP shape)', () => {
    // Forma real que produce fast-xml-parser para un único
    // <TFact><item>...</item>...</TFact> cuando TFact está en el allowlist isArray.
    const wrapped = [{ item: [{ Opbel: '1' }, { Opbel: '2' }] }];
    assert.deepEqual(toArray(wrapped), [{ Opbel: '1' }, { Opbel: '2' }]);
  });
});

// ---------------------------------------------------------------------------
// End-to-end con la instancia real de XMLParser: lo que corre en producción.
// ---------------------------------------------------------------------------
describe('toArray — integration through parseXml (real fast-xml-parser output)', () => {
  function tFactRows(xml: string): unknown[] {
    const node = parseXml(xml) as any;
    return toArray(node.Envelope.Body.ZWsSap002Response.TFact);
  }

  it('0 rows: self-closed <TFact/>', () => {
    const xml =
      '<Envelope><Body><ZWsSap002Response><TFact/></ZWsSap002Response></Body></Envelope>';
    assert.equal(tFactRows(xml).length, 0);
  });

  it('0 rows: empty <TFact></TFact>', () => {
    const xml =
      '<Envelope><Body><ZWsSap002Response><TFact></TFact></ZWsSap002Response></Body></Envelope>';
    assert.equal(tFactRows(xml).length, 0);
  });

  it('1 row: single <TFact>', () => {
    const xml =
      '<Envelope><Body><ZWsSap002Response><TFact><Opbel>1</Opbel></TFact></ZWsSap002Response></Body></Envelope>';
    assert.equal(tFactRows(xml).length, 1);
  });

  it('3 rows: flat, repeated <TFact> siblings', () => {
    const xml = `<Envelope><Body><ZWsSap002Response>
      <TFact><Opbel>1</Opbel></TFact>
      <TFact><Opbel>2</Opbel></TFact>
      <TFact><Opbel>3</Opbel></TFact>
    </ZWsSap002Response></Body></Envelope>`;
    assert.equal(tFactRows(xml).length, 3);
  });

  it('3 rows: item-wrapped RFC table variant', () => {
    const xml = `<Envelope><Body><ZWsSap002Response>
      <TFact>
        <item><Opbel>1</Opbel></item>
        <item><Opbel>2</Opbel></item>
        <item><Opbel>3</Opbel></item>
      </TFact>
    </ZWsSap002Response></Body></Envelope>`;
    assert.equal(tFactRows(xml).length, 3);
  });

  it('1 row: item-wrapped with a single <item>', () => {
    const xml = `<Envelope><Body><ZWsSap002Response>
      <TFact><item><Opbel>1</Opbel></item></TFact>
    </ZWsSap002Response></Body></Envelope>`;
    assert.equal(tFactRows(xml).length, 1);
  });
});

// ---------------------------------------------------------------------------
// removeNSPrefix debe dar el mismo resultado con n0:, SOAP-ENV: y sin
// prefijo. Ceros a la izquierda y decimales deben sobrevivir intactos.
// ---------------------------------------------------------------------------
describe('namespace and value-fidelity resilience', () => {
  const bodyFor = (prefix: string, close = prefix) => `
    <${prefix}Envelope xmlns:${prefix.replace(':', '')}="http://schemas.xmlsoap.org/soap/envelope/">
      <${prefix}Body>
        <ZWsSap002Response>
          <Exbel>0090001234</Exbel>
          <TotalAmnt>1234.50</TotalAmnt>
        </ZWsSap002Response>
      </${prefix}Body>
    </${close}Envelope>`;

  it('n0: prefix', () => {
    const node = parseXml(bodyFor('n0:')) as any;
    assert.equal(node.Envelope.Body.ZWsSap002Response.Exbel, '0090001234');
  });

  it('SOAP-ENV: prefix', () => {
    const node = parseXml(bodyFor('SOAP-ENV:')) as any;
    assert.equal(node.Envelope.Body.ZWsSap002Response.Exbel, '0090001234');
  });

  it('bare, no prefix', () => {
    const node = parseXml(bodyFor('')) as any;
    assert.equal(node.Envelope.Body.ZWsSap002Response.Exbel, '0090001234');
  });

  it('Exbel with leading zeros survives as a string, not coerced to a number', () => {
    const node = parseXml(bodyFor('')) as any;
    assert.equal(typeof node.Envelope.Body.ZWsSap002Response.Exbel, 'string');
    assert.equal(node.Envelope.Body.ZWsSap002Response.Exbel, '0090001234');
  });

  it('TotalAmnt decimal survives as a string, round-trips exactly', () => {
    const node = parseXml(bodyFor('')) as any;
    assert.equal(typeof node.Envelope.Body.ZWsSap002Response.TotalAmnt, 'string');
    assert.equal(node.Envelope.Body.ZWsSap002Response.TotalAmnt, '1234.50');
  });
});

// ---------------------------------------------------------------------------
// Detección de Fault SOAP, con el fault real capturado en QA (HTTP 500) que
// confirma que el orden fault-antes-que-status no es teórico.
// ---------------------------------------------------------------------------
describe('findFault', () => {
  it('detects a fault under the real captured soap-env: prefix (genuine QA wire data)', () => {
    // Verbatim del fault real de QA (spikes de facturas y deuda, idéntico).
    const raw =
      '<soap-env:Envelope xmlns:soap-env="http://schemas.xmlsoap.org/soap/envelope/">' +
      '<soap-env:Header/><soap-env:Body><soap-env:Fault>' +
      '<faultcode>soap-env:Server</faultcode>' +
      '<faultstring xml:lang="es">Error en el tratamiento de servicio web; ' +
      'Más detalles en log de error de servicio web en la página de proveedor ' +
      '(Cronomarcador UTC 20260827013841; ID de transacción 386BDE44326A0040E006A6F8652D99A4)</faultstring>' +
      '<detail/></soap-env:Fault></soap-env:Body></soap-env:Envelope>';

    const node = parseXml(raw);
    const fault = findFault(node);
    assert.ok(fault);
    assert.equal(fault?.faultCode, 'soap-env:Server');
    assert.match(fault?.faultString ?? '', /Error en el tratamiento de servicio web/);
  });

  it('detects a fault under SOAP-ENV: (uppercase prefix)', () => {
    const raw =
      '<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">' +
      '<SOAP-ENV:Body><SOAP-ENV:Fault><faultcode>SOAP-ENV:Server</faultcode>' +
      '<faultstring>boom</faultstring></SOAP-ENV:Fault></SOAP-ENV:Body></SOAP-ENV:Envelope>';
    const fault = findFault(parseXml(raw));
    assert.equal(fault?.faultCode, 'SOAP-ENV:Server');
    assert.equal(fault?.faultString, 'boom');
  });

  it('returns null when there is no fault', () => {
    const raw = '<Envelope><Body><ZWsSap002Response><TFact/></ZWsSap002Response></Body></Envelope>';
    assert.equal(findFault(parseXml(raw)), null);
  });
});

// ---------------------------------------------------------------------------
// Cuerpos malformados/no-XML/no-SOAP nunca deben crashear sin control.
// ---------------------------------------------------------------------------
describe('malformed and non-SOAP bodies', () => {
  it('plain text (not XML at all) -> ParseError', () => {
    assert.throws(() => parseXml('Internal Server Error'), ParseError);
  });

  it('unclosed/mismatched tags -> ParseError', () => {
    assert.throws(() => parseXml('<soap:Envelope><soap:Body><foo></soap:Body></soap:Envelope>'), ParseError);
  });

  it('empty body -> ParseError', () => {
    assert.throws(() => parseXml(''), ParseError);
  });

  it('well-formed but non-SOAP XML (SAP proprietary <error> on HTTP 200) parses, but unwrapBody rejects it', () => {
    // Forma real observada en un GET ?wsdl: HTTP 200 con este body. Un
    // cliente que sólo mira el status lo tomaría como éxito. El <user> real
    // que devolvía SAP se reemplazó: es media credencial y el test no lo usa.
    const raw =
      '<error><user>USUARIO</user><errorText>WSP Exception caught: something</errorText>' +
      '<bindingKey>x</bindingKey></error>';
    const node = parseXml(raw); // XML bien formado, no tira acá
    assert.equal(findFault(node), null); // tampoco hay Fault SOAP
    assert.throws(() => unwrapBody(node, 'ZWsSap002'), ParseError);
  });
});

// ---------------------------------------------------------------------------
// unwrapBody: resiliencia del nombre del elemento de respuesta.
// ---------------------------------------------------------------------------
describe('unwrapBody', () => {
  it('finds the exact ${operationName}Response element', () => {
    const raw = '<Envelope><Body><ZWsSap002Response><TFact/></ZWsSap002Response></Body></Envelope>';
    const { node, responseElementMismatch } = unwrapBody(parseXml(raw), 'ZWsSap002');
    assert.ok(node);
    assert.equal(responseElementMismatch, undefined);
  });

  it('falls back to the single non-Fault key and records the mismatch', () => {
    const raw = '<Envelope><Body><UnexpectedName><TFact/></UnexpectedName></Body></Envelope>';
    const { responseElementMismatch } = unwrapBody(parseXml(raw), 'ZWsSap002');
    assert.equal(responseElementMismatch, 'UnexpectedName');
  });

  it('throws ParseError when the Body has no usable single key', () => {
    const raw = '<Envelope><Body></Body></Envelope>';
    assert.throws(() => unwrapBody(parseXml(raw), 'ZWsSap002'), ParseError);
  });
});
