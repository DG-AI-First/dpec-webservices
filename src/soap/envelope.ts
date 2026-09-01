// SOAP 1.1 envelope construction. Template string, not a builder library —
// the SoapUI capture (and now the live-captured wire evidence) gives the
// envelope verbatim; this is transcription, not synthesis. See design §2.

import type { SoapOperation, WireField } from './types.js';

// Two legitimate wire-naming conventions coexist across the services this
// client speaks to, and both were verified against a real WSDL, not
// reconstructed from a doc:
//   - PascalCase (`PiIc`, `TFact`)     — the mc-style services' RFC-to-SOAP
//     generator title-cases the ABAP parameter name.
//   - UPPER_SNAKE (`IN_NUMERO`, `OU_INFO_IC_WS`) — ZZCS_INFO_IC_WS's WSDL
//     (test/fixtures/zzcsInfoIcWs.wsdl.xml) emits the ABAP RFC parameter
//     name verbatim, underscores included. The original guard only knew the
//     first convention and threw on every field of the third service.
// Both alternatives independently forbid what makes a name a bug rather than
// a dialect: a lowercase start, and (in the UPPER_SNAKE case) a leading,
// trailing, or doubled underscore — those are transcription mistakes, not a
// naming convention SAP has ever emitted.
const PASCAL_CASE = /^[A-Z][A-Za-z0-9]*$/;
const UPPER_SNAKE_CASE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;
const WIRE_NAME = new RegExp(`(?:${PASCAL_CASE.source})|(?:${UPPER_SNAKE_CASE.source})`);

/**
 * Enforces the wire-naming rule: any element ending in "Field", or starting
 * with a lowercase letter, is a bug. "Field" is a .NET proxy backing-field
 * artifact (svcutil/xsd.exe) that never belongs on the wire — sending it
 * risks a SAP fault, or worse, an ignored parameter and a plausible-looking
 * empty result. See design §2.
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
 * All declared fields are always emitted, empty when unset.
 *
 * Children are UNQUALIFIED — no `urn:` prefix — and that is not a style
 * choice. Neither service's WSDL declares `elementFormDefault`, so XML Schema
 * defaults it to "unqualified": only the operation element itself lives in
 * the mc-style namespace, its children live in no namespace at all. Prefixing
 * them puts every parameter in a namespace SAP is not looking in, and SAP
 * answers HTTP 500 with a generic "Error en el tratamiento de servicio web"
 * that names nothing. Verified live against QA on 2026-08-28.
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
