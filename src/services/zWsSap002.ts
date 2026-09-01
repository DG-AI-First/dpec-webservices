// Z_WS_SAP_002 — last-N-invoices operation descriptor. See design §1: this
// module knows nothing about fetch/TLS/files/console; buildFields/parseResult
// /summarize are pure functions of data in, data out — 100% unit-testable
// with zero mocking (test/zWsSap002.test.ts).
//
// Field order and every wire name below come from the QA WSDL, promoted to
// test/fixtures/ws002.wsdl.xml — not from DPEC's integration PDF, which was
// written from a .NET proxy class and is wrong about both case and content.
//   ZWsSap002          :: IAnlage, ICantfact, IPartner
//   ZWsSap002Response  :: EMsgnro, EMsgtxt, TFact
//   ZsficaFacturas     :: Opbel, Exbel, Faedn, TotalAmnt   (no EAnlage exists)
//   ZtficaFacturas     :: item                             (rows always wrapped)

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

/**
 * `responseNode` is already unwrapped to the `ZWsSap002Response` element
 * (unwrapBody, soap/parser.ts) — this function never sees Envelope/Body.
 */
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
 * WS02 signals a business error via eMsgnro/eMsgtxt (design §1). An empty
 * tFact with a success code is PASS, not FAIL — an empty result set is a
 * data question, not a service failure (design §6, spec "Empty invoice
 * result is success").
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
