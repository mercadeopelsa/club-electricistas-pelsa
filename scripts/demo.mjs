// Development fixture only. Never import real customer documents here.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { db, dataDir, encrypt, duiHash, passwordHash } from '../server/db.mjs';
if (process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === 'true') throw new Error('Demo is disabled in production.');
if (db.prepare('SELECT id FROM members LIMIT 1').get() || db.prepare('SELECT id FROM admins LIMIT 1').get()) throw new Error('Demo requires an empty database. No changes made.');
const password = randomBytes(18).toString('base64url');
db.prepare('INSERT INTO admins (email,name,password) VALUES (?,?,?)').run('mercadeo@pelsa.local','Mercadeo · DEMO',await passwordHash(password));
const sample = await sharp(Buffer.from('<svg width="600" height="380" xmlns="http://www.w3.org/2000/svg"><rect width="600" height="380" fill="#e4e8de"/><text x="300" y="160" text-anchor="middle" fill="#414833" font-family="sans-serif" font-size="30">ARCHIVO DE PRUEBA</text><text x="300" y="220" text-anchor="middle" fill="#414833" font-family="sans-serif" font-size="22">NO ES UN DUI</text></svg>')).jpeg().toBuffer();
let profile;
for (let n=1;n<=2;n++) {
  const front=`${randomBytes(20).toString('hex')}.enc`, back=`${randomBytes(20).toString('hex')}.enc`;
  writeFileSync(path.join(dataDir,'documents',front),encrypt(sample)); writeFileSync(path.join(dataDir,'documents',back),encrypt(sample));
  const dui=`00000000${n}`; const token=n===1?randomBytes(24).toString('hex'):null;
  db.prepare('INSERT INTO members (name,email,whatsapp,dui_hash,dui_encrypted,front_file,back_file,consent_at,status,number,token,approved_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(n===1?'Miembro de demostración':'Solicitud de demostración',`demo${n}@example.test`,'50370000000',duiHash(dui),encrypt(Buffer.from(dui)),front,back,new Date().toISOString(),n===1?'approved':'pending',n===1?1:null,token,n===1?new Date().toISOString():null);
  if(token) profile=`${process.env.APP_URL}/m/${token}`;
}
db.prepare("UPDATE counters SET value=1 WHERE name='member'").run();
const access=`ACCESO LOCAL DE DEMOSTRACIÓN — PELSA\n\nRegistro: ${process.env.APP_URL}/registro\nAdministrador: ${process.env.APP_URL}/admin\nCorreo: mercadeo@pelsa.local\nContraseña: ${password}\nPerfil de ejemplo: ${profile}\n\nDatos ficticios. No compartir estas credenciales ni la carpeta data con clientes.\nLa entrega ZIP para IT excluye estos accesos y datos.\nEn producción se crea un administrador nuevo con npm run admin.\n`;
writeFileSync('.demo-access.txt',access,{mode:0o600});
console.log('Demo creada. Acceso guardado en .demo-access.txt.'); db.close();
