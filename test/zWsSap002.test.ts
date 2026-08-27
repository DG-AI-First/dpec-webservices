// TDD RED-first for src/services/zWsSap002.ts — see design §1 (services/ know
// nothing about fetch/TLS/files/console, so parseResult/summarize are pure
// functions, 100% unit-testable with zero mocking).
//
// HONEST CONSTRAINT: no real successful ZWsSap002 response has ever been
// observed (DPEC's binding is unconfigured in QA — see obs #921). These
// fixtures are RECONSTRUCTED from the design's field list (§10) and the
// live-captured request envelope (evidence/spike-2026-08-27T01-38-39-308Z),
// not captured from a real success response. Named follow-up: promote real
// evidence/**/*.response.xml into fixtures here after the first live PASS
// (design §7 "Honest limitation").

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseXml, unwrapBody } from '../src/soap/parser.js';
import { buildFields, parseResult, summarize } from '../src/services/zWsSap002.js';

describe('zWsSap002.buildFields', () => {
  it('emits IAnlage, ICantfact, IPartner in capture order (design §2 field order)', () => {
    const fields = buildFields({ iAnlage: '0010099044', iCantfact: '10', iPartner: '0010099046' });
    assert.deepEqual(fields, [
      { name: 'IAnlage', value: '0010099044' },
      { name: 'ICantfact', value: '10' },
      { name: 'IPartner', value: '0010099046' },
    ]);
  });
});

describe('zWsSap002.parseResult — tFact row counts (0/1/3), reconstructed fixtures', () => {
  function parse(bodyXml: string) {
    const raw = `<Envelope><Body><ZWsSap002Response>${bodyXml}</ZWsSap002Response></Body></Envelope>`;
    const { node } = unwrapBody(parseXml(raw), 'ZWsSap002');
    return parseResult(node);
  }

  it('0 rows: self-closed <tFact/>, eMsgnro/eMsgtxt present', () => {
    const out = parse('<eMsgnro>000</eMsgnro><eMsgtxt>OK</eMsgtxt><tFact/>');
    assert.equal(out.eMsgnro, '000');
    assert.equal(out.eMsgtxt, 'OK');
    assert.deepEqual(out.tFact, []);
  });

  it('1 row: leading-zero exbel and decimal totalAmnt survive as strings', () => {
    const out = parse(
      '<eMsgnro></eMsgnro><eMsgtxt></eMsgtxt>' +
        '<tFact><eAnlage>0010099044</eAnlage><exbel>0090001234</exbel>' +
        '<faedn>2026-09-15</faedn><totalAmnt>1234.50</totalAmnt></tFact>',
    );
    assert.equal(out.tFact.length, 1);
    assert.equal(out.tFact[0]?.exbel, '0090001234');
    assert.equal(out.tFact[0]?.totalAmnt, '1234.50');
    assert.equal(typeof out.tFact[0]?.exbel, 'string');
  });

  it('3 rows: flat repeated <tFact> siblings', () => {
    const out = parse(
      '<eMsgnro></eMsgnro><eMsgtxt></eMsgtxt>' +
        '<tFact><eAnlage>1</eAnlage><exbel>a</exbel><faedn>d1</faedn><totalAmnt>1.00</totalAmnt></tFact>' +
        '<tFact><eAnlage>2</eAnlage><exbel>b</exbel><faedn>d2</faedn><totalAmnt>2.00</totalAmnt></tFact>' +
        '<tFact><eAnlage>3</eAnlage><exbel>c</exbel><faedn>d3</faedn><totalAmnt>3.00</totalAmnt></tFact>',
    );
    assert.equal(out.tFact.length, 3);
    assert.deepEqual(
      out.tFact.map((r) => r.eAnlage),
      ['1', '2', '3'],
    );
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
      { eAnlage: '1', exbel: 'a', faedn: 'd1', totalAmnt: '1.00' },
      { eAnlage: '2', exbel: 'b', faedn: 'd2', totalAmnt: '2.00' },
      { eAnlage: '3', exbel: 'c', faedn: 'd3', totalAmnt: '3.00' },
    ];
    const outcome = summarize({ eMsgnro: '000', eMsgtxt: 'OK', tFact: rows });
    assert.equal(outcome.verdict, 'PASS');
    assert.equal(outcome.recordCount, 3);
  });
});
