import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

export const dataDir = path.resolve(process.env.DATA_DIR || './data');
mkdirSync(path.join(dataDir, 'documents'), { recursive: true });
mkdirSync(path.join(dataDir, 'promotions'), { recursive: true });
mkdirSync(path.join(dataDir, 'events'), { recursive: true });
const keyText = process.env.DATA_KEY || '';
if (!/^[a-f0-9]{64}$/i.test(keyText)) throw new Error('DATA_KEY missing or invalid. Run npm run setup.');
const key = Buffer.from(keyText, 'hex');
export const db = new DatabaseSync(path.join(dataDir, 'club.sqlite'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
db.exec(readFileSync(new URL('./migrations/001-initial.sql', import.meta.url), 'utf8'));
db.exec(readFileSync(new URL('./migrations/002-events.sql', import.meta.url), 'utf8'));
db.exec(readFileSync(new URL('./migrations/003-member-branch.sql', import.meta.url), 'utf8'));
db.exec(readFileSync(new URL('./migrations/004-solutions.sql', import.meta.url), 'utf8'));
function ensureColumn(table, column, definition) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some(item => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
ensureColumn('members', 'profile_views', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('members', 'import_key', 'TEXT');
ensureColumn('members', 'branch_preference', "TEXT NOT NULL DEFAULT 'san_salvador'");
ensureColumn('promotions', 'clicks', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('promotions', 'deleted_at', 'TEXT');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_members_import_key ON members(import_key) WHERE import_key IS NOT NULL;');
db.prepare("UPDATE members SET branch_preference='san_salvador' WHERE branch_preference IS NULL OR branch_preference NOT IN ('san_salvador','san_miguel','ambas')").run();
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

if (!db.prepare("SELECT value FROM settings WHERE key='solutions_seeded_v1'").get()) {
  if (!db.prepare('SELECT id FROM solutions LIMIT 1').get()) {
    const insert = db.prepare('INSERT INTO solutions (kind,title,description,icon,position,active) VALUES (?,?,?,?,?,1)');
    [
      ['product','Transformadores','Equipos de distribución y potencia para proyectos residenciales, comerciales e industriales.','zap',0],
      ['product','Tableros eléctricos','Soluciones de distribución, protección, control y modernización de instalaciones.','shield',1],
      ['product','Iluminación','Opciones para iluminación residencial, comercial, industrial y alumbrado público.','lightbulb',2],
      ['product','Conductores eléctricos','Cables y conductores para energía, control y aplicaciones especiales.','cable',3],
      ['product','Canalización','Sistemas para conducir, ordenar y proteger el cableado de cada instalación.','cable',4],
      ['product','Placas y tomas','Dispositivos y accesorios para conexión, control y terminación eléctrica.','package',5],
      ['product','Datos y telefonía','Conectividad, cableado estructurado y soluciones para redes de comunicación.','cable',6],
      ['product','Postes','Soluciones para infraestructura eléctrica, distribución y alumbrado.','package',7],
      ['product','Herrajes y aisladores','Componentes para montaje, soporte y aislamiento de redes eléctricas.','wrench',8],
      ['product','Pararrayos y redes de tierra','Protección contra descargas atmosféricas y sistemas de puesta a tierra.','shield',9],
      ['product','Cámaras termográficas','Diagnóstico térmico para mantenimiento y detección preventiva de fallas.','shield',10],
      ['service','Subestaciones eléctricas','Diseño, construcción, suministro y mantenimiento de subestaciones.','zap',20],
      ['service','Tableros y arrancadores','Mantenimiento, diagnóstico y modernización de tableros de distribución y control.','wrench',21],
      ['service','Mediciones y alquiler de equipos','Mediciones eléctricas especializadas y equipos para diagnóstico técnico.','wrench',22],
      ['service','Calidad y eficiencia energética','Estudios, bancos de capacitores y filtros para reducir armónicos y mejorar el desempeño.','lightbulb',23],
      ['service','Protección atmosférica','Diseño, instalación y mantenimiento de pararrayos y redes de tierra.','shield',24],
      ['service','Automatización y SCADA','Control de procesos, automatización de líneas y supervisión de sistemas eléctricos.','zap',25],
      ['service','Cálculos eléctricos y lumínicos','Diseño y especificación para instalaciones y espacios interiores o exteriores.','lightbulb',26],
      ['service','Interconexión fotovoltaica','Asesoría técnica para integrar sistemas solares a la red eléctrica.','zap',27],
      ['service','Ensambles personalizados','Fabricación y configuración de soluciones eléctricas según cada proyecto.','wrench',28]
    ].forEach(item => insert.run(...item));
  }
  db.prepare("INSERT INTO settings (key,value) VALUES ('solutions_seeded_v1','1')").run();
}
