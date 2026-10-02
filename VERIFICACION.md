# Verificación del MVP — 2 de octubre de 2026

## Resultado

La aplicación compila y los flujos principales funcionan con datos ficticios. No se publicaron datos ni se conectó el sistema a servicios externos.

## Pruebas automatizadas

Ejecutadas con `pnpm run test`: 4 pruebas aprobadas, 0 fallidas.

- Registro pendiente con dos imágenes, normalización y rechazo de DUI duplicado.
- Rechazo de archivos inválidos y códigos de recomendación inexistentes sin dejar archivos huérfanos.
- Aprobación con número correlativo, token aleatorio y perfil público limitado.
- Correo y WhatsApp ocultos inicialmente y visibles solo cuando el administrador los habilita.
- Descarga de documentos y QR únicamente con sesión administrativa.
- Suspensión y reactivación sin cambiar el número ni el enlace del miembro.
- Promociones publicadas únicamente cuando están activas y dentro de sus fechas.
- Beneficios ocultos excluidos de las vistas públicas.
- Cierre de sesión invalidado en el servidor.

## Pruebas en navegador

- Formulario en escritorio y móvil, incluyendo carga de ambas imágenes con archivos artificiales.
- Confirmación visual de solicitud recibida.
- Inicio de sesión del administrador local.
- Revisión y aprobación de una solicitud ficticia.
- Generación de número de miembro y acceso a la tarjeta digital.
- Perfil móvil sin desplazamiento horizontal.
- Administrador móvil con navegación compacta y tabla contenida en desplazamiento interno.
- La búsqueda WebMCP del administrador acepta una consulta válida, filtra la lista y rechaza una entrada inválida.

## Construcción

`pnpm run build` completó correctamente. Las tipografías se incluyen dentro del paquete; la interfaz pública no necesita cargarlas desde Google Fonts.

## Comprobaciones de privacidad y acceso

- `/api/admin/members` devuelve 401 sin sesión.
- `/api/admin/members/:id/documents/:side` devuelve 401 sin sesión.
- `.env`, `.demo-access.txt` y `data/club.sqlite` están bloqueados por el servidor de desarrollo.
- El ZIP para IT excluye `.env`, `.demo-access.txt`, `data/`, `node_modules/` y `dist/`.
- Las fotos se reencodifican a JPEG antes de cifrarse, lo que elimina metadatos del archivo original.
- DUI y documentos se cifran con AES-256-GCM. El hash usado para detectar duplicados es un HMAC con la clave de la instalación.

## Validaciones pendientes de IT

- Construcción de la imagen Docker: Docker no estaba instalado en la computadora de desarrollo.
- Configuración del subdominio, HTTPS y proxy inverso.
- Copia automática y prueba de restauración del volumen persistente.
- Monitoreo del servicio, espacio en disco y alertas.
- Política institucional de privacidad, retención y eliminación de fotografías del DUI.
- Sustitución de la marca tipográfica por el archivo oficial del logotipo cuando esté disponible.

## Alcance que continúa pendiente

La integración con POS, puntos, logros, canjes, WhatsApp Business, roles diferenciados e importación del Excel no forman parte de este MVP. El código de recomendación se conserva, pero todavía no concede beneficios.
