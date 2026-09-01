// Unit tests for src/services/zWsSap002.ts — see design §1 (services/ know
// nothing about fetch/TLS/files/console, so parseResult/summarize are pure
// functions, 100% unit-testable with zero mocking).
//
// Wire names below come from the QA WSDL, promoted to test/fixtures/ws002.wsdl.xml.
// They are PascalCase, and `removeNSPrefix` does NOT change case — reading
// `responseNode.tFact` when the wire says `TFact` yields undefined, which
// toArray() turns into a perfectly plausible empty result. That silent
// wrong answer is exactly what these names exist to prevent.
//
// The row type is ZsficaFacturas :: Opbel, Exbel, Faedn, TotalAmnt. There is
// no EAnlage — an earlier reconstruction from DPEC's PDF invented one.
//
// HONEST CONSTRAINT: still no real successful ZWsSap002 response. With empty
// IAnlage/IPartner the RFC runs past DPEC's 60s nginx timeout (HTTP 504), so
// exercising it needs QA test data from DPEC. Promote a real response here
// the moment one arrives.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseXml, unwrapBody } from '../src/soap/parser.js';
import { buildFields, parseResult, summarize } from '../src/services/zWsSap002.js';

describe('zWsSap002.buildFields', () => {
  it('emits IAnlage, ICantfact, IPartner in WSDL sequence order', () => {
    const fields = buildFields({ iAnlage: '0010099044', iCantfact: '10', iPartner: '0010099046' });
    assert.deepEqual(fields, [
      { name: 'IAnlage', value: '0010099044' },
      { name: 'ICantfact', value: '10' },
      { name: 'IPartner', value: '0010099046' },
    ]);
  });

  it('does NOT emit TFact: unlike ZFicaDeudaIcUnif, the ZWsSap002 input element has no output table', () => {
    const names = buildFields({ iAnlage: '', iCantfact: '10', iPartner: '' }).map((f) => f.name);
    assert.deepEqual(names, ['IAnlage', 'ICantfact', 'IPartner']);
  });
});

describe('zWsSap002.parseResult — PascalCase wire names, TFact row counts', () => {
  function parse(bodyXml: string) {
    const raw = `<Envelope><Body><ZWsSap002Response>${bodyXml}</ZWsSap002Response></Body></Envelope>`;
    const { node } = unwrapBody(parseXml(raw), 'ZWsSap002');
    return parseResult(node);
  }

  it('0 rows: self-closed <TFact/>, EMsgnro/EMsgtxt present', () => {
    const out = parse('<EMsgnro>000</EMsgnro><EMsgtxt>OK</EMsgtxt><TFact/>');
    assert.equal(out.eMsgnro, '000');
    assert.equal(out.eMsgtxt, 'OK');
    assert.deepEqual(out.tFact, []);
  });

  it('1 row, item-wrapped (ZtficaFacturas is a table of <item>): leading zeros and decimals survive as strings', () => {
    const out = parse(
      '<EMsgnro></EMsgnro><EMsgtxt></EMsgtxt>' +
        '<TFact><item><Opbel>000000123456</Opbel><Exbel>0090001234</Exbel>' +
        '<Faedn>2026-09-15</Faedn><TotalAmnt>1234.50</TotalAmnt></item></TFact>',
    );
    assert.equal(out.tFact.length, 1);
    assert.equal(out.tFact[0]?.opbel, '000000123456');
    assert.equal(out.tFact[0]?.exbel, '0090001234');
    assert.equal(out.tFact[0]?.totalAmnt, '1234.50');
    assert.equal(typeof out.tFact[0]?.exbel, 'string');
  });

  it('3 rows: item-wrapped RFC table', () => {
    const row = (n: string) =>
      `<item><Opbel>${n}</Opbel><Exbel>e${n}</Exbel><Faedn>d${n}</Faedn><TotalAmnt>${n}.00</TotalAmnt></item>`;
    const out = parse(`<EMsgnro></EMsgnro><EMsgtxt></EMsgtxt><TFact>${row('1')}${row('2')}${row('3')}</TFact>`);
    assert.equal(out.tFact.length, 3);
    assert.deepEqual(
      out.tFact.map((r) => r.opbel),
      ['1', '2', '3'],
    );
  });

  it('camelCase wire names are NOT accepted — the pre-WSDL bug must stay dead', () => {
    const out = parse('<eMsgnro>000</eMsgnro><eMsgtxt>OK</eMsgtxt><tFact><item><Opbel>1</Opbel></item></tFact>');
    assert.equal(out.eMsgnro, '');
    assert.deepEqual(out.tFact, []);
  });
});

describe('zWsSap002.summarize', () => {
  it('empty tFact + success eMsgnro ("000") is PASS, not FAIL (spec: empty result is success)', () => {
    const outcome = summarize({ eMsgnro: '000', eMsgtxt: 'sin resultados', tFact: [] });
    assert.equal(outcome.verdict, 'PASS');
    assert.equal(outcome.recordCount, 0);
    assert.deepEqual(outcome.businessMessage, [{ code: '000', text: 'sin resultados' }]);
  });

  it('empty eMsgnro is also success', () => {
    const outcome = summarize({ eMsgnro: '', eMsgtxt: '', tFact: [] });
    assert.equal(outcome.verdict, 'PASS');
    assert.deepEqual(outcome.businessMessage, []);
  });

  it('non-zero eMsgnro is a business error -> FAIL, message carried verbatim', () => {
    const outcome = summarize({ eMsgnro: '042', eMsgtxt: 'Partner inexistente', tFact: [] });
    assert.equal(outcome.verdict, 'FAIL');
    assert.deepEqual(outcome.businessMessage, [{ code: '042', text: 'Partner inexistente' }]);
  });

  it('3 rows + success code -> PASS with recordCount 3', () => {
    const rows = [
      { opbel: '1', exbel: 'a', faedn: 'd1', totalAmnt: '1.00' },
      { opbel: '2', exbel: 'b', faedn: 'd2', totalAmnt: '2.00' },
      { opbel: '3', exbel: 'c', faedn: 'd3', totalAmnt: '3.00' },
    ];
    const outcome = summarize({ eMsgnro: '000', eMsgtxt: 'OK', tFact: rows });
    assert.equal(outcome.verdict, 'PASS');
    assert.equal(outcome.recordCount, 3);
  });
});
