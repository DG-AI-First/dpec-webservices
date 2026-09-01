// Unit tests for src/services/zzcsInfoIcWs.ts — see design §1 (services/
// know nothing about fetch/TLS/files/console; buildFields/parseResult/
// summarize are pure functions, 100% unit-testable with zero mocking).
//
// Every wire name below comes straight from the real QA WSDL fetched today,
// test/fixtures/zzcsInfoIcWs.wsdl.xml — NOT reconstructed from any doc. This
// repo was burned once by reconstructing wire names from a .NET-generated
// PDF (see zWsSap002.ts's header and README's finding #5); this service's
// names are UPPER_SNAKE (IN_NUMERO, OU_INFO_IC_WS), a different dialect from
// the two mc-style services' PascalCase, and that is exactly why
// assertWireName had to be widened rather than reused as-is.
//
//   ZZCS_INFO_IC_WS         :: IN_NUMERO, IN_PARTNER, IN_TEST, IN_TIPO
//   ZZCS_INFO_IC_WSResponse :: OU_INFO_IC_WS, OU_RESULTADO
//   ZZTTCS_INFO_IC_WS       :: item (table of ZZTCS_INFO_IC_WS, always item-wrapped)
//   ZZTCS_INFO_IC_WS        :: 37 fields, PARTNER..DESCRIPCION (see src file for the full list)
//
// Unlike the two mc-style services, this WSDL's targetNamespace is
// 'urn:sap-com:document:sap:rfc:functions' and its soapAction is
// non-empty — both handled by src/soap/types.ts and src/index.ts, not here.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseXml, unwrapBody } from '../src/soap/parser.js';
import { buildFields, parseResult, summarize } from '../src/services/zzcsInfoIcWs.js';

describe('zzcsInfoIcWs.buildFields', () => {
  it('emits IN_NUMERO, IN_PARTNER, IN_TEST, IN_TIPO in WSDL sequence order', () => {
    const fields = buildFields({ inNumero: '30955882', inPartner: '', inTest: '', inTipo: '*' });
    assert.deepEqual(fields, [
      { name: 'IN_NUMERO', value: '30955882' },
      { name: 'IN_PARTNER', value: '' },
      { name: 'IN_TEST', value: '' },
      { name: 'IN_TIPO', value: '*' },
    ]);
  });
});

describe('zzcsInfoIcWs.parseResult — UPPER_SNAKE wire names, row counts', () => {
  function parse(bodyXml: string) {
    const raw = `<Envelope><Body><ZZCS_INFO_IC_WSResponse>${bodyXml}</ZZCS_INFO_IC_WSResponse></Body></Envelope>`;
    const { node } = unwrapBody(parseXml(raw), 'ZZCS_INFO_IC_WS');
    return parseResult(node);
  }

  const row = (n: string) =>
    `<item><PARTNER>003000270${n}</PARTNER><TYPE>BUP001</TYPE><IDNUMBER_DNI>3095588${n}</IDNUMBER_DNI>` +
    `<IDNUMBER_CUIT></IDNUMBER_CUIT><IDNUMBER_CUIL></IDNUMBER_CUIL><IDNUMBER_CI></IDNUMBER_CI>` +
    `<IDNUMBER_OTR></IDNUMBER_OTR><NAME1_TEXT>Fulano ${n}</NAME1_TEXT><STREET_IC>Calle ${n}</STREET_IC>` +
    `<HOUSE_NUM1_IC>${n}</HOUSE_NUM1_IC><FLOOR_IC></FLOOR_IC><ROOMNUMBER_IC></ROOMNUMBER_IC>` +
    `<CITY1_IC>Resistencia</CITY1_IC><POST_CODE1_IC>340${n}</POST_CODE1_IC><ANLAGE>006000244${n}</ANLAGE>` +
    `<TARIFTYP>T1</TARIFTYP><EQUNR></EQUNR><GERNR></GERNR><ABLEINH></ABLEINH><STREET_IN>Calle ${n}</STREET_IN>` +
    `<HOUSE_NUM1_IN>${n}</HOUSE_NUM1_IN><FLOOR_IN></FLOOR_IN><ROOMNUMBER_IN></ROOMNUMBER_IN>` +
    `<CITY1_IN>Resistencia</CITY1_IN><POST_CODE1_IN>340${n}</POST_CODE1_IN><EINZDAT>2020-01-0${n}</EINZDAT>` +
    `<AUSZDAT></AUSZDAT><STATUS>DESCONECTADO</STATUS><FACT_ADEUDADAS>00${n}</FACT_ADEUDADAS>` +
    `<DEUDA>${n}.00</DEUDA><DISC_STATUS>00</DISC_STATUS><SMTP_ADDR></SMTP_ADDR><TEL_NUMBER></TEL_NUMBER>` +
    `<MOB_NUMBER></MOB_NUMBER><EQFNR></EQFNR><LOCKREASON></LOCKREASON><DESCRIPCION></DESCRIPCION></item>`;

  it('0 rows: self-closed <OU_INFO_IC_WS/>, OU_RESULTADO present', () => {
    const out = parse('<OU_INFO_IC_WS/><OU_RESULTADO>0</OU_RESULTADO>');
    assert.deepEqual(out.rows, []);
    assert.equal(out.ouResultado, '0');
  });

  it('1 row, item-wrapped: leading zeros on PARTNER/ANLAGE survive as strings', () => {
    const out = parse(`<OU_INFO_IC_WS>${row('1')}</OU_INFO_IC_WS><OU_RESULTADO>0</OU_RESULTADO>`);
    assert.equal(out.rows.length, 1);
    assert.equal(out.rows[0]?.partner, '0030002701');
    assert.equal(typeof out.rows[0]?.partner, 'string');
    assert.equal(out.rows[0]?.anlage, '0060002441');
    assert.equal(out.rows[0]?.status, 'DESCONECTADO');
  });

  it('3 rows: item-wrapped RFC table is not collapsed into a single object (the 1-row-table trap)', () => {
    const out = parse(
      `<OU_INFO_IC_WS>${row('1')}${row('2')}${row('3')}</OU_INFO_IC_WS><OU_RESULTADO>0</OU_RESULTADO>`,
    );
    assert.equal(out.rows.length, 3);
    assert.deepEqual(
      out.rows.map((r) => r.partner),
      ['0030002701', '0030002702', '0030002703'],
    );
  });

  it('a genuinely single-row table (no repetition) still comes out as an array of length 1', () => {
    // This is the case design §3(C) calls "the single most likely silent
    // bug": fast-xml-parser collapses a lone <item> into a bare object
    // unless isArray forces it, and toArray() is the mapper-level defense.
    const out = parse(`<OU_INFO_IC_WS>${row('7')}</OU_INFO_IC_WS><OU_RESULTADO>0</OU_RESULTADO>`);
    assert.ok(Array.isArray(out.rows));
    assert.equal(out.rows.length, 1);
  });

  it('camelCase/lowercase wire names are NOT accepted — the pre-WSDL bug must stay dead', () => {
    const out = parse(
      '<ou_info_ic_ws><item><partner>0030002701</partner></item></ou_info_ic_ws><ou_resultado>0</ou_resultado>',
    );
    assert.deepEqual(out.rows, []);
    assert.equal(out.ouResultado, '');
  });

  it('maps all 37 row fields, not a subset', () => {
    const out = parse(`<OU_INFO_IC_WS>${row('4')}</OU_INFO_IC_WS><OU_RESULTADO>0</OU_RESULTADO>`);
    const parsedRow = out.rows[0];
    assert.ok(parsedRow);
    assert.equal(Object.keys(parsedRow).length, 37);
  });
});

describe('zzcsInfoIcWs.summarize', () => {
  // OU_RESULTADO's code table is UNKNOWN — there is no WSDL enumeration and
  // no DPEC documentation for it. The ONLY evidence in hand is one live call
  // against QA on 2026-08-28 (DNI 30955882 -> PARTNER 0030002708, ANLAGE
  // 0060002445, STATUS DESCONECTADO — see test/fixtures/zzcsInfoIcWs.response.xml
  // and test/live-responses.test.ts), which returned OU_RESULTADO="0"
  // alongside one genuinely populated row. Per the NO_DEBT_CODE precedent in
  // zFicaDeudaIcUnif.ts, "0" is treated as success because it co-occurred
  // with that successful lookup; every other value is unknown and reported
  // as a business error rather than assumed to be a specific failure.

  it('OU_RESULTADO "0" with a populated row is PASS (the only observed value)', () => {
    const outcome = summarize({
      ouResultado: '0',
      rows: [
        {
          partner: '0030002708', type: 'AR1C', idnumberDni: '30955882', idnumberCuit: '',
          idnumberCuil: '', idnumberCi: '', idnumberOtr: '', name1Text: 'x', streetIc: '',
          houseNum1Ic: '', floorIc: '', roomnumberIc: '', city1Ic: '', postCode1Ic: '',
          anlage: '0060002445', tariftyp: '1CI', equnr: '', gernr: '', ableinh: '',
          streetIn: '', houseNum1In: '', floorIn: '', roomnumberIn: '', city1In: '',
          postCode1In: '', einzdat: '', auszdat: '', status: 'DESCONECTADO',
          factAdeudadas: '001', deuda: '26.58', discStatus: '00', smtpAddr: '',
          telNumber: '', mobNumber: '', eqfnr: '', lockreason: '', descripcion: '',
        },
      ],
    });
    assert.equal(outcome.verdict, 'PASS');
    assert.equal(outcome.recordCount, 1);
    assert.deepEqual(outcome.businessMessage, []);
  });

  it('an empty row set is still evaluated by OU_RESULTADO, not by row count', () => {
    const outcome = summarize({ ouResultado: '0', rows: [] });
    assert.equal(outcome.verdict, 'PASS');
    assert.equal(outcome.recordCount, 0);
  });

  it('any OU_RESULTADO other than the one observed success value is reported as a business error, not silently assumed', () => {
    const outcome = summarize({ ouResultado: '4', rows: [] });
    assert.equal(outcome.verdict, 'FAIL');
    assert.equal(outcome.businessMessage[0]?.code, '4');
  });
});
