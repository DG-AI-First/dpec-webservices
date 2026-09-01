import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildEnvelope, escapeXml, assertWireName } from '../src/soap/envelope.js';
import type { WireField } from '../src/soap/types.js';

const NAMESPACE = 'urn:sap-com:document:sap:soap:functions:mc-style';

describe('buildEnvelope — exact-string match against the WSDL contract (live-verified HTTP 200)', () => {
  it('produces the ZWsSap002 envelope byte-for-byte as captured against QA', () => {
    // Shape taken from the QA WSDL (test/fixtures/ws002.wsdl.xml): the body
    // element is qualified in the mc-style namespace, and because the schema
    // declares no elementFormDefault (= unqualified), its children are bare.
    // Sending them prefixed produced HTTP 500 for months — see README.
    const expected = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="urn:sap-com:document:sap:soap:functions:mc-style">
  <soapenv:Header/>
  <soapenv:Body>
    <urn:ZWsSap002>
      <IAnlage>0010099044</IAnlage>
      <ICantfact>10</ICantfact>
      <IPartner>0010099046</IPartner>
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
    // Shape taken from the QA WSDL (test/fixtures/fica.wsdl.xml). Empty
    // fields render as open+close tags, never self-closed. PoDocumentos and
    // PoMensaje belong in the REQUEST too: mc-style puts the RFC's output
    // tables in the input element's sequence without minOccurs="0".
    const expected = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="urn:sap-com:document:sap:soap:functions:mc-style">
  <soapenv:Header/>
  <soapenv:Body>
    <urn:ZFicaDeudaIcUnif>
      <PiCc></PiCc>
      <PiFechaHasta></PiFechaHasta>
      <PiI></PiI>
      <PiIc>0010084434</PiIc>
      <PiNumMax>10</PiNumMax>
      <PoDocumentos></PoDocumentos>
      <PoMensaje></PoMensaje>
    </urn:ZFicaDeudaIcUnif>
  </soapenv:Body>
</soapenv:Envelope>`;

    const fields: WireField[] = [
      { name: 'PiCc', value: '' },
      { name: 'PiFechaHasta', value: '' },
      { name: 'PiI', value: '' },
      { name: 'PiIc', value: '0010084434' },
      { name: 'PiNumMax', value: '10' },
      { name: 'PoDocumentos', value: '' },
      { name: 'PoMensaje', value: '' },
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
    assert.ok(xml.includes('<IAnlage>Fulano &amp; Cia</IAnlage>'));
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
