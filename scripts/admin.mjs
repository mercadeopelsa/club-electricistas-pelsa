import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { db, passwordHash, audit } from '../server/db.mjs';
const rl = createInterface({ input: stdin, output: stdout });
try {
  const email = (await rl.question('Correo del administrador: ')).trim().toLowerCase();
  const name = (await rl.question('Nombre: ')).trim();
  stdout.write('Contraseña (mínimo 12 caracteres; entrada oculta): ');
  let password = '';
  if (stdin.isTTY) {
    rl.close(); stdin.setRawMode(true); stdin.resume();
    password = await new Promise((resolve, reject) => {
      const handler = (chunk) => {
        for (const c of chunk.toString()) {
          if (c === '\u0003') { stdin.off('data', handler); stdin.setRawMode(false); reject(new Error('Cancelado')); return; }
          if (c === '\r' || c === '\n') { stdin.off('data', handler); stdin.setRawMode(false); stdin.pause(); stdout.write('\n'); resolve(password); return; }
          if (c === '\u007f' || c === '\b') password = password.slice(0, -1);
          else password += c;
        }
      }; stdin.on('data', handler);
    });
  } else { password = await rl.question(''); }
  if (!/^\S+@\S+\.\S+$/.test(email) || !name || password.length < 12) throw new Error('Revisa correo, nombre y longitud de contraseña.');
  const existing = db.prepare('SELECT id FROM admins WHERE email=?').get(email);
  if (existing) throw new Error('Ya existe ese administrador. No se cambió su contraseña.');
  db.prepare('INSERT INTO admins (email,name,password) VALUES (?,?,?)').run(email, name, await passwordHash(password));
  audit('CLI', 'admin.created', email); console.log('Administrador creado. Abre /admin.');
} finally { rl.close(); db.close(); }
