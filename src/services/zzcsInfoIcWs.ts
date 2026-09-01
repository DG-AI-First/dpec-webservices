// ZZCS_INFO_IC_WS: resuelve DNI/CUIT a interlocutor comercial + instalación.
// Nombres de campo desde test/fixtures/zzcsInfoIcWs.wsdl.xml (WSDL real de
// QA), no del PDF de integración de DPEC (generado desde proxy .NET,
// equivocado en mayúsculas y contenido). UPPER_SNAKE, no PascalCase — ver
// docs/hallazgos-tecnicos.md#convencion-de-nombres-de-campo-en-el-cable

import type { WireField, XmlNode, SoapOperation, ServiceOutcome } from '../soap/types.js';
import { toArray, extractText } from '../soap/parser.js';

export interface ZzcsInfoIcWsInput {
  readonly inNumero: string;
  readonly inPartner: string;
  readonly inTest: string;
  readonly inTipo: string;
}

/**
 * Los 37 campos de ZZTCS_INFO_IC_WS, en orden del WSDL. Todo valor es
 * STRING: PARTNER y ANLAGE llevan ceros a la izquierda que un tipo numérico
 * destruiría.
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
 * `responseNode` ya viene desenvuelto a `ZZCS_INFO_IC_WSResponse`.
 * `OU_INFO_IC_WS` no está en el allowlist `isArray` del parser (es
 * contenedor, no el elemento repetido); `toArray` hace el trabajo real de
 * evitar que una sola fila colapse a objeto y falsee el recordCount.
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

// OU_RESULTADO: tabla de códigos desconocida (sin enum de WSDL ni doc DPEC).
// Únicos valores observados: "0" éxito (2026-08-28), "99" 0 filas HTTP 200
// (2026-09-01). Todo lo demás es desconocido: se reporta verbatim, sin asumir.
const KNOWN_SUCCESS_RESULTADO = '0';

// PASS acá significa "SAP respondió 0", no "se encontró un cliente": el
// veredicto no mira rows.length.
//
// DNI inexistente (ej. 99999999) no da error: el RFC cuelga hasta el timeout
// de 30s del cliente, sin respuesta "no encontrado". Verificado 2026-09-01.
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
  // Único targetNamespace de este WSDL, distinto del mc-style. Ver
  // docs/hallazgos-tecnicos.md#namespace-y-soapaction-por-servicio
  namespace: 'urn:sap-com:document:sap:rfc:functions',
  endpointPath: '/sap/bc/srt/rfc/sap/zzcs_info_ic_ws/100/zcs_info_ic_ws/zcs_info_ic_ws',
  // No vacío, a diferencia de los otros dos servicios — verificado contra el
  // binding del WSDL, no supuesto.
  soapAction: 'urn:sap-com:document:sap:rfc:functions:ZZCS_INFO_IC_WS:ZZCS_INFO_IC_WSRequest',
  buildFields,
  parseResult,
  summarize,
};
