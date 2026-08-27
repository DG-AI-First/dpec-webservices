# dpec-sap-soap-client

Probe autónomo que consume los dos web services SOAP de DPEC
(`Z_WS_SAP_002` — últimas N facturas, `Z_FICA_DEUDA_IC_UNIF` — estado de
deuda unificado), demuestra si funcionan o no, y deja en disco la evidencia
cruda de lo que pasó por el cable.

Este documento es el traspaso para quien continúe la integración. Registra
lo que aprendimos **probando en vivo contra el sistema de DPEC**, no sólo
cómo correr el script — leé "Hallazgos empíricos" y "Bloqueo actual" antes
de tocar la capa SOAP.

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

## Hallazgos empíricos (en vivo contra QA, 27-08-2026)

Estos corrigen o resuelven las incógnitas del PDF de integración de DPEC. La
evidencia está en `evidence/spike-*/` y la produjeron los scripts de
diagnóstico que quedaron en la raíz del repo (`spike.mjs`,
`soapaction-test.mjs`, `wsdl-check.mjs`), conservados como instrumentos
reutilizables.

1. **`https://` es lo correcto, no `http://` como dice el documento.** El
   esquema en texto plano del PDF no funciona; la captura de SoapUI y todas
   nuestras llamadas en vivo usaron TLS. La cadena de certificados valida sin
   CA interna. `DPEC_SCHEME` default `https`, configurable por si alguna vez
   depende del ambiente.

2. **El `SOAPAction` quedó descartado como factor.** `soapaction-test.mjs`
   probó seis variantes contra el endpoint vivo de QA — omitido por
   completo, `""` entre comillas, vacío sin comillas, el nombre de la
   operación, el URN completo, y URN+`Request` — y **las seis devolvieron el
   fault byte por byte idéntico**. Sea lo que sea que está mal, no es ese
   header. El probe lo deja en `""` y mantiene la perilla
   (`DPEC_SOAP_ACTION`) por si cambia cuando el binding esté configurado.

3. **Los nombres de campo del PDF de DPEC son artefactos de un proxy .NET,
   no el formato del cable — este es el hallazgo más consecuente.** El
   documento lista nombres como `piIcField` y `totalAmntField` porque fue
   redactado desde una clase proxy de C# (la convención de backing field de
   `svcutil`/`xsd.exe`), no desde el XML real. **El formato real es
   PascalCase sin el sufijo `Field`**: `PiIc`, `TotalAmnt`, `IAnlage`,
   `ICantfact`.

   Importa muchísimo porque **SAP RFC ignora en silencio los elementos XML
   que no reconoce**: si mandás `<urn:piIcField>`, SAP no rechaza la
   llamada, trata el parámetro como vacío y devuelve un resultado *vacío*
   perfectamente creíble. Es una respuesta equivocada silenciosa,
   indistinguible de "este interlocutor no tiene deuda" si no conocés esto.

   `src/soap/envelope.ts` tiene un guard en runtime (`assertWireName`) que
   lanza error si alguna vez se pasa un nombre terminado en `Field` o que
   arranque en minúscula, justamente para que el error no pueda repetirse.

4. **Todos los valores se mantienen como string** (`parseTagValue: false`).
   Si dejás que el parser convierta, `exbel: 0090001234` se vuelve
   `90001234` y perdés los ceros a la izquierda de un documento legal de
   forma irreversible; `eMsgnro: '000'` se vuelve `0` y destruye la señal de
   éxito. La evidencia tiene que reproducir lo que SAP dijo, no una
   interpretación.

5. **Windows: nunca usar `process.exit()` acá.** Salir así mientras undici
   todavía tiene sockets cerrándose aborta el proceso con
   `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` y devuelve
   **127** en lugar del código calculado — o sea, destruye el contrato de
   exit codes, que es todo el valor de esta herramienta. La consola mostraba
   el número correcto y el proceso devolvía otro. `closeTransport()` libera
   los sockets y `index.ts` setea `process.exitCode`. Cubierto por
   `test/exit-contract.test.ts` contra un server local.

## Bloqueo actual (al 27-08-2026) — es de DPEC, en los dos ambientes

Los dos servicios devuelven **HTTP 500** en QA con un SOAP Fault:

```
Error en el tratamiento de servicio web; Más detalles en log de error de
servicio web en la página de proveedor (Cronomarcador UTC ...; ID de
transacción ...)
```

`wsdl-check.mjs` confirma que el nodo SICF **sí está activo**: un GET
autenticado a `?wsdl` devuelve HTTP 200 con un `<error>` propietario de SAP
(no un WSDL, no un 404) cuyo texto es:

```
WSP Exception caught: Initial value "config key"
```

Ese mensaje es el diagnóstico propio de SAP para **"este binding de web
service no tiene entrada de configuración en SOAMANAGER"**. Es decir: el
endpoint existe y autentica, pero nadie terminó de publicar el servicio del
lado de DPEC. No es algo que podamos arreglar nosotros.

En SAP son dos capas separadas y conviene tenerlas claras: **SICF** activa el
nodo HTTP (por eso responde y no da 404) y **SOAMANAGER** configura el
binding (por eso el `config key` vacío). El servicio está *expuesto* pero no
*configurado*.

Las credenciales agravan el bloqueo en vez de ofrecer una salida:

| Ambiente | Autenticación | Servicio configurado |
|---|---|---|
| QA (`sapqas.dpec.com.ar`) | autentica (usuario `WSMICTS`) | no — binding sin configurar |
| PROD (`sapprd.dpec.com.ar`) | **401, rechazada** | presumiblemente sí (las capturas de SoapUI del PDF de DPEC son contra PROD) |

O sea: las credenciales que tenemos son de QA, y QA es exactamente el
ambiente donde los servicios todavía no están publicados.

Verificado además **por una vía independiente del script**, desde el
navegador: en QA la URL completa con credenciales devuelve **HTTP 415**
(Unsupported Media Type — el endpoint existe, autentica, y rechaza el GET
vacío del navegador porque espera un POST con `text/xml`), y en PROD el
diálogo de usuario y contraseña reaparece indefinidamente, que es la forma
visual del 401. Si alguna vez se plantea que el problema es del cliente, ahí
está la respuesta sin código de por medio.

**Nota deliberada sobre PROD:** no se probaron variantes de credenciales
contra producción. Reintentar combinaciones de autenticación contra un SAP
productivo se ve idéntico a un intento de credential stuffing en los logs de
DPEC. Una llamada autorizada, un resultado, y se paró ahí. El 401 volvió en
158 ms, lo que confirma que la red y el TLS estaban bien y que sólo se
rechazó la credencial.

**Qué pedirle a DPEC, en orden de preferencia:**

1. **Publicar los dos servicios en QA** con el binding configurado en
   SOAMANAGER. Destraba todo el desarrollo sin tocar producción. Los
   `bindingKey` para que su equipo Basis los ubique en SRTUTIL:
   - `Z_WS_SAP_002` → `965CD95BF9BFFA65E10000000A010216`
   - `Z_FICA_DEUDA_IC_UNIF` → `3CB96C5571986D30E10000000A010228`
2. **Un juego de datos de prueba en QA**: qué número de instalación o
   interlocutor comercial tiene facturas cargadas. Sin esto, aunque
   configuren el binding, vamos a recibir una respuesta correcta con cero
   registros y no vamos a poder distinguir "anduvo" de "no anduvo".
3. Si nada de lo anterior es posible, **credenciales de PROD** — peor
   opción, porque obliga a desarrollar y probar contra el SAP productivo.

## Estado de los fixtures — leer antes de tocar `test/`

| Origen | Archivos | Estado |
|---|---|---|
| **Capturado** — bytes reales de QA | `evidence/spike-*` (faults SOAP y la página de error de SAP) | Datos genuinos del cable. Usados tal cual en `test/envelope.test.ts` y en el caso de detección de fault de `test/parse.test.ts`. |
| **Reconstruido** — nunca se observó una respuesta exitosa real | `test/zWsSap002.test.ts`, `test/zFicaDeudaIcUnif.test.ts`, y los casos sintéticos de 0/1/3 filas de `test/parse.test.ts` | Armados desde la lista de campos del PDF y el comportamiento de `fast-xml-parser`, **no desde una respuesta exitosa real de SAP**. Prueban nuestra normalización contra nuestra *suposición* del formato. Se cubren las dos variantes posibles (tabla plana y envuelta en `<item>`) precisamente porque no sabemos cuál emite SAP. |

**Tarea obligatoria cuando se destrabe el bloqueo y `npm run probe` devuelva
un HTTP 200 con datos:** promover los `evidence/run-*/*.response.xml` reales
a `test/fixtures/` como fixture autoritativo y volver a correr la suite.

Si el formato real difiere de las dos variantes reconstruidas, los únicos
archivos que deberían necesitar cambios son `src/services/*.ts` y
`test/parse.test.ts`. **Si un arreglo obliga a tocar `src/soap/`, la costura
se filtró** — conviene releer el diseño antes de parchar alrededor.

También queda sin verificar hasta ese primer éxito: la convención de códigos
de éxito de negocio de SAP. Hoy `classifyBusinessMessage` trata un código
vacío o todo ceros (`"000"`) como éxito y cualquier otra cosa como error de
negocio, imprimiéndolo tal cual. Es una suposición documentada, no un
contrato confirmado.

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
