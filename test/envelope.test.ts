import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildEnvelope, escapeXml, assertWireName } from '../src/soap/envelope.js';
import type { WireField } from '../src/soap/types.js';

const NAMESPACE = 'urn:sap-com:document:sap:rfc:functions';

describe('buildEnvelope — exact-string match against live-captured wire evidence', () => {
  it('produces the ZWsSap002 envelope byte-for-byte as captured against QA', () => {
    // Verbatim from evidence/spike-2026-08-27T01-38-39-308Z/facturas.request.xml —
    // this envelope was accepted by SAP (fault came from unconfigured binding,
    // not a parse/format rejection), so it is our known-good reference.
    const expected = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="urn:sap-com:document:sap:rfc:functions">
  <soapenv:Header/>
  <soapenv:Body>
    <urn:ZWsSap002>
      <urn:IAnlage>0010099044</urn:IAnlage>
      <urn:ICantfact>10</urn:ICantfact>
      <urn:IPartner>0010099046</urn:IPartner>
    </urn:ZWsSap002>
  </soapenv:Body>
</soapenv:Envelope>`;

    const fields: WireField[] = [
      { name: 'IAnlage', value: '0010099044' },
      { name: 'ICantfact', value: '10' },
      { name: 'IPartner', value: '0010099046' },
    ];

    const actual = buildEnvelope(
      { operationName: 'ZWsSap002', namespace: NAMESPACE },
      fields,
    );

    assert.equal(actual, expected);
  });

  it('produces the ZFicaDeudaIcUnif envelope byte-for-byte as captured against QA', () => {
    // Verbatim from evidence/spike-2026-08-27T01-39-07-793Z/deuda.request.xml.
    // Note empty fields render as open+close tags, never self-closed.
    const expected = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="urn:sap-com:document:sap:rfc:functions">
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

    const fields: WireField[] = [
      { name: 'PiCc', value: '' },
      { name: 'PiFechaHasta', value: '' },
      { name: 'PiI', value: '' },
      { name: 'PiIc', value: '0010084434' },
      { name: 'PiNumMax', value: '10' },
    ];

    const actual = buildEnvelope(
      { operationName: 'ZFicaDeudaIcUnif', namespace: NAMESPACE },
      fields,
    );

    assert.equal(actual, expected);
  });
});

describe('escapeXml', () => {
  it('escapes & < > " \' so a value can never break the envelope', () => {
    assert.equal(escapeXml(`A & B < C > "D" 'E'`), 'A &amp; B &lt; C &gt; &quot;D&quot; &apos;E&apos;');
  });

  it('an unescaped ampersand in a field value comes out escaped end-to-end', () => {
    const xml = buildEnvelope(
      { operationName: 'ZWsSap002', namespace: NAMESPACE },
      [{ name: 'IAnlage', value: 'Fulano & Cia' }],
    );
    assert.ok(xml.includes('<urn:IAnlage>Fulano &amp; Cia</urn:IAnlage>'));
    assert.ok(!xml.includes('Fulano & Cia'));
  });
});

describe('assertWireName — the .NET-proxy-artifact guard', () => {
  it('rejects names ending in "Field" with a message naming the actual bug', () => {
    assert.throws(() => assertWireName('piIcField'), /\.NET proxy artifact/);
  });

  it('rejects a lowercase-initial name', () => {
    assert.throws(() => assertWireName('piIc'), /PascalCase/);
  });

  it('accepts a proper PascalCase wire name', () => {
    assert.doesNotThrow(() => assertWireName('PiIc'));
  });

  it('buildEnvelope refuses to serialize a "Field"-suffixed name', () => {
    assert.throws(
      () =>
        buildEnvelope(
          { operationName: 'ZFicaDeudaIcUnif', namespace: NAMESPACE },
          [{ name: 'piIcField', value: 'x' }],
        ),
      /\.NET proxy artifact/,
    );
  });
});
