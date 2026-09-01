// Tipos base de la capa SOAP, sin dependencias. Única abstracción:
// SoapOperation<TIn, TOut> — el límite entre "cómo hablamos SOAP con SAP"
// (este directorio) y "qué son estos RFC" (services/).

/** Resultado de parsear un envelope SOAP con removeNSPrefix: forma desconocida. */
export type XmlNode = Record<string, unknown>;

export interface WireField {
  readonly name: string;
  readonly value: string;
}

export interface ServiceOutcome {
  readonly recordCount: number;
  readonly businessMessage: ReadonlyArray<{ code: string; text: string }>;
  readonly verdict: 'PASS' | 'FAIL';
}

/**
 * `summarize` vive acá (por operación), no en transport: qué cuenta como
 * error de negocio es conocimiento de cada servicio, no de la capa SOAP.
 */
export interface SoapOperation<TInput, TOutput> {
  readonly serviceName: string; // slug usado en nombres de archivo de evidencia
  readonly operationName: string; // nombre del elemento SOAP en el cable
  // El namespace es el targetNamespace propio de cada WSDL, no hay uno común
  // a todos los servicios. Detalle: docs/hallazgos-tecnicos.md#namespace-y-soapaction-por-servicio
  readonly namespace: string;
  readonly endpointPath: string; // '/sap/bc/srt/rfc/sap/z_ws_sap_002/...'
  // El SOAPAction también es propio de cada servicio, sin override global.
  // Detalle: docs/hallazgos-tecnicos.md#namespace-y-soapaction-por-servicio
  readonly soapAction: string;

  buildFields(input: TInput): WireField[];
  parseResult(responseNode: XmlNode): TOutput;
  summarize(output: TOutput): ServiceOutcome;
}
