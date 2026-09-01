// Leaf types for the SOAP seam. No dependencies, no test — see design §1.
// This is the ONLY abstraction the module needs: SoapOperation<TIn, TOut>.
// It exists because it *is* the seam between "how we speak SOAP to SAP"
// (this directory, reusable) and "what these two RFCs are" (services/).

/** Result of parsing a SOAP envelope with removeNSPrefix — a bag of unknown shape. */
export type XmlNode = Record<string, unknown>;

export interface WireField {
  readonly name: string;
  readonly value: string;
}

/**
 * Branded type: only redactHeaders() (evidence/writer.ts, Phase 4) can produce
 * this. The evidence writer cannot accept a raw header map — redaction is the
 * only path in, not a filter someone can forget to call (design §5).
 */
export type RedactedHeaders = Record<string, string> & { readonly __redacted: unique symbol };

export interface SoapCallRecord {
  url: string;
  requestXml: string;
  requestHeaders: RedactedHeaders;
  httpStatus: number | null;
  responseXml: string | null;
  responseHeaders: Record<string, string> | null;
  startedAt: string;
  elapsedMs: number;
}

export interface ServiceOutcome {
  readonly recordCount: number;
  readonly businessMessage: ReadonlyArray<{ code: string; text: string }>;
  readonly verdict: 'PASS' | 'FAIL';
}

/**
 * The one abstraction. `summarize` lives here (per-operation), not in the
 * transport, because "what counts as a business error" is service knowledge
 * — see design §1. Transport must never grow a switch statement over
 * service names.
 */
export interface SoapOperation<TInput, TOutput> {
  readonly serviceName: string; // 'z-ws-sap-002' — slug used in evidence filenames
  readonly operationName: string; // 'ZWsSap002' — SOAP body element name (wire)
  // The body namespace is whatever the service's OWN WSDL declares as
  // targetNamespace — there is no single "the" namespace across services.
  // The two mc-style services (test/fixtures/ws002.wsdl.xml,
  // test/fixtures/fica.wsdl.xml) both declare
  // 'urn:sap-com:document:sap:soap:functions:mc-style'. ZZCS_INFO_IC_WS
  // (test/fixtures/zzcsInfoIcWs.wsdl.xml) declares
  // 'urn:sap-com:document:sap:rfc:functions' as its ONLY targetNamespace —
  // that string is not a scalar-type schema that "is never a body
  // namespace"; it is this service's real one. Getting a service's own
  // namespace wrong (copying another service's) is an opaque HTTP 500.
  readonly namespace: string;
  readonly endpointPath: string; // '/sap/bc/srt/rfc/sap/z_ws_sap_002/...'
  // Per-service, and load-bearing for at least one of them. The two mc-style
  // services send '' (live findings: a non-factor there). ZZCS_INFO_IC_WS
  // sends the value its WSDL binding declares. There is no global override:
  // one string cannot be right for both, so this field is the only source.
  readonly soapAction: string;

  buildFields(input: TInput): WireField[];
  parseResult(responseNode: XmlNode): TOutput;
  summarize(output: TOutput): ServiceOutcome;
}
