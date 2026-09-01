# Hallazgos técnicos

Detalle largo que no entra en un comentario de 1-3 líneas. Los comentarios
inline apuntan acá; este archivo no repite lo que ya dice el código.

## Convencion de nombres de campo en el cable

Dos dialectos de nombre de campo coexisten en los WSDL reales de QA, ambos
verificados contra el WSDL, no reconstruidos desde un doc:

- **PascalCase** (`PiIc`, `TFact`) — el generador RFC-a-SOAP de los servicios
  mc-style (`ZFicaDeudaIcUnif`, `ZWsSap002`) pone en Title Case el nombre del
  parámetro ABAP.
- **UPPER_SNAKE** (`IN_NUMERO`, `OU_INFO_IC_WS`) — el WSDL de `ZZCS_INFO_IC_WS`
  emite el nombre del parámetro RFC de ABAP tal cual, con guiones bajos.

Ambos dialectos prohíben lo mismo: una minúscula inicial, y (en UPPER_SNAKE)
un guion bajo inicial, final o doble — eso es un error de transcripción, no
una convención que SAP haya emitido alguna vez.

El sufijo `Field` es aparte: es un artefacto del proxy .NET (svcutil/xsd.exe)
y nunca va al cable en ningún dialecto.

Los nombres de campo de este repo salen siempre del WSDL real, nunca del PDF
de integración de DPEC — ese PDF se generó desde una clase proxy .NET y está
mal tanto en mayúsculas como en contenido (ejemplo real: el PDF listaba un
campo `EAnlage` en `ZsficaFacturas` que no existe en el WSDL).

`removeNSPrefix` (soap/parser.ts) saca el prefijo de namespace pero NO cambia
mayúsculas/minúsculas. Leer `tFact` cuando el cable dice `TFact` da
`undefined`, y `toArray()` convierte ese `undefined` en `[]` — un resultado
vacío perfectamente plausible en vez de un error visible. Ese es el bug
silencioso que la suite de tests existe para impedir.

## La trampa de coercion de arrays (array-coercion trap)

`fast-xml-parser` colapsa un elemento repetido a un escalar cuando aparece
una sola vez en el XML — un problema conocido de cualquier parser XML->JSON.

Lo que no es obvio, descubierto empíricamente escribiendo test/parse.test.ts:
cuando un nombre de elemento está en el allowlist `isArray` del parser, un
elemento AUTO-CERRADO se coerciona a un array de UN elemento con un sentinel
string vacío (`['']`), no a un array vacío.

Por eso `toArray()` (soap/parser.ts) tiene que aplanar tanto el caso sentinel
como el caso item-wrapped (`{ item: [...] }`), y hacerlo tanto si el valor ya
llegó como array como si no. La tabla completa de casos (undefined, '', {},
[''], item-wrapped, etc.) vive en los títulos de test/parse.test.ts.

## Namespace y SOAPAction por servicio

No existe un namespace ni un SOAPAction global: cada WSDL declara el suyo, y
usar el de otro servicio da un HTTP 500 opaco.

| Servicio | namespace (targetNamespace) | soapAction |
|---|---|---|
| `ZFicaDeudaIcUnif` | `urn:sap-com:document:sap:soap:functions:mc-style` | `''` |
| `ZWsSap002` | `urn:sap-com:document:sap:soap:functions:mc-style` | `''` |
| `ZZCS_INFO_IC_WS` | `urn:sap-com:document:sap:rfc:functions` | `urn:sap-com:document:sap:rfc:functions:ZZCS_INFO_IC_WS:ZZCS_INFO_IC_WSRequest` |

No hay override global: `AppConfig.soapAction` / `DPEC_SOAP_ACTION` se
sacaron de config.ts porque un único valor de config no puede ser correcto
para los tres servicios a la vez. La fuente de verdad es siempre
`SoapOperation.soapAction`, por operación (ver src/index.ts).

## Privacidad de los fixtures

Los fixtures de test/fixtures/ son respuestas reales de QA, con los datos
personales ofuscados así:

- Dígitos permutados con una permutación fija de 1-9, con el 0 como punto
  fijo (0 -> 0). El 0 se deja fijo a propósito: los ceros a la izquierda son
  justo la propiedad que estos tests existen para defender, y una permutación
  que los moviera borraría en silencio el objeto de la aserción.
- Longitud, cantidad de decimales y signo se preservan por la misma razón.
- Fechas y montos quedan sin tocar (no identifican a nadie).
- La respuesta de `ZZCS_INFO_IC_WS` además trae nombre y domicilio reales
  (`NAME1_TEXT`, `STREET_IC/IN`, `HOUSE_NUM1_IC/IN`, `CITY1_IC/IN`,
  `POST_CODE1_IC/IN`) — campos que los dos servicios mc-style nunca
  devuelven. Esos van `[REDACTED ...]` directo, no permutados: un nombre o
  una calle no tiene "ceros a la izquierda" que preservar, y permutar letras
  no le sacaría el valor identificatorio como sí hace con una cadena de
  dígitos. `PARTNER`, `ANLAGE`, `IDNUMBER_DNI` y `ABLEINH` siguen la regla de
  permutación de dígitos de arriba, porque su fidelidad de string (ceros a la
  izquierda, longitud) es justo lo que esos tests defienden.
- Los originales sin modificar quedan en `evidence/`, que está en
  `.gitignore`.
