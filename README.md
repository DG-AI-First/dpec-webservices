# dpec-sap-soap-client

Probe autónomo que consume los dos web services SOAP de DPEC
(`Z_WS_SAP_002` — últimas N facturas, `Z_FICA_DEUDA_IC_UNIF` — estado de
deuda unificado), demuestra si funcionan o no, y deja en disco la evidencia
cruda de lo que pasó por el cable.

Este documento es el traspaso para quien continúe la integración. Registra
lo que aprendimos **probando en vivo contra el sistema de DPEC**, no sólo
cómo correr el script — leé "Hallazgos empíricos" antes de tocar la capa
SOAP, y en particular "Corrección al diagnóstico anterior".

## Arranque rápido

```bash
npm install
cp .env.example .env         # completar SAP_USER / SAP_PASSWORD
npm run check                # tsc --noEmit
npm test                     # node:test, sin red, sin mocks
npm run dry                  # ejercita todo el pipeline, no manda nada
npm run probe                # EN VIVO — pega contra DPEC_ENV (qa por defecto)
```

Correr `npm run probe` con `DPEC_ENV=prod` exige además
`DPEC_CONFIRM_PROD=I_UNDERSTAND_THIS_HITS_PRODUCTION` en el entorno. Esa
fricción es deliberada, no un bug: un booleano como `true` es exactamente el
valor que llega copiando el `.env` de un compañero, y una frase así no se
tipea sin querer. La matriz completa de validación está en `src/config.ts`.

Cada corrida escribe en `evidence/run-<timestamp>/` (request y response XML
crudos, un `meta.json` por llamada, y `summary.json`) y copia el último
resumen a `evidence/latest-summary.json`. **`evidence/` está en `.gitignore`
salvo `.gitkeep`** — las capturas pueden contener datos de clientes.

> Detalle de git que conviene conocer: el patrón es `evidence/*`, no
> `evidence/`. Con la barra final, git no desciende al directorio ignorado y
> la negación `!evidence/.gitkeep` queda muerta.

Códigos de salida: `0` ambos servicios PASS · `2` el problema es nuestro
(configuración o credenciales, incluido un 401) · `3` se llegó a SAP y
contestó con fault o error de negocio · `4` falla de transporte (inalcanzable,
TLS, timeout). Ver `src/errors.ts`.

Los códigos contestan **quién actúa después**, y por eso un 401 es `2` y no
`4`: en un 401 la red anduvo, el TLS negoció y SAP contestó — mandar a
alguien a hablar con el equipo de redes sería la respuesta equivocada.

## La arquitectura, en un párrafo

El código optimiza una sola costura: **`src/soap/`** (cómo le hablamos SOAP
a SAP — reutilizable, sin dominio, esto se queda) contra **`src/services/`**
(qué son estos dos RFC puntuales — esto se reemplaza o se extiende).
`evidence/` y `cli/` son hojas que la integración real probablemente
descarte. `src/config.ts` se lee una sola vez, al arranque: `process.env` no
aparece en ningún otro lado.

La regla que sostiene todo: **ningún identificador de dominio puede aparecer
dentro de `src/soap/`**. Si `transport.ts` alguna vez menciona `tFact`, la
costura se filtró y el valor de reuso se perdió. Es verificable leyendo.

## Hallazgos empíricos (en vivo contra QA)

Estos corrigen las incógnitas del PDF de integración de DPEC. El punto de
quiebre fue el **28-08-2026**, cuando DPEC nos pasó las URLs de los WSDL: con
el contrato a la vista, los dos servicios pasaron a devolver HTTP 200 con
datos reales el mismo día. Los WSDL están promovidos a `test/fixtures/`.

1. **`https://` es lo correcto, no `http://` como dice el documento.** El
   esquema en texto plano del PDF no funciona. La cadena de certificados
   valida sin CA interna. `DPEC_SCHEME` default `https`.

   El `soap:address` del WSDL apunta a `http://erpqas2.dpec.com.ar:8002` — el
   host interno del SAP. Afuera hay un nginx que termina TLS sobre
   `sapqas.dpec.com.ar`. **No uses el address del WSDL**: es la dirección que
   ve DPEC puertas adentro, no la nuestra.

2. **El namespace del elemento de operación es
   `urn:sap-com:document:sap:soap:functions:mc-style`.** Éste fue el bug
   principal. `urn:sap-com:document:sap:rfc:functions` — el que usábamos,
   tomado del PDF — es sólo el schema de los TIPOS escalares (`char10`,
   `curr13.2`) y nunca es namespace de body. Con el equivocado, SAP devuelve
   HTTP 500 con un fault genérico que no nombra nada: "Error en el
   tratamiento de servicio web".

3. **Los hijos van SIN prefijo de namespace.** Ningún WSDL declara
   `elementFormDefault`, así que XML Schema lo toma como *unqualified*: sólo
   `<urn:ZWsSap002>` va calificado, `<IAnlage>` va pelado. Prefijarlos pone
   cada parámetro en un namespace donde SAP no mira — mismo 500 opaco.

4. **`ZFicaDeudaIcUnif` exige `PoDocumentos` y `PoMensaje` en el REQUEST.**
   En mc-style las tablas de salida del RFC están en la secuencia del
   elemento de entrada y no llevan `minOccurs="0"`: son obligatorias a la ida
   aunque sólo traigan datos a la vuelta. Sin ellas, con el namespace ya
   corregido, seguía dando 500 a los 145 ms. `ZWsSap002` **no** tiene esta
   particularidad: su elemento de entrada es sólo `IAnlage`, `ICantfact`,
   `IPartner`.

5. **PascalCase sin sufijo `Field`, también al LEER la respuesta.** El PDF
   lista `piIcField`, `totalAmntField` porque fue redactado desde una clase
   proxy de C# (`svcutil`/`xsd.exe`), no desde el XML. El cable dice `PiIc`,
   `TotalAmnt`, `IAnlage`.

   La mitad peligrosa de esto estaba del lado de la lectura: `removeNSPrefix`
   quita prefijos pero **no cambia mayúsculas**. Leer `responseNode.tFact`
   cuando el cable dice `TFact` da `undefined`, que `toArray()` convierte en
   `[]` — una respuesta vacía perfectamente creíble sobre una respuesta que
   traía diez facturas. `envelope.ts` tiene `assertWireName` para la
   escritura, y los tests por servicio tienen un caso "camelCase wire names
   are NOT accepted" para la lectura.

6. **El `SOAPAction` quedó descartado como factor.** `soapaction-test.mjs`
   probó seis variantes contra QA y las seis devolvieron el mismo fault byte
   por byte. El WSDL confirma `soapAction=""`. El probe lo deja en `""`.

7. **Todos los valores se mantienen como string** (`parseTagValue: false`).
   Confirmado contra datos reales: `Opbel: 000315264253` perdería los ceros,
   el `CodBarraVisual` de 36 dígitos se volvería notación científica, y un
   importe negativo (`-5517.9`, una nota de crédito) perdería precisión.

8. **`EMsgnro` es alfanumérico, no un número de tres dígitos.** El código real
   observado es `ZFICA017` (clase de mensaje ABAP + número). Los fixtures
   reconstruidos suponían `"042"`. `classifyBusinessMessage` no depende de que
   sea numérico, pero el supuesto estaba escrito.

9. **`ZWsSap002` valida que la instalación pertenezca al interlocutor.** Pasar
   `IAnlage` e `IPartner` que no se corresponden devuelve **HTTP 200** con
   `ZFICA017 — Instalación X diferente a recibida por parámetro Y` y `TFact`
   vacío. Dejar `IAnlage` vacío no saltea la validación. HTTP 200 no
   significa éxito: el veredicto sale del par `EMsgnro`/`EMsgtxt`, no del
   status.

10. **Con los dos parámetros vacíos, `ZWsSap002` se cuelga.** El RFC barre sin
    filtro y el nginx de DPEC corta a los **60 s** con un `504 Gateway
    Time-out` en HTML — no un fault de SAP. Con parámetros válidos responde en
    menos de un segundo. El `DPEC_TIMEOUT_MS` default de 30 s aborta antes de
    ver el 504; subilo si querés capturarlo como evidencia.

11. **Windows: nunca usar `process.exit()` acá.** Salir así mientras undici
    todavía tiene sockets cerrándose aborta el proceso con
    `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` y devuelve **127**
    en lugar del código calculado — destruye el contrato de exit codes, que es
    todo el valor de esta herramienta. `closeTransport()` libera los sockets e
    `index.ts` setea `process.exitCode`. Cubierto por
    `test/exit-contract.test.ts`.

### Corrección al diagnóstico anterior

Una versión previa de este README atribuía el bloqueo a DPEC: decía que el
binding no estaba configurado en SOAMANAGER, basándose en que un GET a
`<endpoint>?wsdl` devolvía `WSP Exception caught: Initial value "config key"`
en vez de un WSDL. **Esa conclusión era incorrecta.**

El error estaba en el razonamiento, no en la observación: el `?wsdl` sobre el
endpoint de runtime no es la URL de metadata de este sistema. La URL real
tiene otra forma —
`/sap/bc/srt/wsdl/flv_<id>/bndg_url/<path del endpoint>?sap-client=100` — y
sobre ella los dos servicios devuelven WSDL válido, HTTP 200. El binding
**siempre estuvo configurado**. Los 500 eran nuestros, por los puntos 2, 3 y 4.

Vale la pena tener presente cómo se sostuvo el error tanto tiempo: el fault de
SAP es genérico y no nombra el campo ni el namespace, así que no contradecía
ninguna hipótesis. Un mensaje compatible con todo no confirma nada — y
nosotros lo leímos como confirmación.

Lo único que sigue siendo cierto de aquel diagnóstico es que las credenciales
de PROD dan 401. No se probaron variantes: reintentar combinaciones contra un
SAP productivo se ve idéntico a credential stuffing en los logs de DPEC.

## Estado actual — los dos servicios funcionan

Corrida en vivo del 28-08-2026, `npm run probe` contra QA:

| Servicio | HTTP | Veredicto | Filas |
|---|---|---|---|
| `Z_FICA_DEUDA_IC_UNIF` | 200 | PASS | 1 documento, `[000] Estado de deuda devuelto correctamente` |
| `Z_WS_SAP_002` | 200 | PASS | 10 facturas, sin mensaje de negocio |

Para reproducirlo hacen falta datos de prueba coherentes en el `.env`:
`DPEC_ANLAGE` y `DPEC_PARTNER` **tienen que corresponderse** entre sí, o el
servicio contesta `ZFICA017` (ver hallazgo 9).

Queda una sola convención sin confirmar: la tabla completa de `Codigo` de
`Z_FICA_DEUDA_IC_UNIF`. Conocemos dos por evidencia — `000` (deuda devuelta) y
`001` (sin deuda), ambos éxito. Cualquier otro código hoy se trata como error
de negocio. Es un supuesto documentado en `summarize`, no un contrato: agregá
códigos ahí sólo con una respuesta capturada que los respalde.

## Estado de los fixtures — leer antes de tocar `test/`

| Origen | Archivos | Estado |
|---|---|---|
| **Real, autoritativo** | `test/fixtures/*.response.xml` + `test/live-responses.test.ts` | Respuestas capturadas de QA a HTTP 200. Esto es lo que SAP hace de verdad. |
| **Contrato** | `test/fixtures/*.wsdl.xml` | Los WSDL de QA. Toda duda de nombre, orden u obligatoriedad se resuelve acá, no en el PDF. |
| **Sintético** | casos de 0/1/3 filas en `test/parse.test.ts` y los tests por servicio | Cubren formas que el cable no nos mostró (tabla plana vs. envuelta en `<item>`). Se mantienen: SAP emite `<item>`, pero la defensa contra la coerción de arrays tiene que cubrir las dos. |

**Los fixtures reales están anonimizados.** Los números de documento,
referencias, códigos de barra y los dígitos dentro del texto de error pasan
por una permutación fija de 1-9 que **deja el 0 en su lugar** — el cero es
punto fijo a propósito, porque los ceros a la izquierda son justamente la
propiedad que esos tests defienden. Largos, decimales y signos se conservan.
Fechas e importes quedan intactos: no identifican a nadie. Los originales sin
tocar viven en `evidence/`, que está en `.gitignore`.

## Nota sobre la trampa de coerción de arrays

XML no tiene tipo array. Todo parser colapsa un elemento repetido único a un
escalar, y `poDocumentos`, `poMensaje` y `tFact` son tablas RFC que pueden
devolver legítimamente una sola fila.

Peor: con la lista de elementos configurada en el parser, un elemento
autocerrado (`<tFact/>`, o sea "no hay facturas") no da `[]` sino `['']` —
una lista **con un elemento**, un string vacío. Sin la normalización de
`toArray`, el probe reportaría `recordCount: 1` para una cuenta sin ninguna
factura: un número confiado y equivocado, en el archivo cuyo único propósito
es demostrar que las cosas funcionan.

Es el defecto más peligroso de este código porque **es invisible en una
corrida en vivo**: "una factura" es perfectamente plausible. Sólo lo cazan
fixtures de 0, 1 y 3 filas. Por eso `test/parse.test.ts` tiene 16 casos
dedicados a esto.

## Estructura del proyecto

```
src/
  index.ts              composition root
  config.ts             schema de env, puerta a PROD, wrapper Secret
  errors.ts             taxonomía de errores -> exit codes
  soap/                 LA COSTURA — envelope, parser, transport (sin dominio)
  services/             qué son estos dos RFC (mapeo de campos, reglas)
  evidence/             directorio por corrida + redacción + summary.json
  cli/                  banner + reporte por servicio + veredicto final
test/                   node:test, cero mocks, cero red
evidence/               ignorado por git salvo .gitkeep; un dir por corrida
```

## Seguridad

Las credenciales se leen sólo del entorno y nunca llegan a disco. Hay cuatro
capas, en orden de confiabilidad:

1. `Secret` (en `config.ts`) envuelve la contraseña: `toString`, `toJSON` y
   el inspect de Node devuelven `***REDACTED***`. La única salida es un
   `.reveal()` explícito, y hay un solo lugar que lo llama.
2. `RedactedHeaders` es un tipo marcado que sólo produce `redactHeaders()`.
   El escritor de evidencia **no compila** si le pasás headers crudos: la
   redacción es el único camino de entrada, no un filtro que alguien pueda
   olvidarse de llamar.
3. Denylist sin distinción de mayúsculas sobre `authorization`,
   `proxy-authorization`, `cookie` y `set-cookie`.
4. Barrido final sobre todo lo serializado, por si un fault de SAP o un
   proxy devuelve el header en el cuerpo.

Auditado sobre las corridas reales: ni la contraseña, ni el usuario, ni el
base64 del par aparecen en ningún archivo de evidencia.
