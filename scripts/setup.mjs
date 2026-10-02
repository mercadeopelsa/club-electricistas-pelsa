import { existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
if (existsSync('.env')) { console.log('.env ya existe. No se modificó.'); }
else {
  writeFileSync('.env', `PORT=4173\nHOST=127.0.0.1\nAPP_URL=http://localhost:4173\nDATA_DIR=./data\nDATA_KEY=${randomBytes(32).toString('hex')}\nCOOKIE_SECURE=false\nTRUST_PROXY=false\n`, { mode: 0o600 });
  console.log('Configuración creada. Ahora ejecuta npm run admin para crear tu acceso.');
}
