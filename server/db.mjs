import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

export const dataDir = path.resolve(process.env.DATA_DIR || './data');
mkdirSync(path.join(dataDir, 'documents'), { recursive: true });
mkdirSync(path.join(dataDir, 'promotions'), { recursive: true });
const keyText = process.env.DATA_KEY || '';
if (!/^[a-f0-9]{64}$/i.test(keyText)) throw new Error('DATA_KEY missing or invalid. Run npm run setup.');
const key = Buffer.from(keyText, 'hex');
export const db = new DatabaseSync(path.join(dataDir, 'club.sqlite'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
db.exec(readFileSync(new URL('./migrations/001-initial.sql', import.meta.url), 'utf8'));
export function encrypt(data) {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
}
export function decrypt(data) {
  const buffer = Buffer.from(data); const decipher = createDecipheriv('aes-256-gcm', key, buffer.subarray(0, 12));
  decipher.setAuthTag(buffer.subarray(12, 28));
  return Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]);
}
export function duiHash(value) { return createHmac('sha256', key).update(value).digest('hex'); }
export function normalizeDui(value) { return String(value).replace(/[\s-]/g, ''); }
export async function passwordHash(value) {
  const salt = randomBytes(16).toString('hex');
  const digest = await promisify(scrypt)(value, salt, 64);
  return `${salt}:${digest.toString('hex')}`;
}
export async function passwordMatches(value, stored) {
  const [salt, expected] = stored.split(':');
  const digest = await promisify(scrypt)(value, salt, 64);
  return timingSafeEqual(digest, Buffer.from(expected, 'hex'));
}
export function audit(actor, action, target = '') {
  db.prepare('INSERT INTO audit (actor,action,target) VALUES (?,?,?)').run(actor, action, String(target));
}

if (!db.prepare('SELECT id FROM benefits LIMIT 1').get() && !db.prepare("SELECT value FROM settings WHERE key='seeded'").get()) {
  const insert = db.prepare('INSERT INTO benefits (title,description,icon,position) VALUES (?,?,?,?)');
  [
    ['Participación en eventos', 'Encuentros para conectar con otros profesionales y conocer novedades del sector.', 'calendar'],
    ['Capacitación continua', 'Oportunidades para seguir aprendiendo y fortalecer tus conocimientos.', 'graduation'],
    ['Descuentos exclusivos', 'Conoce las promociones y condiciones especiales disponibles para miembros.', 'tag'],
    ['Asesoría especializada', 'Acompañamiento para elegir los productos que necesitas en tus proyectos.', 'headset']
  ].forEach((item, index) => insert.run(...item, index));
  db.prepare("INSERT INTO settings (key,value) VALUES ('seeded','1')").run();
}
