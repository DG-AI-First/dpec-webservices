import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ParseError } from '../src/errors.js';
import { parseXml, toArray, findFault, unwrapBody } from '../src/soap/parser.js';

// ---------------------------------------------------------------------------
// toArray — the array-coercion trap (design §3(C)). This is the single most
// likely silent bug in this codebase: XML collapses a repeated element to a
// scalar when there's exactly one occurrence, and (as discovered empirically
// while writing this suite) fast-xml-parser's `isArray` allowlist coerces a
// SELF-CLOSED table element into a ONE-ELEMENT array containing an empty
// string/object sentinel — NOT an empty array. toArray must flatten both
// the sentinel case AND the item-wrapped case, whether or not the value
// already arrived as an array.
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

  it('empty object -> [] (<tFact></tFact>, element not in the isArray allowlist)', () => {
    assert.deepEqual(toArray({}), []);
  });

  it('[""] -> [] (self-closed tag, element IS in the isArray allowlist — the gotcha)', () => {
    assert.deepEqual(toArray(['']), []);
  });

  it('[{}] -> [] (empty-tag-in-array variant of the same gotcha)', () => {
    assert.deepEqual(toArray([{}]), []);
  });

  it('a single scalar object -> one-element array', () => {
    assert.deepEqual(toArray({ eAnlage: '1' }), [{ eAnlage: '1' }]);
  });

  it('a flat array of 3 rows -> unchanged, length 3', () => {
    const rows = [{ eAnlage: '1' }, { eAnlage: '2' }, { eAnlage: '3' }];
    assert.deepEqual(toArray(rows), rows);
  });

  it('item-wrapped single value ({item: [...]}) unwraps to the inner rows', () => {
    const wrapped = { item: [{ eAnlage: '1' }, { eAnlage: '2' }] };
    assert.deepEqual(toArray(wrapped), [{ eAnlage: '1' }, { eAnlage: '2' }]);
  });

  it('item-wrapped-inside-array ([{item: [...]}]) unwraps to the inner rows (the real SAP shape)', () => {
    // This is the actual shape fast-xml-parser produces for a single
    // <tFact><item>...</item><item>...</item></tFact> container when
    // 'tFact' is itself in the isArray allowlist.
    const wrapped = [{ item: [{ eAnlage: '1' }, { eAnlage: '2' }] }];
    assert.deepEqual(toArray(wrapped), [{ eAnlage: '1' }, { eAnlage: '2' }]);
  });
});

// ---------------------------------------------------------------------------
// End-to-end through the real XMLParser instance, exercising the isArray
// allowlist + toArray together — this is what actually runs in production.
// ---------------------------------------------------------------------------
describe('toArray — integration through parseXml (real fast-xml-parser output)', () => {
  function tFactRows(xml: string): unknown[] {
    const node = parseXml(xml) as any;
    return toArray(node.Envelope.Body.ZWsSap002Response.tFact);
  }

  it('0 rows: self-closed <tFact/>', () => {
    const xml =
      '<Envelope><Body><ZWsSap002Response><tFact/></ZWsSap002Response></Body></Envelope>';
    assert.equal(tFactRows(xml).length, 0);
  });

  it('0 rows: empty <tFact></tFact>', () => {
    const xml =
      '<Envelope><Body><ZWsSap002Response><tFact></tFact></ZWsSap002Response></Body></Envelope>';
    assert.equal(tFactRows(xml).length, 0);
  });

  it('1 row: single <tFact>', () => {
    const xml =
      '<Envelope><Body><ZWsSap002Response><tFact><eAnlage>1</eAnlage></tFact></ZWsSap002Response></Body></Envelope>';
    assert.equal(tFactRows(xml).length, 1);
  });

  it('3 rows: flat, repeated <tFact> siblings', () => {
    const xml = `<Envelope><Body><ZWsSap002Response>
      <tFact><eAnlage>1</eAnlage></tFact>
      <tFact><eAnlage>2</eAnlage></tFact>
      <tFact><eAnlage>3</eAnlage></tFact>
    </ZWsSap002Response></Body></Envelope>`;
    assert.equal(tFactRows(xml).length, 3);
  });

  it('3 rows: item-wrapped RFC table variant', () => {
    const xml = `<Envelope><Body><ZWsSap002Response>
      <tFact>
        <item><eAnlage>1</eAnlage></item>
        <item><eAnlage>2</eAnlage></item>
        <item><eAnlage>3</eAnlage></item>
      </tFact>
    </ZWsSap002Response></Body></Envelope>`;
    assert.equal(tFactRows(xml).length, 3);
  });

  it('1 row: item-wrapped with a single <item>', () => {
    const xml = `<Envelope><Body><ZWsSap002Response>
      <tFact><item><eAnlage>1</eAnlage></item></tFact>
    </ZWsSap002Response></Body></Envelope>`;
    assert.equal(tFactRows(xml).length, 1);
  });
});

// ---------------------------------------------------------------------------
// Namespace resilience — removeNSPrefix must make n0:, SOAP-ENV:, and bare
// envelopes parse identically. Also: leading zeros and decimal strings must
// survive untouched (parseTagValue: false).
// ---------------------------------------------------------------------------
describe('namespace and value-fidelity resilience', () => {
  const bodyFor = (prefix: string, close = prefix) => `
    <${prefix}Envelope xmlns:${prefix.replace(':', '')}="http://schemas.xmlsoap.org/soap/envelope/">
      <${prefix}Body>
        <ZWsSap002Response>
          <exbel>0090001234</exbel>
          <totalAmnt>1234.50</totalAmnt>
        </ZWsSap002Response>
      </${prefix}Body>
    </${close}Envelope>`;

  it('n0: prefix', () => {
    const node = parseXml(bodyFor('n0:')) as any;
    assert.equal(node.Envelope.Body.ZWsSap002Response.exbel, '0090001234');
  });

  it('SOAP-ENV: prefix', () => {
    const node = parseXml(bodyFor('SOAP-ENV:')) as any;
    assert.equal(node.Envelope.Body.ZWsSap002Response.exbel, '0090001234');
  });

  it('bare, no prefix', () => {
    const node = parseXml(bodyFor('')) as any;
    assert.equal(node.Envelope.Body.ZWsSap002Response.exbel, '0090001234');
  });

  it('exbel with leading zeros survives as a string, not coerced to a number', () => {
    const node = parseXml(bodyFor('')) as any;
    assert.equal(typeof node.Envelope.Body.ZWsSap002Response.exbel, 'string');
    assert.equal(node.Envelope.Body.ZWsSap002Response.exbel, '0090001234');
  });

  it('totalAmnt decimal survives as a string, round-trips exactly', () => {
    const node = parseXml(bodyFor('')) as any;
    assert.equal(typeof node.Envelope.Body.ZWsSap002Response.totalAmnt, 'string');
    assert.equal(node.Envelope.Body.ZWsSap002Response.totalAmnt, '1234.50');
  });
});

// ---------------------------------------------------------------------------
// SOAP Fault detection — both prefixes, and the REAL captured fault from QA
// (genuine wire data, HTTP 500). This confirms the HTTP-500-carries-a-fault
// ordering requirement is real, not theoretical.
// ---------------------------------------------------------------------------
describe('findFault', () => {
  it('detects a fault under the real captured soap-env: prefix (genuine QA wire data)', () => {
    // Verbatim from the live QA fault (facturas + deuda spikes, both identical).
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
    const raw = '<Envelope><Body><ZWsSap002Response><tFact/></ZWsSap002Response></Body></Envelope>';
    assert.equal(findFault(parseXml(raw)), null);
  });
});

// ---------------------------------------------------------------------------
// Malformed / non-XML / non-SOAP bodies must never crash uncaught.
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
    // Real shape observed on a `?wsdl` GET: HTTP 200 with this body. A client
    // checking only the status code would call this success.
    const raw =
      '<error><user>WSMICTS</user><errorText>WSP Exception caught: something</errorText>' +
      '<bindingKey>x</bindingKey></error>';
    const node = parseXml(raw); // well-formed XML, does not throw here
    assert.equal(findFault(node), null); // no SOAP Fault either
    assert.throws(() => unwrapBody(node, 'ZWsSap002'), ParseError);
  });
});

// ---------------------------------------------------------------------------
// unwrapBody — response element name resilience.
// ---------------------------------------------------------------------------
describe('unwrapBody', () => {
  it('finds the exact ${operationName}Response element', () => {
    const raw = '<Envelope><Body><ZWsSap002Response><tFact/></ZWsSap002Response></Body></Envelope>';
    const { node, responseElementMismatch } = unwrapBody(parseXml(raw), 'ZWsSap002');
    assert.ok(node);
    assert.equal(responseElementMismatch, undefined);
  });

  it('falls back to the single non-Fault key and records the mismatch', () => {
    const raw = '<Envelope><Body><UnexpectedName><tFact/></UnexpectedName></Body></Envelope>';
    const { responseElementMismatch } = unwrapBody(parseXml(raw), 'ZWsSap002');
    assert.equal(responseElementMismatch, 'UnexpectedName');
  });

  it('throws ParseError when the Body has no usable single key', () => {
    const raw = '<Envelope><Body></Body></Envelope>';
    assert.throws(() => unwrapBody(parseXml(raw), 'ZWsSap002'), ParseError);
  });
});
