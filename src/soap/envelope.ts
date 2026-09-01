// Construcción del envelope SOAP 1.1. Template string, no builder library:
// transcripción directa de lo verificado contra QA, no síntesis.

import type { SoapOperation, WireField } from './types.js';

// Dos dialectos de nombre de campo coexisten en los WSDL reales: PascalCase
// (mc-style) y UPPER_SNAKE (ZZCS_INFO_IC_WS). Ambos verificados contra WSDL
// real. Detalle: docs/hallazgos-tecnicos.md#convencion-de-nombres-de-campo-en-el-cable
const PASCAL_CASE = /^[A-Z][A-Za-z0-9]*$/;
const UPPER_SNAKE_CASE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;
const WIRE_NAME = new RegExp(`(?:${PASCAL_CASE.source})|(?:${UPPER_SNAKE_CASE.source})`);

/**
 * El sufijo "Field" es un artefacto del proxy .NET (svcutil/xsd.exe) y nunca
 * va al cable: enviarlo arriesga un fault SAP o, peor, un parámetro ignorado
 * con un resultado vacío de apariencia normal.
 */
export function assertWireName(name: string): void {
  if (name.endsWith('Field')) {
    throw new Error(
      `Invalid SOAP element "${name}": the "Field" suffix is a .NET proxy artifact, ` +
        `not the wire format. Use the PascalCase RFC name (e.g. "PiIc", not "piIcField").`,
    );
  }
  if (!WIRE_NAME.test(name)) {
    throw new Error(
      `Invalid SOAP element "${name}": wire names are PascalCase (e.g. "PiIc") or ` +
        `UPPER_SNAKE_CASE (e.g. "IN_NUMERO") — never lowercase-initial, and never ` +
        'with a leading, trailing, or doubled underscore.',
    );
  }
}

export function escapeXml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Los hijos del elemento de operación van SIN prefijo de namespace. Ningún
 * WSDL declara elementFormDefault, así que por defecto es unqualified.
 * Prefijarlos = HTTP 500 "Error en el tratamiento de servicio web".
 * Verificado 2026-08-28.
 */
export function serializeFields(fields: readonly WireField[]): string {
  return fields
    .map(({ name, value }) => {
      assertWireName(name);
      return `      <${name}>${escapeXml(value)}</${name}>`;
    })
    .join('\n');
}

export function buildEnvelope(
  op: Pick<SoapOperation<unknown, unknown>, 'operationName' | 'namespace'>,
  fields: readonly WireField[],
): string {
  const body = serializeFields(fields);
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="${op.namespace}">
  <soapenv:Header/>
  <soapenv:Body>
    <urn:${op.operationName}>
${body}
    </urn:${op.operationName}>
  </soapenv:Body>
</soapenv:Envelope>`;
}
