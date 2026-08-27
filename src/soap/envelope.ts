// SOAP 1.1 envelope construction. Template string, not a builder library —
// the SoapUI capture (and now the live-captured wire evidence) gives the
// envelope verbatim; this is transcription, not synthesis. See design §2.

import type { SoapOperation, WireField } from './types.js';

const WIRE_NAME = /^[A-Z][A-Za-z0-9]*$/;

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
    throw new Error(`Invalid SOAP element "${name}": wire names are PascalCase.`);
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

/** All declared fields are always emitted, empty when unset — matches the known-good capture. */
export function serializeFields(fields: readonly WireField[]): string {
  return fields
    .map(({ name, value }) => {
      assertWireName(name);
      return `      <urn:${name}>${escapeXml(value)}</urn:${name}>`;
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
