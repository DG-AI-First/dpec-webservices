// ZZCS_INFO_IC_WS — resolves a DNI/CUIT to a business partner + installation.
// See design §1: this module knows nothing about fetch/TLS/files/console;
// buildFields/parseResult/summarize are pure functions of data in, data out
// — 100% unit-testable with zero mocking (test/zzcsInfoIcWs.test.ts).
//
// Every wire name below comes from the real QA WSDL fetched today,
// test/fixtures/zzcsInfoIcWs.wsdl.xml — not reconstructed from any doc or
// PDF. Unlike the two mc-style services, this WSDL emits ABAP RFC parameter
// names verbatim, UPPER_SNAKE, not PascalCase (see soap/envelope.ts's
// widened assertWireName):
//   ZZCS_INFO_IC_WS         :: IN_NUMERO, IN_PARTNER, IN_TEST, IN_TIPO
//   ZZCS_INFO_IC_WSResponse :: OU_INFO_IC_WS, OU_RESULTADO
//   ZZTTCS_INFO_IC_WS       :: item (table of ZZTCS_INFO_IC_WS, always item-wrapped)
//   ZZTCS_INFO_IC_WS        :: 37 fields, listed in WSDL sequence order below

import type { WireField, XmlNode, SoapOperation, ServiceOutcome } from '../soap/types.js';
import { toArray, extractText } from '../soap/parser.js';

export interface ZzcsInfoIcWsInput {
  readonly inNumero: string;
  readonly inPartner: string;
  readonly inTest: string;
  readonly inTipo: string;
}

/**
 * All 37 fields of ZZTCS_INFO_IC_WS, in WSDL sequence order. Every value is
 * a STRING (design §3(B), parseTagValue: false) — PARTNER and ANLAGE carry
 * leading zeros that a numeric type would destroy. The API mainly uses
 * PARTNER, ANLAGE, IDNUMBER_DNI, NAME1_TEXT, STATUS, FACT_ADEUDADAS, DEUDA,
 * but every field is mapped: this repo's standard is faithfulness to the
 * contract, not a convenient subset (see zFicaDeudaIcUnif.ts/zWsSap002.ts).
 */
export interface OuInfoIcWsRow {
  readonly partner: string;
  readonly type: string;
  readonly idnumberDni: string;
  readonly idnumberCuit: string;
  readonly idnumberCuil: string;
  readonly idnumberCi: string;
  readonly idnumberOtr: string;
  readonly name1Text: string;
  readonly streetIc: string;
  readonly houseNum1Ic: string;
  readonly floorIc: string;
  readonly roomnumberIc: string;
  readonly city1Ic: string;
  readonly postCode1Ic: string;
  readonly anlage: string;
  readonly tariftyp: string;
  readonly equnr: string;
  readonly gernr: string;
  readonly ableinh: string;
  readonly streetIn: string;
  readonly houseNum1In: string;
  readonly floorIn: string;
  readonly roomnumberIn: string;
  readonly city1In: string;
  readonly postCode1In: string;
  readonly einzdat: string;
  readonly auszdat: string;
  readonly status: string;
  readonly factAdeudadas: string;
  readonly deuda: string;
  readonly discStatus: string;
  readonly smtpAddr: string;
  readonly telNumber: string;
  readonly mobNumber: string;
  readonly eqfnr: string;
  readonly lockreason: string;
  readonly descripcion: string;
}

export interface ZzcsInfoIcWsOutput {
  readonly rows: readonly OuInfoIcWsRow[];
  readonly ouResultado: string;
}

export function buildFields(input: ZzcsInfoIcWsInput): WireField[] {
  return [
    { name: 'IN_NUMERO', value: input.inNumero },
    { name: 'IN_PARTNER', value: input.inPartner },
    { name: 'IN_TEST', value: input.inTest },
    { name: 'IN_TIPO', value: input.inTipo },
  ];
}

/**
 * `responseNode` is already unwrapped to the `ZZCS_INFO_IC_WSResponse`
 * element (unwrapBody, soap/parser.ts) — this function never sees
 * Envelope/Body. `OU_INFO_IC_WS` is not in soap/parser.ts's parser-level
 * `LIST_ELEMENTS` allowlist (it is a container of item-wrapped rows, not
 * itself a repeated element), so `toArray` is doing the real work here:
 * defense #2 against the array-coercion trap (design §3(C)) — a single row
 * must never collapse into a bare object and read as recordCount 1 by luck
 * while silently mishandling 3.
 */
export function parseResult(responseNode: XmlNode): ZzcsInfoIcWsOutput {
  const rows: OuInfoIcWsRow[] = toArray<XmlNode>(responseNode.OU_INFO_IC_WS).map((row) => ({
    partner: extractText(row.PARTNER),
    type: extractText(row.TYPE),
    idnumberDni: extractText(row.IDNUMBER_DNI),
    idnumberCuit: extractText(row.IDNUMBER_CUIT),
    idnumberCuil: extractText(row.IDNUMBER_CUIL),
    idnumberCi: extractText(row.IDNUMBER_CI),
    idnumberOtr: extractText(row.IDNUMBER_OTR),
    name1Text: extractText(row.NAME1_TEXT),
    streetIc: extractText(row.STREET_IC),
    houseNum1Ic: extractText(row.HOUSE_NUM1_IC),
    floorIc: extractText(row.FLOOR_IC),
    roomnumberIc: extractText(row.ROOMNUMBER_IC),
    city1Ic: extractText(row.CITY1_IC),
    postCode1Ic: extractText(row.POST_CODE1_IC),
    anlage: extractText(row.ANLAGE),
    tariftyp: extractText(row.TARIFTYP),
    equnr: extractText(row.EQUNR),
    gernr: extractText(row.GERNR),
    ableinh: extractText(row.ABLEINH),
    streetIn: extractText(row.STREET_IN),
    houseNum1In: extractText(row.HOUSE_NUM1_IN),
    floorIn: extractText(row.FLOOR_IN),
    roomnumberIn: extractText(row.ROOMNUMBER_IN),
    city1In: extractText(row.CITY1_IN),
    postCode1In: extractText(row.POST_CODE1_IN),
    einzdat: extractText(row.EINZDAT),
    auszdat: extractText(row.AUSZDAT),
    status: extractText(row.STATUS),
    factAdeudadas: extractText(row.FACT_ADEUDADAS),
    deuda: extractText(row.DEUDA),
    discStatus: extractText(row.DISC_STATUS),
    smtpAddr: extractText(row.SMTP_ADDR),
    telNumber: extractText(row.TEL_NUMBER),
    mobNumber: extractText(row.MOB_NUMBER),
    eqfnr: extractText(row.EQFNR),
    lockreason: extractText(row.LOCKREASON),
    descripcion: extractText(row.DESCRIPCION),
  }));

  return { rows, ouResultado: extractText(responseNode.OU_RESULTADO) };
}

/**
 * OU_RESULTADO's code table is UNKNOWN — there is no WSDL enumeration and no
 * DPEC documentation for it, unlike WS01's poMensaje or WS02's eMsgnro. The
 * ONLY evidence in hand is one live call against QA on 2026-08-28
 * (DNI 30955882 -> PARTNER 0030002708, ANLAGE 0060002445, STATUS
 * DESCONECTADO), which returned `OU_RESULTADO = "0"` alongside one populated
 * row. Following the precedent set by NO_DEBT_CODE in zFicaDeudaIcUnif.ts:
 * a narrow, evidence-backed rule, not a guess. "0" is treated as success
 * because it co-occurred with a genuinely successful lookup; every other
 * value is UNKNOWN and is reported verbatim as a business error rather than
 * silently assumed to be a failure code. Widen this only with a captured
 * response to back the addition — the rest of the table is unknown.
 */
const KNOWN_SUCCESS_RESULTADO = '0';

export function summarize(output: ZzcsInfoIcWsOutput): ServiceOutcome {
  const isKnownSuccess = output.ouResultado.trim() === KNOWN_SUCCESS_RESULTADO;
  const businessMessage = isKnownSuccess ? [] : [{ code: output.ouResultado, text: '' }];

  return {
    recordCount: output.rows.length,
    businessMessage,
    verdict: isKnownSuccess ? 'PASS' : 'FAIL',
  };
}

export const zzcsInfoIcWs: SoapOperation<ZzcsInfoIcWsInput, ZzcsInfoIcWsOutput> = {
  serviceName: 'zzcs-info-ic-ws',
  operationName: 'ZZCS_INFO_IC_WS',
  // ONLY targetNamespace in this service's WSDL — not the mc-style
  // namespace the other two services use. See soap/types.ts's comment.
  namespace: 'urn:sap-com:document:sap:rfc:functions',
  endpointPath: '/sap/bc/srt/rfc/sap/zzcs_info_ic_ws/100/zcs_info_ic_ws/zcs_info_ic_ws',
  // Non-empty, unlike the two mc-style services — verified against the WSDL
  // binding, not guessed. See soap/types.ts / index.ts for why this is now
  // authoritative and cannot be silently overridden by a config value.
  soapAction: 'urn:sap-com:document:sap:rfc:functions:ZZCS_INFO_IC_WS:ZZCS_INFO_IC_WSRequest',
  buildFields,
  parseResult,
  summarize,
};
