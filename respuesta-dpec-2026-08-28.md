**Asunto:** Re: Web Services QAS — resuelto, y consulta por CUIT

Buen día,

Gracias por los WSDL. Con esas URLs quedó resuelto: **los dos servicios
responden HTTP 200 con datos en QAS.** El HTTP 500 era un desajuste nuestro al
armar el mensaje SOAP, nada del ambiente ni de la configuración de los servicios.

Probamos con desarrollo propio en Node.js y lo verificamos también desde SoapUI
con los WSDL que nos pasaron. Mismo resultado por los dos caminos.

**Nuestra consulta:**

Los dos servicios se consultan con el **interlocutor comercial**, y
`Z_WS_SAP_002` además pide el **número de instalación**.

El dato con el que trabajamos nosotros es el **CUIT**: es lo que trae el sistema
de Mi Corrientes. Las preguntas concretas son:

1. **¿Existe forma de matchear CUIT o DNI contra estas consultas?** Sea porque
   `IPartner` / `PiIc` los acepte directamente, o mediante un servicio que reciba
   el CUIT y devuelva el interlocutor comercial.

   Lo preguntamos porque el título de `Z_WS_SAP_002` menciona "por el número de
   Interlocutor comercial o el DNI", pero entre los parámetros no encontramos
   ningún campo de DNI ni de CUIT.

2. **¿El interlocutor comercial y el número de instalación figuran impresos en la
   factura?** Si el cliente los tiene a mano, podemos pedírselos en pantalla. Si
   son códigos internos de SAP, necesitamos resolverlos desde el CUIT.

**Un dato que puede ayudar:** el RFC ya resuelve el interlocutor a su instalación
por su cuenta. Si le enviamos una instalación que no corresponde, nos responde
`ZFICA017 — Instalación 10099046 diferente a recibida por parámetro 10099044`, y
ese primer número no se lo enviamos nosotros. ¿Sería posible que use esa
instalación cuando `IAnlage` llegue vacío, en lugar de rechazar la llamada?

Por último, nos vendrían bien **algunos pares de interlocutor e instalación de
QAS** que se correspondan, incluyendo una cuenta sin deuda: es el único caso que
todavía no pudimos probar.

Quedamos a disposición.

Saludos.
