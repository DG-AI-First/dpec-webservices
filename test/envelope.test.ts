import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildEnvelope, escapeXml, assertWireName } from '../src/soap/envelope.js';
import type { WireField } from '../src/soap/types.js';

const NAMESPACE = 'urn:sap-com:document:sap:soap:functions:mc-style';

describe('buildEnvelope — exact-string match against the WSDL contract (live-verified HTTP 200)', () => {
  it('produces the ZWsSap002 envelope byte-for-byte as captured against QA', () => {
    // Forma real del WSDL (test/fixtures/ws002.wsdl.xml): hijos del body sin
    // prefijo de namespace — ver soap/envelope.ts.
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
    // Forma real del WSDL (test/fixtures/fica.wsdl.xml). Campos vacíos se
    // serializan abiertos+cerrados, nunca auto-cerrados. PoDocumentos y
    // PoMensaje van también en el REQUEST — ver zFicaDeudaIcUnif.ts.
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

describe('assertWireName — widened for ZZCS_INFO_IC_WS UPPER_SNAKE wire names', () => {
  // ZZCS_INFO_IC_WS usa UPPER_SNAKE (ver zzcsInfoIcWs.wsdl.xml); los mc-style
  // usan PascalCase. El guard acepta ambos dialectos legítimos y sigue
  // rechazando el sufijo .NET y los guiones bajos mal puestos.

  it('still accepts PascalCase names (mc-style services)', () => {
    assert.doesNotThrow(() => assertWireName('PiIc'));
    assert.doesNotThrow(() => assertWireName('TFact'));
  });

  it('accepts UPPER_SNAKE names straight from the ZZCS WSDL', () => {
    for (const name of ['IN_NUMERO', 'IDNUMBER_DNI', 'OU_INFO_IC_WS', 'HOUSE_NUM1_IC', 'POST_CODE1_IN']) {
      assert.doesNotThrow(() => assertWireName(name), `expected "${name}" to be accepted`);
    }
  });

  it('still rejects the "Field" suffix and lowercase-initial names', () => {
    assert.throws(() => assertWireName('piIcField'), /\.NET proxy artifact/);
    assert.throws(() => assertWireName('tFact'), /PascalCase/);
  });

  it('rejects malformed underscore usage: leading, trailing, doubled', () => {
    for (const name of ['_LEADING', 'TRAILING_', 'DOUBLE__UNDERSCORE']) {
      assert.throws(() => assertWireName(name), /PascalCase/, `expected "${name}" to be rejected`);
    }
  });
});
