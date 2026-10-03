import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import multer from 'multer';
import sharp from 'sharp';
import QRCode from 'qrcode';
import { z } from 'zod';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { db, dataDir, encrypt, decrypt, duiHash, normalizeDui, passwordMatches, passwordHash, audit } from './db.mjs';

export const app = express();
const production = process.argv.includes('--production') || process.env.NODE_ENV === 'production';
export const appUrl = new URL(process.env.APP_URL || 'http://localhost:4173').origin;
const promotionsWhatsapp = '50370690808';
const secure = process.env.COOKIE_SECURE === 'true';
if (production && (!secure || !appUrl.startsWith('https://'))) throw new Error('Production requires HTTPS APP_URL and COOKIE_SECURE=true.');
if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: production ? { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:', 'blob:'], connectSrc: ["'self'"], upgradeInsecureRequests: [] } } : false, crossOriginEmbedderPolicy: false, strictTransportSecurity: secure ? undefined : false }));
app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use((req, res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin !== appUrl) return res.status(403).json({ error: 'Origen no permitido. Actualiza la página e inténtalo de nuevo.' });
  next();
});
app.use(express.json({ limit: '64kb' }));
const limited = (max, windowMs) => rateLimit({ windowMs, limit: max, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Demasiados intentos. Espera unos minutos antes de volver a intentar.' } });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 6 * 1024 * 1024, files: 1, fields: 12, fieldSize: 5000 } });
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const hashToken = token => createHash('sha256').update(token).digest('hex');
const cookieName = secure ? '__Host-pelsa_session' : 'pelsa_session';
const cookieOptions = { httpOnly: true, secure, sameSite: 'strict', path: '/' };
const dummyHash = await passwordHash(randomBytes(32).toString('hex'));

function auth(req, res, next) {
  const cookie = req.headers.cookie?.split(';').map(c => c.trim()).find(c => c.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  if (!cookie || !/^[a-f0-9]{64}$/.test(cookie)) return res.status(401).json({ error: 'Inicia sesión para continuar.' });
  const admin = db.prepare('SELECT a.id,a.email,a.name FROM sessions s JOIN admins a ON a.id=s.admin_id WHERE s.token=? AND s.expires>? AND a.active=1').get(hashToken(cookie), Date.now());
  if (!admin) return res.status(401).json({ error: 'Tu sesión terminó. Inicia sesión nuevamente.' });
  req.admin = admin; req.session = hashToken(cookie); next();
}
const memberNumber = n => n == null ? null : String(n).padStart(6, '0');
function adminMember(m) {
  const { dui_hash, dui_encrypted, front_file, back_file, ...safe } = m;
  return { ...safe, number: memberNumber(m.number), dui: decrypt(dui_encrypted).toString(), profileUrl: m.token ? `${appUrl}/m/${m.token}` : null };
}
function visibleContent() {
  const now = new Date().toISOString();
  return {
    benefits: db.prepare('SELECT * FROM benefits WHERE active=1 ORDER BY position,id').all(),
    promotions: db.prepare('SELECT id,title,description,image,starts_at,ends_at FROM promotions WHERE deleted_at IS NULL AND active=1 AND starts_at<=? AND ends_at>=? ORDER BY starts_at DESC,id DESC').all(now, now)
  };
}
async function cleanImage(file) {
  if (!file || !['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) throw new Error('UPLOAD:Adjunta imágenes JPG, PNG o WebP.');
  try {
    const input = sharp(file.buffer, { limitInputPixels: 25000000, animated: false });
    const meta = await input.metadata();
    if (!['jpeg', 'png', 'webp'].includes(meta.format)) throw new Error('format');
    return await input.rotate().resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
  } catch { throw new Error('UPLOAD:No se pudo leer la imagen. Usa una foto JPG, PNG o WebP válida de hasta 25 megapíxeles.'); }
}
const registrationSchema = z.object({
  name: z.string().trim().min(3).max(120), email: z.email().max(254).transform(v => v.toLowerCase()),
  whatsapp: z.string().transform(v => v.replace(/[\s()+-]/g, '')).refine(v => /^503[267]\d{7}$/.test(v), 'Ingresa +503 seguido de un número válido de 8 dígitos.'),
  dui: z.string().transform(normalizeDui).refine(v => /^\d{9}$/.test(v), 'El DUI debe tener 9 dígitos.'),
  referral: z.string().trim().max(12).optional().default(''),
  consent: z.literal('true'), website: z.string().max(0).optional().default('')
});
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/api/content', (_req, res) => res.json(visibleContent()));
app.post('/api/registrations', limited(10, 60 * 60 * 1000), upload.fields([{ name: 'front', maxCount: 1 }]), wrap(async (req, res) => {
  const fields = registrationSchema.parse(req.body);
  const h = duiHash(fields.dui);
  const duplicateMessage = 'Ya existe una solicitud o membresía con este DUI. Comunícate con mercadeo de PELSA para revisarla.';
  if (db.prepare('SELECT id FROM members WHERE dui_hash=?').get(h)) return res.status(409).json({ error: duplicateMessage });
  let referredBy = null;
  if (fields.referral) {
    if (!/^\d{1,9}$/.test(fields.referral)) return res.status(400).json({ error: 'Revisa el código de quien te recomendó.' });
    const referrer = db.prepare("SELECT id FROM members WHERE number=? AND status='approved'").get(Number(fields.referral));
    if (!referrer) return res.status(400).json({ error: 'No encontramos un miembro activo con ese código de recomendación.' });
    referredBy = referrer.id;
  }
  const front = await cleanImage(req.files?.front?.[0]);
  const frontFile = `${randomBytes(20).toString('hex')}.enc`;
  try {
    await writeFile(path.join(dataDir, 'documents', frontFile), encrypt(front), { mode: 0o600 });
    db.prepare('INSERT INTO members (name,email,whatsapp,dui_hash,dui_encrypted,front_file,back_file,referred_by,consent_at) VALUES (?,?,?,?,?,?,?,?,?)').run(fields.name, fields.email, fields.whatsapp, h, encrypt(Buffer.from(fields.dui)), frontFile, '', referredBy, new Date().toISOString());
    res.status(201).json({ message: 'Solicitud recibida. Mercadeo revisará tus datos y te notificará por WhatsApp.' });
  } catch (err) {
    await Promise.allSettled([unlink(path.join(dataDir, 'documents', frontFile))]);
    if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: duplicateMessage });
    throw err;
  }
}));
app.get('/api/members/:token', (req, res) => {
  const m = db.prepare("SELECT id,name,email,whatsapp,number,show_email,show_whatsapp,approved_at FROM members WHERE token=? AND status='approved'").get(req.params.token);
  if (!m) return res.status(404).json({ error: 'Este perfil no está disponible. Comunícate con mercadeo de PELSA.' });
  db.prepare('UPDATE members SET profile_views=profile_views+1 WHERE id=?').run(m.id);
  res.json({ name: m.name, number: memberNumber(m.number), email: m.show_email ? m.email : null, whatsapp: m.show_whatsapp ? m.whatsapp : null, approvedAt: m.approved_at, referralUrl: `${appUrl}/registro?ref=${memberNumber(m.number)}`, ...visibleContent() });
});
app.get('/api/promotions/:id/whatsapp', (req, res) => {
  const now = new Date().toISOString();
  const member = db.prepare("SELECT id FROM members WHERE token=? AND status='approved'").get(String(req.query.member || ''));
  const promotion = db.prepare('SELECT id,title FROM promotions WHERE id=? AND deleted_at IS NULL AND active=1 AND starts_at<=? AND ends_at>=?').get(req.params.id, now, now);
  if (!member || !promotion) return res.status(404).json({ error: 'Esta promoción ya no está disponible.' });
  db.prepare('UPDATE promotions SET clicks=clicks+1 WHERE id=?').run(promotion.id);
  const message = `Hola, me interesa la promoción "${promotion.title}" del Club de Electricistas PELSA.`;
  res.redirect(302, `https://wa.me/${promotionsWhatsapp}?text=${encodeURIComponent(message)}`);
});
app.get('/api/promotions/:file', wrap(async (req, res) => {
  if (!/^[a-f0-9]{40}\.jpg$/.test(req.params.file)) return res.sendStatus(404);
  const now = new Date().toISOString();
  const p = db.prepare('SELECT id FROM promotions WHERE image=? AND active=1 AND starts_at<=? AND ends_at>=?').get(req.params.file, now, now);
  if (!p) return res.sendStatus(404);
  res.type('jpg').send(await readFile(path.join(dataDir, 'promotions', req.params.file)));
}));
app.post('/api/login', limited(10, 15 * 60 * 1000), wrap(async (req, res) => {
  const { email, password } = z.object({ email: z.string().max(254), password: z.string().max(200) }).parse(req.body);
  const admin = db.prepare('SELECT * FROM admins WHERE email=? AND active=1').get(email.trim().toLowerCase());
  const match = await passwordMatches(password, admin?.password || dummyHash);
  if (!admin || !match) return res.status(401).json({ error: 'Correo o contraseña incorrectos.' });
  const token = randomBytes(32).toString('hex');
  db.prepare('DELETE FROM sessions WHERE expires<=?').run(Date.now());
  db.prepare('INSERT INTO sessions (token,admin_id,expires) VALUES (?,?,?)').run(hashToken(token), admin.id, Date.now() + 8 * 60 * 60 * 1000);
  audit(admin.email, 'session.login');
  res.cookie(cookieName, token, { ...cookieOptions, maxAge: 8 * 60 * 60 * 1000 }).json({ id: admin.id, name: admin.name, email: admin.email });
}));
app.use('/api/admin', auth);
app.get('/api/admin/me', (req, res) => res.json(req.admin));
app.post('/api/admin/logout', (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token=?').run(req.session);
  res.clearCookie(cookieName, cookieOptions).json({ ok: true });
});
app.get('/api/admin/members', (_req, res) => res.json(db.prepare('SELECT * FROM members ORDER BY created_at DESC,id DESC').all().map(adminMember)));
app.post('/api/admin/members/:id/review', (req, res) => {
  const fields = z.object({ status: z.enum(['approved', 'rejected', 'suspended', 'pending']), note: z.string().trim().max(500).default('') }).parse(req.body);
  const m = db.prepare('SELECT * FROM members WHERE id=?').get(req.params.id);
  if (!m) return res.sendStatus(404);
  if (fields.status === 'rejected' && !fields.note) return res.status(400).json({ error: 'Indica el motivo del rechazo.' });
  if (m.number && ['pending', 'rejected'].includes(fields.status)) return res.status(400).json({ error: 'Para un miembro aprobado utiliza suspender o reactivar.' });
  if (!m.number && fields.status === 'suspended') return res.status(400).json({ error: 'Solo puedes suspender miembros aprobados.' });
  db.exec('BEGIN IMMEDIATE');
  try {
    let number = m.number; let token = m.token;
    if (fields.status === 'approved' && !number) {
      number = db.prepare("UPDATE counters SET value=value+1 WHERE name='member' RETURNING value").get().value;
      token = randomBytes(24).toString('hex');
    }
    db.prepare('UPDATE members SET status=?,number=?,token=?,review_note=?,reviewed_by=?,approved_at=CASE WHEN ?=\'approved\' THEN COALESCE(approved_at,?) ELSE approved_at END WHERE id=?').run(fields.status, number, token, fields.note, req.admin.id, fields.status, new Date().toISOString(), m.id);
    audit(req.admin.email, `member.${fields.status}`, m.id);
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  res.json(adminMember(db.prepare('SELECT * FROM members WHERE id=?').get(m.id)));
});
app.patch('/api/admin/members/:id', (req, res) => {
  const fields = z.object({ name: z.string().trim().min(3).max(120), email: z.email().max(254), whatsapp: z.string().regex(/^503[267]\d{7}$/), show_email: z.boolean(), show_whatsapp: z.boolean() }).parse(req.body);
  const result = db.prepare('UPDATE members SET name=?,email=?,whatsapp=?,show_email=?,show_whatsapp=? WHERE id=?').run(fields.name, fields.email, fields.whatsapp, +fields.show_email, +fields.show_whatsapp, req.params.id);
  if (!result.changes) return res.sendStatus(404);
  audit(req.admin.email, 'member.updated', req.params.id); res.json({ ok: true });
});
app.get('/api/admin/members/:id/documents/:side', wrap(async (req, res) => {
  if (req.params.side !== 'front') return res.sendStatus(404);
  const m = db.prepare('SELECT front_file FROM members WHERE id=?').get(req.params.id);
  if (!m) return res.sendStatus(404);
  const file = m.front_file;
  const body = decrypt(await readFile(path.join(dataDir, 'documents', file)));
  audit(req.admin.email, req.query.download === '1' ? 'document.downloaded' : 'document.viewed', `${req.params.id}:${req.params.side}`);
  if (req.query.download === '1') res.attachment(`solicitud-${req.params.id}-${req.params.side}.jpg`);
  res.type('jpg').send(body);
}));
app.get('/api/admin/members/:id/qr', wrap(async (req, res) => {
  const m = db.prepare("SELECT number,token FROM members WHERE id=? AND status='approved'").get(req.params.id);
  if (!m) return res.sendStatus(404);
  const referral = req.query.type === 'referral';
  const url = referral ? `${appUrl}/registro?ref=${memberNumber(m.number)}` : `${appUrl}/m/${m.token}`;
  const png = await QRCode.toBuffer(url, { width: 1000, margin: 4, errorCorrectionLevel: 'M' });
  res.attachment(`${referral ? 'recomendacion' : 'perfil'}-${memberNumber(m.number)}.png`).type('png').send(png);
}));
app.get('/api/admin/content', (_req, res) => res.json({ benefits: db.prepare('SELECT * FROM benefits ORDER BY position,id').all(), promotions: db.prepare('SELECT * FROM promotions WHERE deleted_at IS NULL ORDER BY id DESC').all() }));
app.get('/api/admin/kpis', (_req, res) => res.json({
  summary: {
    profileViews: db.prepare('SELECT COALESCE(SUM(profile_views),0) value FROM members').get().value,
    promotionClicks: db.prepare('SELECT COALESCE(SUM(clicks),0) value FROM promotions').get().value
  },
  promotions: db.prepare('SELECT id,title,clicks,active,deleted_at FROM promotions ORDER BY clicks DESC,id DESC').all(),
  members: db.prepare("SELECT id,name,number,status,profile_views FROM members WHERE number IS NOT NULL ORDER BY profile_views DESC,name").all().map(member => ({ ...member, number: memberNumber(member.number) }))
}));
const benefitSchema = z.object({ title: z.string().trim().min(3).max(100), description: z.string().trim().min(3).max(500), icon: z.enum(['calendar', 'graduation', 'tag', 'headset', 'gift', 'users']), position: z.coerce.number().int().min(0).max(100), active: z.boolean() });
app.post('/api/admin/benefits', (req, res) => {
  const b = benefitSchema.parse(req.body);
  const result = db.prepare('INSERT INTO benefits (title,description,icon,position,active) VALUES (?,?,?,?,?)').run(b.title, b.description, b.icon, b.position, +b.active);
  audit(req.admin.email, 'benefit.created', result.lastInsertRowid); res.status(201).json({ id: Number(result.lastInsertRowid) });
});
app.put('/api/admin/benefits/:id', (req, res) => {
  const b = benefitSchema.parse(req.body);
  const result = db.prepare('UPDATE benefits SET title=?,description=?,icon=?,position=?,active=? WHERE id=?').run(b.title, b.description, b.icon, b.position, +b.active, req.params.id);
  if (!result.changes) return res.sendStatus(404);
  audit(req.admin.email, 'benefit.updated', req.params.id); res.json({ ok: true });
});
const promotionSchema = z.object({ title: z.string().trim().min(3).max(100), description: z.string().trim().min(3).max(1500), starts_at: z.iso.datetime(), ends_at: z.iso.datetime(), active: z.enum(['true', 'false']).transform(v => v === 'true') }).refine(v => v.ends_at > v.starts_at, 'La fecha final debe ser posterior a la inicial.');
async function savePromotion(req, res) {
  const p = promotionSchema.parse(req.body);
  const existing = req.params.id ? db.prepare('SELECT * FROM promotions WHERE id=? AND deleted_at IS NULL').get(req.params.id) : null;
  if (req.params.id && !existing) return res.sendStatus(404);
  let image = existing?.image || null; let createdImage;
  if (req.file) {
    const bytes = await cleanImage(req.file); createdImage = `${randomBytes(20).toString('hex')}.jpg`;
    await writeFile(path.join(dataDir, 'promotions', createdImage), bytes); image = createdImage;
  }
  try {
    let id = req.params.id;
    if (existing) db.prepare('UPDATE promotions SET title=?,description=?,image=?,starts_at=?,ends_at=?,active=? WHERE id=?').run(p.title, p.description, image, p.starts_at, p.ends_at, +p.active, id);
    else id = Number(db.prepare('INSERT INTO promotions (title,description,image,starts_at,ends_at,active) VALUES (?,?,?,?,?,?)').run(p.title, p.description, image, p.starts_at, p.ends_at, +p.active).lastInsertRowid);
    audit(req.admin.email, 'promotion.saved', id); res.json({ id });
  } catch (err) { if (createdImage) await unlink(path.join(dataDir, 'promotions', createdImage)).catch(() => {}); throw err; }
}
app.post('/api/admin/promotions', upload.single('image'), wrap(savePromotion));
app.put('/api/admin/promotions/:id', upload.single('image'), wrap(savePromotion));
app.delete('/api/admin/promotions/:id', wrap(async (req, res) => {
  const promotion = db.prepare('SELECT image FROM promotions WHERE id=? AND deleted_at IS NULL').get(req.params.id);
  if (!promotion) return res.sendStatus(404);
  const result = db.prepare("UPDATE promotions SET active=0,image=NULL,deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND deleted_at IS NULL").run(req.params.id);
  if (!result.changes) return res.sendStatus(404);
  if (promotion.image) await unlink(path.join(dataDir, 'promotions', promotion.image)).catch(() => {});
  audit(req.admin.email, 'promotion.deleted', req.params.id); res.json({ ok: true });
}));
app.get('/api/admin/promotions/:id/image', wrap(async (req, res) => {
  const p = db.prepare('SELECT image FROM promotions WHERE id=? AND deleted_at IS NULL').get(req.params.id);
  if (!p?.image) return res.sendStatus(404);
  res.type('jpg').send(await readFile(path.join(dataDir, 'promotions', p.image)));
}));
app.get('/api/admin/audit', (_req, res) => res.json(db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 150').all()));
app.use('/api', (_req, res) => res.status(404).json({ error: 'No encontramos esa información.' }));
app.use((err, _req, res, _next) => {
  if (err instanceof z.ZodError) return res.status(400).json({ error: 'Revisa los datos del formulario.', details: err.issues.map(i => `${i.path.join('.')}: ${i.message}`) });
  if (err instanceof multer.MulterError) return res.status(400).json({ error: 'Revisa la fotografía. El máximo es 6 MB y solo debes adjuntar el frente del DUI.' });
  if (err.message?.startsWith('UPLOAD:')) return res.status(400).json({ error: err.message.slice(7) });
  // Do not log request bodies, filenames, DUI numbers or document contents.
  console.error('Request failed:', err.code || err.name);
  res.status(500).json({ error: 'No pudimos completar la operación. Inténtalo nuevamente.' });
});
