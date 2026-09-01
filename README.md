# dpec-sap-soap-client

API HTTP que traduce los web services SOAP de SAP de DPEC a JSON. Le pasás un
DNI y te devuelve la deuda o las facturas de esa persona, resolviendo por
dentro el encadenamiento de tres servicios SAP y traduciendo sus errores a
status HTTP que un cliente puede leer.

Si venís a **consumir** la API, alcanza con las dos primeras secciones. Si
venís a **tocar la capa SOAP**, leé antes "Antes de tocar `src/soap/`": ahí
está lo que aprendimos probando en vivo contra el sistema de DPEC, y hay
trampas que no se ven en el código.

## Arranque rápido

```bash
npm install
cp .env.example .env    # completar SAP_USER / SAP_PASSWORD
npm start               # levanta en PORT (3000 por defecto)
```

```bash
curl "http://127.0.0.1:3000/api/deuda?dni=30955882"
```

Contra `DPEC_ENV=prod` hace falta además
`DPEC_CONFIRM_PROD=I_UNDERSTAND_THIS_HITS_PRODUCTION` en el entorno. Esa
fricción es deliberada: un booleano como `true` es exactamente el valor que
llega copiando el `.env` de un compañero, y una frase así no se tipea sin
querer. La matriz completa está en `src/config.ts`, que es el único archivo
del repo que lee `process.env`.

## La API

Tres endpoints. Todo devuelve JSON.

| Método | Ruta | Qué hace |
|---|---|---|
| `GET` | `/health` | Responde `{"status":"ok"}`. No toca SAP. |
| `GET` | `/api/deuda?dni=<n>` | Facturas **impagas** de esa persona. |
| `GET` | `/api/facturas?dni=<n>` | Últimas N facturas, incluidas pagadas y notas de crédito. |

Respuesta exitosa de `/api/deuda`:

```json
{
  "partner": "0030002708",
  "documentos": [
    {
      "budat": "2016-07-06",
      "faedn": "2016-08-08",
      "xblnr": "0000B17268099A",
      "ltext": "Factura ISU",
      "betrw": "26.58",
      "totalAmnt": "26.58",
      "codBarraVisual": "389000472224651608081000000000026585"
    }
  ]
}
```

`/api/facturas` devuelve la misma forma con la clave `facturas` en lugar de
`documentos`, y filas de `{ opbel, exbel, faedn, totalAmnt }`.

**Todos los valores numéricos viajan como string, a propósito.** `partner` y
`xblnr` tienen ceros a la izquierda que un `number` destruiría, y el código de
barras de 36 dígitos se volvería notación científica. No los conviertas.

### Errores

Siempre con la misma forma: `{"error": {"codigo": "...", "mensaje": "..."}}`.

| Status | `codigo` | Cuándo |
|---|---|---|
| `400` | `DNI_INVALIDO` | Falta el parámetro `dni`, está vacío o no es numérico. |
| `404` | `NO_ENCONTRADO` | SAP respondió, pero ese DNI no resolvió a ningún cliente. |
| `404` | `RUTA_NO_ENCONTRADA` | La ruta no existe. |
| `409` | el código de SAP, verbatim | Error de negocio. Ej: `E9011` cuando el cliente está desconectado. El `mensaje` es el texto que mandó SAP. |
| `502` | `AUTH_RECHAZADO` · `SOAP_FAULT` · `TRANSPORTE` · o el `OU_RESULTADO` crudo | SAP rechazó, falló o contestó algo que no sabemos interpretar. |
| `504` | `TIMEOUT` | SAP no contestó dentro del plazo. Ver la advertencia de abajo. |
| `500` | `CONFIG_ERROR` · `ERROR_INESPERADO` | El problema es nuestro. |

> **El `504` no significa "el DNI no existe".** El servicio de resolución de
> SAP no tiene respuesta "no encontrado": ante un DNI bien formado pero
> inexistente **se cuelga y no contesta nunca**. Por eso el server tiene su
> propio plazo (`DPEC_SERVER_DEADLINE_MS`, 15 s) que corta antes que el
> timeout SOAP y devuelve `504`. Devolver `404` ahí sería inventar información
> que no tenemos: lo único que sabemos es que SAP no respondió.
>
> `loadConfig()` rechaza el arranque si `DPEC_SERVER_DEADLINE_MS` no es menor
> que `DPEC_TIMEOUT_MS`, porque si no el corte no llegaría a ocurrir nunca.

### Lo que la API todavía NO hace

- **No tiene autenticación de ningún tipo.** Cualquiera que llegue al puerto
  consulta la deuda de cualquier DNI, y los DNI son secuenciales: un `for` de
  20000000 a 45000000 es un padrón completo de clientes con su deuda. **No la
  expongas sin resolver esto.** Qué corresponde (API key, login real, o
  quedar detrás de un gateway de DPEC) depende de quién la consuma.
- **No tiene rate limiting.** Es un problema distinto de la autenticación: un
  cliente autenticado también puede enumerar.
- El camino feliz de `/api/facturas` nunca se pudo verificar en vivo, porque
  el único DNI de prueba que tenemos es de un cliente dado de baja en 2012.
  Hace falta pedirle a DPEC un DNI de cliente **conectado**.

## Cómo comprobar que funciona

Tres niveles, de más barato a más convincente.

```bash
npm run check   # tsc --noEmit
npm test        # 169 tests
npm start       # y después el curl de arriba, contra QA de verdad
```

Sobre `npm test`: **no hay mocks, no hay red y no hay stubs inventados.** Los
fixtures de `test/fixtures/*.response.xml` son respuestas reales capturadas de
QA, y los `*.wsdl.xml` son los contratos reales. Eso significa que si los
tests pasan, el parser maneja lo que SAP realmente manda, no lo que nosotros
supusimos que manda — que es exactamente el error que costó semanas acá.

Los tests del server levantan un `node:http` en un puerto efímero con un SAP
falso; tampoco salen a la red.

El `curl` es el único de los tres que prueba el sistema entero. Si devuelve
`200` con una factura, andan las credenciales, el TLS, el envelope, los tres
mapeos de campos y el encadenamiento.

## Arquitectura

```
src/
  server.ts     composition root: levanta el HTTP, cierra sockets al salir
  config.ts     schema de env, puerta a PROD, wrapper Secret. Único lector de process.env
  errors.ts     clasificación de errores de SAP
  http/         ruteo, plazo propio, mapeo de outcomes a status HTTP
  flows/        el encadenamiento DNI -> PARTNER -> deuda/facturas
  services/     qué son estos tres RFC: nombres de campo y reglas de negocio
  soap/         LA COSTURA: envelope, parser, transport. Sin dominio
test/           node:test, sin mocks, sin red
docs/           hallazgos técnicos y el informe entregado a DPEC
```

La costura que sostiene todo es **`soap/` contra `services/`**: `soap/` sabe
hablar SOAP y no sabe nada de deuda ni de facturas; `services/` sabe qué son
estos RFC y no sabe nada de HTTP ni de sockets. La regla es verificable
leyendo: **si algún día `transport.ts` menciona `tFact`, la costura se
filtró.**

Por eso agregar un cuarto servicio SAP es escribir un archivo en `services/`
con `buildFields` / `parseResult` / `summarize`, y nada más.

`flows/` recibe la capacidad de llamar SOAP como parámetro, así que se testea
entero con funciones falsas y cero mocking.

### Los tres servicios SAP

| Servicio | Para qué | Necesita |
|---|---|---|
| `ZZCS_INFO_IC_WS` | DNI/CUIT → interlocutor comercial (`PARTNER`) + instalación (`ANLAGE`) | el DNI |
| `Z_FICA_DEUDA_IC_UNIF` | Deuda impaga | sólo el `PARTNER` |
| `Z_WS_SAP_002` | Últimas N facturas | `PARTNER` **e** `ANLAGE` activos |

**Los dos últimos no son intercambiables**, y es el error más fácil de
cometer acá. `Z_WS_SAP_002` exige una instalación activa y valida que
corresponda al interlocutor: para un cliente dado de baja responde `E9011` y
no hay parámetro que lo arregle. `Z_FICA_DEUDA_IC_UNIF` no necesita la
instalación (su `PiI` es opcional) y funciona igual con clientes
desconectados. Para "consultá tu deuda por DNI", el correcto es el segundo.

## Antes de tocar `src/soap/`

Estas son las cosas que se verificaron en vivo contra QA y que no se deducen
leyendo el código. El detalle largo está en
[`docs/hallazgos-tecnicos.md`](docs/hallazgos-tecnicos.md).

1. **Los hijos del elemento de operación van SIN prefijo de namespace.**
   Ningún WSDL declara `elementFormDefault`, así que XML Schema lo toma como
   *unqualified*: sólo `<urn:ZWsSap002>` va calificado, `<IAnlage>` va pelado.
   Prefijarlos pone cada parámetro donde SAP no mira, y SAP contesta HTTP 500
   con un fault genérico que no nombra nada: *"Error en el tratamiento de
   servicio web"*.

2. **El namespace y el `SOAPAction` son de cada servicio, no del sistema.** No
   hay un valor global. `Z_WS_SAP_002` y `Z_FICA_DEUDA_IC_UNIF` usan
   `...:soap:functions:mc-style` con `SOAPAction` vacío; `ZZCS_INFO_IC_WS` usa
   `...:sap:rfc:functions` con `SOAPAction` no vacío. Cada uno declara el suyo
   en su `SoapOperation`. Copiar el de otro servicio es un 500 opaco.

3. **Los nombres de campo salen del WSDL, nunca del PDF de integración de
   DPEC.** Ese PDF fue redactado desde una clase proxy de C# y está equivocado
   en mayúsculas y en contenido (lista `piIcField`, `totalAmntField`; el cable
   dice `PiIc`, `TotalAmnt`). Los WSDL reales están en `test/fixtures/`.

   La mitad peligrosa está al **leer**: `removeNSPrefix` quita prefijos pero
   no cambia mayúsculas. Leer `responseNode.tFact` cuando el cable dice
   `TFact` da `undefined`, que `toArray()` convierte en `[]` — una respuesta
   vacía perfectamente creíble sobre una que traía diez facturas. Cada
   servicio tiene un test "camelCase wire names are NOT accepted" para esto.

4. **`ZFicaDeudaIcUnif` exige `PoDocumentos` y `PoMensaje` en el REQUEST.** En
   mc-style, las tablas de salida del RFC están en la secuencia del elemento
   de entrada y no llevan `minOccurs="0"`: son obligatorias a la ida aunque
   sólo traigan datos a la vuelta. Sin ellas da 500 a los 145 ms.

5. **HTTP 200 no significa éxito.** Los errores de negocio viajan in-band:
   `Z_WS_SAP_002` los manda en `EMsgnro`/`EMsgtxt`, `ZFICA_DEUDA_IC_UNIF` en
   `PoMensaje`, `ZZCS_INFO_IC_WS` en `OU_RESULTADO`. Siempre hay que leerlos.

6. **`EMsgnro` es alfanumérico**, no un número de tres dígitos: SAP devuelve
   clase de mensaje ABAP más número, como `ZFICA017`.

7. **Todos los valores se mantienen string** (`parseTagValue: false`), por los
   ceros a la izquierda, el código de barras de 36 dígitos y los importes
   negativos de las notas de crédito.

8. **La trampa de coerción de arrays.** XML no tiene tipo array, y las tablas
   RFC pueden devolver legítimamente una sola fila. Peor: un elemento
   autocerrado (`<TFact/>`, o sea "no hay facturas") no da `[]` sino `['']` —
   una lista con un elemento. Sin `toArray()`, un cliente sin facturas
   reportaría una. Es el defecto más peligroso de este código porque **es
   invisible en una corrida en vivo**: "una factura" es perfectamente
   plausible. `test/parse.test.ts` tiene 16 casos dedicados a esto.

9. **No uses el `soap:address` del WSDL.** Apunta a
   `http://erpqas2.dpec.com.ar:8002`, el host interno de SAP. Desde afuera hay
   un nginx que termina TLS sobre `sapqas.dpec.com.ar`. Y es `https`, no
   `http` como dice el PDF.

10. **Windows: nunca `process.exit()` acá.** Salir con sockets de undici
    todavía cerrándose aborta el proceso con
    `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` y devuelve 127.
    `closeTransport()` los libera y `src/server.ts` la llama en el shutdown
    (SIGTERM/SIGINT) antes de dejar terminar al proceso. Cubierto por
    `test/transport.test.ts`. La entrega real de señales del SO no tiene test
    automatizado: en Windows con MSYS bash no llegan de forma confiable al
    handler de Node. **Verificalo en el target real de deploy.**

## Códigos de negocio sin confirmar

Dos tablas de códigos de SAP siguen siendo desconocidas, y ambas se tratan
con la misma regla: **sólo se da por bueno lo que tiene una respuesta
capturada que lo respalde.**

- `ZFICA_DEUDA_IC_UNIF` → `Codigo`: conocemos `000` (deuda devuelta) y `001`
  (sin deuda), ambos éxito.
- `ZZCS_INFO_IC_WS` → `OU_RESULTADO`: conocemos `0` (éxito) y `99` (entrada
  vacía, cero filas, HTTP 200).

Cualquier otro código se reporta como error de negocio con su valor verbatim,
en vez de suponerle un significado. Si agregás uno a la lista de éxitos,
agregá también el fixture que lo justifica.

## Seguridad

Las credenciales se leen sólo del entorno y nunca llegan a disco.

`Secret` (en `config.ts`) envuelve la contraseña: `toString`, `toJSON` y el
inspect de Node devuelven `***REDACTED***`. La única salida es un `.reveal()`
explícito, y hay un solo lugar que lo llama. Un `console.log(config)` no puede
filtrarla.

Las credenciales de PROD daban 401 la última vez que se probaron. No se
probaron variantes a propósito: reintentar combinaciones contra un SAP
productivo se ve idéntico a credential stuffing en los logs de DPEC.

Ver también "Lo que la API todavía NO hace", más arriba: hoy no hay
autenticación de clientes.

## Datos de prueba

El único DNI de prueba conocido es **30955882**, que resuelve a
`PARTNER 0030002708` / `ANLAGE 0060002445` y tiene una factura impaga de
$26,58. Es un cliente **desconectado desde 2012**, así que sirve para
`/api/deuda` pero no para `/api/facturas`.

`evidence/` guarda capturas crudas de corridas viejas y está en `.gitignore`
porque contienen datos de clientes sin anonimizar.
