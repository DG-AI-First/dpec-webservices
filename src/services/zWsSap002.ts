// Z_WS_SAP_002: descriptor de la operación de últimas N facturas.
// Nombres de campo desde el WSDL real (test/fixtures/ws002.wsdl.xml), no del
// PDF de integración de DPEC (generado desde proxy .NET, mal en mayúsculas y
// contenido: ZsficaFacturas no tiene EAnlage, invención de una reconstrucción previa).

import type { WireField, XmlNode, SoapOperation, ServiceOutcome } from '../soap/types.js';
import { toArray, extractText } from '../soap/parser.js';
import { classifyBusinessMessage, determineVerdict } from '../errors.js';

export interface ZWsSap002Input {
  readonly iAnlage: string;
  readonly iPartner: string;
  readonly iCantfact: string;
}

export interface TFactRow {
  readonly opbel: string;
  readonly exbel: string;
  readonly faedn: string;
  readonly totalAmnt: string;
}

export interface ZWsSap002Output {
  readonly eMsgnro: string;
  readonly eMsgtxt: string;
  readonly tFact: readonly TFactRow[];
}

export function buildFields(input: ZWsSap002Input): WireField[] {
  return [
    { name: 'IAnlage', value: input.iAnlage },
    { name: 'ICantfact', value: input.iCantfact },
    { name: 'IPartner', value: input.iPartner },
  ];
}

/** `responseNode` ya viene desenvuelto a `ZWsSap002Response`. */
export function parseResult(responseNode: XmlNode): ZWsSap002Output {
  const rows = toArray<XmlNode>(responseNode.TFact);
  const tFact: TFactRow[] = rows.map((row) => ({
    opbel: extractText(row.Opbel),
    exbel: extractText(row.Exbel),
    faedn: extractText(row.Faedn),
    totalAmnt: extractText(row.TotalAmnt),
  }));

  return {
    eMsgnro: extractText(responseNode.EMsgnro),
    eMsgtxt: extractText(responseNode.EMsgtxt),
    tFact,
  };
}

/**
 * WS02 señala error de negocio vía eMsgnro/eMsgtxt. EMsgnro no es numérico:
 * SAP devuelve clase de mensaje ABAP + número (ej. ZFICA017).
 * tFact vacío con código de éxito es PASS, no FAIL.
 */
export function summarize(output: ZWsSap002Output): ServiceOutcome {
  const businessError = classifyBusinessMessage(output.eMsgnro, output.eMsgtxt);
  const businessMessage =
    output.eMsgnro !== '' || output.eMsgtxt !== ''
      ? [{ code: output.eMsgnro, text: output.eMsgtxt }]
      : [];

  return {
    recordCount: output.tFact.length,
    businessMessage,
    verdict: determineVerdict(businessError),
  };
}

export const zWsSap002: SoapOperation<ZWsSap002Input, ZWsSap002Output> = {
  serviceName: 'z-ws-sap-002',
  operationName: 'ZWsSap002',
  namespace: 'urn:sap-com:document:sap:soap:functions:mc-style',
  endpointPath: '/sap/bc/srt/rfc/sap/z_ws_sap_002/100/z_ws_sap_002/z_ws_sap_002',
  soapAction: '',
  buildFields,
  parseResult,
  summarize,
};
