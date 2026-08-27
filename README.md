# dpec-sap-soap-client

Standalone probe that calls DPEC's two SAP SOAP RFC services
(`Z_WS_SAP_002` — last-N invoices, `Z_FICA_DEUDA_IC_UNIF` — unified debt),
proves (or disproves) that they work, and writes raw wire evidence to disk.

This document is the handoff to whoever continues this integration (Lean).
It records what we learned **live against DPEC's system**, not just how to
run the script — read the "Empirical findings" and "Current blocker"
sections before touching the SOAP layer.

## Quick start

```bash
npm install
cp .env.example .env        # fill in SAP_USER / SAP_PASSWORD
npm run check                # tsc --noEmit
npm test                     # node:test, no network, no mocking
npm run dry                  # exercises the full pipeline, sends nothing
npm run probe                # LIVE — hits DPEC_ENV (qa by default)
```

`npm run probe` against `DPEC_ENV=prod` requires
`DPEC_CONFIRM_PROD=I_UNDERSTAND_THIS_HITS_PRODUCTION` in the environment —
this is deliberate friction, not a bug. See `src/config.ts` for the full
PROD-safety enforcement matrix.

Every run writes to `evidence/run-<timestamp>/` (raw request/response XML,
`meta.json` per call, `summary.json`) and copies the latest summary to
`evidence/latest-summary.json`. **`evidence/` is gitignored except
`.gitkeep`** — captures may contain customer data (`.gitignore`'s
`evidence/*` / `!evidence/.gitkeep` pattern; do not use the bare `evidence/`
pattern, it makes the negation dead because git won't descend into an
ignored parent directory).

Exit codes: `0` both services PASS · `2` our config/credentials are the
problem · `3` SAP was reached and answered with a fault/business error ·
`4` transport failure (unreachable/TLS/timeout). See `src/errors.ts`.

## Architecture, in one paragraph

The codebase optimizes for one seam: **`src/soap/`** (how we speak SOAP to
SAP — reusable, domain-free, keep it) vs. **`src/services/`** (what these
two RFCs are — replace or extend it). `evidence/` and `cli/` are leaves that
the real integration will likely discard. `src/config.ts` is read once, at
startup; `process.env` appears nowhere else. Full reasoning for every
decision lives in the SDD design artifact for this change
(`sdd/dpec-sap-soap-client/design`); this README only covers what a second
developer needs that a design doc doesn't capture: **what we learned by
actually calling DPEC.**

## Empirical findings (live against QA, 2026-08-27)

These correct or resolve the open questions in DPEC's integration PDF. All
of the underlying evidence is in `evidence/spike-*/` (raw request/response
captures) and was produced by the throwaway diagnostic scripts left at the
repo root (`spike.mjs`, `soapaction-test.mjs`, `wsdl-check.mjs`) — kept
around as reusable instruments, not part of the deliverable.

1. **`https://` is correct, not `http://` as DPEC's doc states.** The doc's
   plaintext scheme does not work; the SoapUI capture (and every live call
   we made) used TLS. `DPEC_SCHEME` defaults to `https`; flip it with one
   env var if this ever turns out to be environment-dependent.

2. **`SOAPAction` was eliminated as a factor.** `soapaction-test.mjs` tried
   six variants against the live QA endpoint — omitted entirely, `""`
   (quoted empty), unquoted empty, the operation name, the full URN, and
   URN+`Request` suffix — and **all six produced the byte-identical SOAP
   fault**. Whatever is wrong, it is not the `SOAPAction` header. The probe
   defaults it to `""` (`DPEC_SOAP_ACTION`) since it provably does not
   matter yet, and keeps the config knob in case that changes once the
   binding is actually configured.

3. **The DPEC PDF's field names are .NET proxy artifacts, not the wire
   format — this is the single most consequential finding.** The doc lists
   names like `piIcField`, `totalAmntField`, because it was generated from
   a C# proxy class (`svcutil`/`xsd.exe` backing-field convention), not from
   the actual SOAP XML. **The real wire format is PascalCase without the
   `Field` suffix**: `PiIc`, `TotalAmnt`, `IAnlage`, `ICantfact`. This
   matters because **SAP RFC silently ignores unknown XML elements** — if
   you send `<urn:piIcField>`, SAP does not reject the call, it just treats
   the parameter as unset and returns a plausible-looking *empty* result
   set. That is a silent wrong answer, indistinguishable from "this partner
   has no debt" without knowing this. `src/soap/envelope.ts` has a runtime
   guard (`assertWireName`) that throws if a `Field`-suffixed or
   lowercase-initial name is ever passed to `buildFields`/`buildEnvelope`,
   specifically so this mistake cannot silently reoccur.

## Current blocker (as of 2026-08-27) — DPEC-side, both environments

Both services return **HTTP 500** in QA with a SOAP Fault:

```
Error en el tratamiento de servicio web; Más detalles en log de error de
servicio web en la página de proveedor (Cronomarcador UTC ...; ID de
transacción ...)
```

`wsdl-check.mjs` confirms the SICF node itself **is active**: an
authenticated GET to `?wsdl` returns HTTP 200 with a SAP proprietary
`<error>` payload (not a WSDL, not a 404) whose text is:

```
WSP Exception caught: Initial value "config key"
```

That message is SAP's own diagnostic for **"this Web Service binding has no
configuration entry in SOAMANAGER"** — i.e. the endpoint exists and
authenticates, but nobody has finished publishing/binding the service on
DPEC's side. This is not something fixable from our side; it needs DPEC's
Basis team.

Credentials compound the blocker instead of offering a workaround:

| Environment | Auth | Service configured |
|---|---|---|
| QA (`sapqas.dpec.com.ar`) | authenticates (user `WSMICTS`) | no — binding unconfigured (above) |
| PROD (`sapprd.dpec.com.ar`) | **401 rejected** | presumably yes (DPEC's doc screenshots show successful SoapUI calls) |

In other words: the credentials we have are QA credentials, and QA is
exactly the environment where the services aren't published yet. PROD is
presumably working but we have no credentials for it, and — deliberately —
we did not brute-force variants against PROD (retrying auth combinations
against a production SAP system looks identical to a credential-stuffing
attempt in DPEC's logs; one authorized call, one result, stop there. See the
401 log: 158ms round-trip, meaning network/TLS were fine, only the
credential was rejected).

**What to ask DPEC for, in order of preference:**
1. Publish both services in QA with the SOAMANAGER binding configured —
   unblocks all further development without touching production.
2. Failing that, PROD credentials — worse, because it means developing and
   testing against a live production SAP system.

## Fixture status — read before touching `test/`

| Fixture source | File(s) | Status |
|---|---|---|
| **Captured** — real bytes from QA | `evidence/spike-2026-08-27T01-38-39-308Z/`, `.../01-39-07-793Z/` (SOAP faults), `.../01-41-56-541Z/` (SAP logon-error HTML page) | Genuine wire data. Used verbatim in `test/envelope.test.ts` (request envelopes) and `test/parse.test.ts` (the fault-detection case). |
| **Reconstructed** — no real success response has ever been observed | `test/zWsSap002.test.ts`, `test/zFicaDeudaIcUnif.test.ts` (all `parseResult`/`summarize` row fixtures), and the 0/1/3-row synthetic cases in `test/parse.test.ts` | Built from the design's documented field list and the array-coercion behavior of `fast-xml-parser`, **not from an actual SAP success response**. They test our normalization logic against our *assumption* of the wire shape (both flat and RFC `<item>`-wrapped table variants are covered precisely because we don't know which SAP emits). |

**Mandatory follow-up once the blocker above clears and `npm run probe`
produces a real HTTP 200 with data:** promote the real
`evidence/run-*/*.response.xml` into `test/fixtures/` as the authoritative
fixture and re-run the suite. If the real shape differs from either
reconstructed variant, `src/services/*.ts` and/or `test/parse.test.ts` are
the only files that should need to change — if a fix has to touch
`src/soap/`, the seam boundary in the design has leaked and is worth
re-reading before patching around it.

Also unverified until that first live success: SAP's business-success-code
convention. `src/errors.ts`'s `classifyBusinessMessage` currently treats an
empty code or an all-zeros code (`"000"`) as success and anything else as a
business error, printed verbatim — this is a documented guess, not a
confirmed contract.

## Project layout

```
src/
  index.ts              composition root
  config.ts             env schema, PROD-safety gate, Secret wrapper
  errors.ts             error taxonomy -> exit codes
  soap/                 THE SEAM — envelope, parser, transport (domain-free)
  services/             what these two RFCs are (field maps, business rules)
  evidence/             run-dir + redaction + summary.json
  cli/                  banner + per-service report + final verdict
test/                   node:test, zero mocking, zero network
evidence/               gitignored except .gitkeep; one dir per run
```
