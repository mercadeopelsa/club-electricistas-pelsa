# Club de Electricistas PELSA — MVP 0.1

## Arquitectura

- React 19 + Vite; backend Express sobre Node.js 24.
- SQLite (integrado en Node) con transacciones, restricción UNIQUE para hash del DUI y contador de miembros.
- Documentos JPEG reencodificados (se eliminan metadatos), cifrados AES-256-GCM; DUI cifrado y HMAC para unicidad.
- Sesiones opacas almacenadas como hash en SQLite; contraseñas con scrypt; cookie HttpOnly, SameSite=Strict y Secure en producción.
- Una instancia del servicio. No distribuir SQLite entre múltiples nodos ni sincronizar la base activa con Google Drive.
- Perfil sin login; administrador con cuentas individuales del mismo nivel de permisos en este MVP.
- Tipografías empaquetadas localmente; no se envían datos a servicios externos al abrir el formulario.

## Archivos que se entregan

El ZIP contiene código, lockfile, configuración Docker, migración inicial, pruebas y documentación. Excluye `.env`, `.demo-access.txt`, `data/`, `node_modules/` y `dist/`. Las credenciales locales de demostración están fuera del ZIP. No copie la base de demostración al servidor.

## Desarrollo en Windows, macOS o Linux

Instalar Node.js 24 LTS (incluye npm). Dentro del proyecto:

```sh
npm install --global pnpm@11.19.0
pnpm install --frozen-lockfile
pnpm run setup
pnpm run admin
pnpm run dev
```

Use siempre `pnpm run` para los scripts del proyecto, especialmente `pnpm run setup`, para no invocar el comando de configuración propio de pnpm.

`setup` crea `.env` con una clave aleatoria sin reemplazar una configuración existente. `admin` solicita correo, nombre y una contraseña de al menos 12 caracteres; no modifica cuentas existentes. Cree una cuenta por cada persona autorizada. Todos los administradores pueden consultar documentos y editar contenido; los roles de cajero/canje no están implementados.

Para datos ficticios opcionales, únicamente sobre una base vacía y de desarrollo:

```sh
node --env-file=.env scripts/demo.mjs
```

Use el demo en lugar de `admin`, nunca después. Guarda el acceso generado en `.demo-access.txt` (privado, ignorado por Git). Crea dos personas identificadas como demostración y documentos marcados como prueba; el ZIP de entrega no incluye esa base.

## Producción con Docker (ruta elegida)

Requisitos del servidor: Docker Engine con Compose, disco local persistente, proxy HTTPS (Nginx o equivalente), dominio y certificado. Es un despliegue de una sola instancia.

1. Extraiga el ZIP y copie `.env.example` a `.env`.
2. Defina `APP_URL=https://clubdelelectricista.sv.grupopelsa.com` o el subdominio que IT confirme. Debe ser la URL pública definitiva, sin ruta.
3. Genere una clave aleatoria de 32 bytes en hexadecimal y colóquela como `DATA_KEY`. Con Node: `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. También puede usar `openssl rand -hex 32`. No publique la clave.
4. Construya y arranque:

```sh
docker compose up -d --build
docker compose exec club node scripts/admin.mjs
docker compose logs --tail 50 club
```

5. Configure Nginx con certificado válido y redirección HTTP→HTTPS. Use `deploy/nginx.conf.example` como fragmento del bloque HTTPS. El puerto del contenedor solo está expuesto en `127.0.0.1:4173` en el host.
6. Mantenga `TRUST_PROXY=true` solo si existe exactamente un proxy de confianza delante de la aplicación y este reemplaza X-Forwarded-For. El ejemplo de Nginx lo reemplaza. No exponga directamente el puerto del backend a Internet.
7. Confirme `https://DOMINIO/api/health`, `/registro` y `/admin`.

El contenedor establece COOKIE_SECURE=true, TRUST_PROXY=true, HOST=0.0.0.0 y DATA_DIR=/app/data. El servicio de producción se niega a iniciar con APP_URL sin HTTPS o cookies inseguras. No use ese modo para una demo HTTP sin proxy.

La construcción Docker no fue ejecutada en la computadora de desarrollo: Docker no estaba disponible. IT debe validar construcción e integración HTTPS en su servidor.

## Producción sin Docker

Instale Node.js 24 y las dependencias usando el lockfile. Compile con `pnpm run build`. Configure `.env` con APP_URL HTTPS, COOKIE_SECURE=true y TRUST_PROXY según el proxy. DATA_DIR debe apuntar a una carpeta privada con permiso solo para la cuenta de servicio. Ejecute `pnpm run start` bajo systemd, NSSM u otro supervisor. Sirva todo a través del proxy HTTPS. No use `pnpm run dev` públicamente.

## Configuración

| Variable | Uso |
| --- | --- |
| APP_URL | Origen público canónico. Valida solicitudes y genera enlaces/QR. |
| DATA_KEY | 64 caracteres hexadecimales. Cifra documentos/DUI y calcula su hash. |
| DATA_DIR | Carpeta privada persistente, fuera de archivos públicos. |
| PORT | 4173 por defecto. |
| HOST | 127.0.0.1 local; 0.0.0.0 dentro de Docker. |
| COOKIE_SECURE | true en HTTPS de producción. |
| TRUST_PROXY | true solo con un proxy de confianza. |

No cambie DATA_KEY en una instalación con datos sin una migración de recifrado: perdería acceso a DUI/documentos y la coherencia de deduplicación. Guarde la clave por separado en un gestor de secretos. El cifrado de aplicación no sustituye el control de acceso al servidor y a las copias. Nombre, correo y WhatsApp permanecen como campos legibles dentro de la base privada.

## Respaldos y restauración

Programar copias de todo DATA_DIR y conservar la clave correspondiente. Para una copia simple y coherente, detener escrituras antes de copiar.

Docker (ejemplo, ejecución desde la carpeta del proyecto):

```sh
mkdir backups
docker compose stop club
docker compose run --rm --no-deps --user root -v ./backups:/backup club sh -c 'tar -czf /backup/club-backup.tar.gz -C /app/data .'
docker compose start club
```

Renombre cada copia con fecha; el ejemplo reutiliza `club-backup.tar.gz`. Cifre las copias y restrinja sus permisos. Verifique el código de salida y reinicie el servicio incluso si falla el respaldo. Para instalación sin Docker, detenga el proceso y copie toda la carpeta DATA_DIR; después reinícielo. No copie solo `club.sqlite` mientras el servicio escribe porque SQLite utiliza WAL.

Para restaurar, use primero una instancia aislada, detenga el servicio, restaure todos los archivos de DATA_DIR, restablezca propietario/permisos y la DATA_KEY original, y arranque. Verifique lectura de un documento, perfiles, contador y login. La restauración sobre una instalación existente reemplaza sus datos; requiere una copia previa y autorización del responsable.

## Operación de mercadeo

1. El solicitante registra nombre, WhatsApp salvadoreño, correo, DUI y una fotografía del frente del DUI; se exige consentimiento.
2. Mercadeo ingresa a Miembros, abre la solicitud y coteja datos y documentos. La validación de formato no consulta el registro oficial de identidad ni realiza OCR.
3. Al aprobar se asignan número y token; el QR usa el enlace del perfil. Imprima QR únicamente después de configurar el dominio definitivo. Cambiar de servidor conservando dominio, base y clave conserva tarjetas. Cambiar de dominio exige mantener redirecciones del anterior o volver a imprimir.
4. El administrador puede activar correo y/o WhatsApp públicos. Nombre y número siempre están visibles en perfiles aprobados. Quien recibe el QR puede compartirlo.
5. Preparar WhatsApp abre un mensaje; no hay envío automático ni WhatsApp Business API.
6. La fotografía frontal del DUI puede descargarse para una carpeta de Google Drive con acceso restringido. No hay integración automática de Drive ni sincronización de la base.
7. Beneficios permite editar, ordenar y ocultar. Promociones permite imagen, condiciones, fechas y deshabilitación. El formulario de fechas usa explícitamente UTC−6; en base se guarda UTC.
8. Suspender oculta el perfil, y reactivar conserva número/token. Rechazar exige motivo. Para corregir fotos de una solicitud rechazada, coordinar un flujo administrativo de reemplazo en una siguiente iteración; no se permite una segunda solicitud con el mismo DUI.

## Importación privada desde Excel

El archivo no debe copiarse al repositorio. Guárdelo temporalmente en una carpeta privada del servidor y asegúrese de tener una copia reciente de `DATA_DIR`. Desde la carpeta de la aplicación ejecute:

```powershell
npm run import-members -- "C:\ruta\CLUB SS .xlsx"
```

La primera hoja debe tener exactamente las columnas `NOMBRE`, `WHATSAPP`, `CORREO` y `DUI`. La herramienta valida todas las filas antes de modificar la base, agrega el prefijo 503 a teléfonos de ocho dígitos, omite DUI repetidos dentro del archivo o ya existentes, asigna números correlativos y activa los perfiles inmediatamente. Los miembros importados no tienen fotografía del DUI almacenada.

El resultado se guarda dentro de `DATA_DIR/imports/` con nombre, número de miembro y URL del perfil. Esa carpeta y el archivo original contienen datos personales; manténgalos fuera de GitHub y con acceso restringido. La importación es idempotente: ejecutar el mismo archivo otra vez no duplica los miembros.

## Antes de abrir al público

- Crear cuentas reales y definir quién tendrá acceso a documentos; sin cuentas compartidas.
- Completar el aviso institucional de privacidad: contacto, retención y proceso de eliminación/corrección. El texto actual está identificado como versión de desarrollo.
- Definir beneficios finales y cargar promociones reales. La marca tipográfica actual es aproximada; sustituir con logotipo oficial cuando esté disponible.
- Activar respaldos, probar restauración y monitorear espacio en disco.
- Probar carga y documentos desde el dominio HTTPS, y que el proxy permita solicitudes de al menos 7 MB.
- Confirmar que rutas privadas devuelven 401 sin sesión y que los documentos nunca se sirven desde rutas públicas.
- Ajustar límites de solicitudes si varios usuarios comparten una IP: actualmente 10 registros por hora/IP y 10 intentos de login cada 15 minutos/IP.

## Alcance pendiente

No incluye integración con POS, puntos, logros automáticos, canjes, roles diferenciados ni OCR. Se almacena la recomendación pero no se acreditan recompensas. No hay restablecimiento de contraseña por correo ni MFA todavía; los accesos los administra IT.

Netlify no ejecuta este servidor persistente como una subida estática. Adoptarlo implica adaptar API a Functions y sustituir SQLite/archivos por almacenamiento persistente apropiado. Docker mantiene el código actual más fácil de trasladar al servidor propio.

## Validación y dependencias

`pnpm run test` ejecuta pruebas aisladas con documentos artificiales y elimina solo su carpeta temporal. `pnpm run build` compila la interfaz. `pnpm-lock.yaml` fija las versiones resueltas; `pnpm-workspace.yaml` autoriza scripts únicamente de esbuild y sharp.

Referencias: [Node.js](https://nodejs.org/en/download), [Netlify Functions](https://docs.netlify.com/build/functions/overview/).
