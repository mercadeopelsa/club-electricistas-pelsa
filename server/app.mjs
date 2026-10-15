import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import multer from 'multer';
import sharp from 'sharp';
import QRCode from 'qrcode';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { db, dataDir, encrypt, decrypt, duiHash, normalizeDui, passwordMatches, passwordHash, audit, claimMemberNumber, releaseMemberNumber } from './db.mjs';
import { campaignRouter } from './campaigns.mjs';

export const app = express();
const production = process.argv.includes('--production') || process.env.NODE_ENV === 'production';
export const appUrl = new URL(process.env.APP_URL || 'http://localhost:4173').origin;
const promotionsWhatsapp = '50370690808';
const secure = process.env.COOKIE_SECURE === 'true';
if (production && (!secure || !appUrl.startsWith('https://'))) throw new Error('Production requires HTTPS APP_URL and COOKIE_SECURE=true.');
if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: production ? { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:', 'blob:'], connectSrc: ["'self'"], frameSrc: ["'self'", 'https://www.youtube-nocookie.com', 'https://www.instagram.com', 'https://www.facebook.com', 'https://www.tiktok.com'], upgradeInsecureRequests: [] } } : false, crossOriginEmbedderPolicy: false, strictTransportSecurity: secure ? undefined : false }));
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
  return { ...safe, number: memberNumber(m.number), dui: decrypt(dui_encrypted).toString(), hasFrontDocument: Boolean(front_file), profileUrl: m.token ? `${appUrl}/m/${m.token}` : null };
}
function findMemberByIdentity(value) {
  const query = String(value || '').trim();
  if (!query) return null;
  const members = db.prepare('SELECT id,name,email,number,token,status,dui_hash,dui_encrypted,created_at FROM members ORDER BY created_at,id').all();
  const normalizedDui = normalizeDui(query);
  if (/^\d{9}$/.test(normalizedDui)) {
    const hash = duiHash(normalizedDui);
    const byDui = members.find(member => member.dui_hash === hash || normalizeDui(decrypt(member.dui_encrypted).toString()) === normalizedDui);
    if (byDui) return byDui;
  }
  if (query.includes('@')) {
    const email = query.toLowerCase();
    const byEmail = members.find(member => member.email.toLowerCase() === email);
    if (byEmail) return byEmail;
  }
  if (/^\d{1,9}$/.test(query)) return members.find(member => member.number === Number(query)) || null;
  return null;
}
function publicMemberMatch(member) {
  if (!member) return { found:false };
  const active = member.status === 'approved' && member.token;
  return { found:true, name:member.name, number:memberNumber(member.number), status:member.status, profileUrl:active ? `${appUrl}/m/${member.token}` : null };
}
function visibleContent() {
  const now = new Date().toISOString();
  return {
    benefits: db.prepare('SELECT * FROM benefits WHERE active=1 ORDER BY position,id').all(),
    solutions: db.prepare('SELECT id,kind,title,description,icon,position FROM solutions WHERE active=1 ORDER BY position,id').all(),
    promotions: db.prepare('SELECT id,title,description,image,starts_at,ends_at FROM promotions WHERE deleted_at IS NULL AND active=1 AND starts_at<=? AND ends_at>=? ORDER BY starts_at DESC,id DESC').all(now, now),
    events: db.prepare("SELECT id,title,description,location,starts_at,ends_at,registration_url,image,video_embed,video_provider FROM events WHERE deleted_at IS NULL AND active=1 ORDER BY COALESCE(NULLIF(starts_at,''),created_at),id").all(),
    rewards: db.prepare('SELECT id,title,description,purchase_amount,starts_at,ends_at,image FROM rewards WHERE deleted_at IS NULL AND active=1 AND ends_at>=? ORDER BY starts_at,id LIMIT 8').all(now)
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
async function cleanCredential(file) {
  if (!file) throw new Error('UPLOAD:Adjunta una fotografía o PDF del carnet SIGET.');
  if (file.mimetype === 'application/pdf') {
    if (file.buffer.subarray(0, 5).toString() !== '%PDF-') throw new Error('UPLOAD:El archivo no es un PDF válido.');
    return { bytes:file.buffer, type:'application/pdf' };
  }
  return { bytes:await cleanImage(file), type:'image/jpeg' };
}
const registrationSchema = z.object({
  name: z.string().trim().min(3).max(120), email: z.email().max(254).transform(v => v.toLowerCase()),
  whatsapp: z.string().transform(v => v.replace(/[\s()+-]/g, '')).refine(v => /^503[267]\d{7}$/.test(v), 'Ingresa +503 seguido de un número válido de 8 dígitos.'),
  dui: z.string().transform(normalizeDui).refine(v => /^\d{9}$/.test(v), 'El DUI debe tener 9 dígitos.'),
  branch_preference: z.enum(['san_salvador', 'san_miguel', 'ambas']),
  referral: z.string().trim().max(12).optional().default(''),
  consent: z.literal('true'), marketing_opt_in: z.literal('true').optional(), website: z.string().max(0).optional().default('')
});
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/api/content', (_req, res) => res.json(visibleContent()));
app.post('/api/members/lookup', limited(20, 60 * 60 * 1000), (req, res) => {
  const { query } = z.object({ query:z.string().trim().min(3).max(254) }).parse(req.body);
  res.json(publicMemberMatch(findMemberByIdentity(query)));
});
app.post('/api/registrations', limited(10, 60 * 60 * 1000), upload.fields([{ name: 'front', maxCount: 1 }]), wrap(async (req, res) => {
  const fields = registrationSchema.parse(req.body);
  const h = duiHash(fields.dui);
  const duplicateMessage = 'Este DUI ya está registrado en el Club de Electricistas PELSA.';
  const existing = findMemberByIdentity(fields.dui);
  if (existing) return res.status(409).json({ error: duplicateMessage, existing:publicMemberMatch(existing) });
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
    const now = new Date().toISOString();
    db.prepare('INSERT INTO members (name,email,whatsapp,dui_hash,dui_encrypted,front_file,back_file,branch_preference,referred_by,consent_at,marketing_opt_in,marketing_opt_in_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(fields.name, fields.email, fields.whatsapp, h, encrypt(Buffer.from(fields.dui)), frontFile, '', fields.branch_preference, referredBy, now, fields.marketing_opt_in ? 1 : 0, fields.marketing_opt_in ? now : null);
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
  const siget = db.prepare('SELECT status,review_note,submitted_at,keychain_delivered FROM siget_submissions WHERE member_id=?').get(m.id) || null;
  res.json({ name: m.name, number: memberNumber(m.number), email: m.show_email ? m.email : null, whatsapp: m.show_whatsapp ? m.whatsapp : null, approvedAt: m.approved_at, referralUrl: `${appUrl}/registro?ref=${memberNumber(m.number)}`, siget, ...visibleContent() });
});
app.post('/api/members/:token/siget', limited(5, 60 * 60 * 1000), upload.single('credential'), wrap(async (req, res) => {
  const member = db.prepare("SELECT id FROM members WHERE token=? AND status='approved'").get(req.params.token);
  if (!member) return res.status(404).json({ error:'Este perfil no está disponible.' });
  const credential = await cleanCredential(req.file);
  const previous = db.prepare('SELECT file_name FROM siget_submissions WHERE member_id=?').get(member.id);
  const fileName = `${randomBytes(20).toString('hex')}.enc`;
  await writeFile(path.join(dataDir, 'siget', fileName), encrypt(credential.bytes), { mode:0o600 });
  try {
    db.prepare(`INSERT INTO siget_submissions (member_id,file_name,file_type)
      VALUES (?,?,?)
      ON CONFLICT(member_id) DO UPDATE SET file_name=excluded.file_name,file_type=excluded.file_type,status='pending',review_note='',submitted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),reviewed_at=NULL,reviewed_by=NULL,keychain_delivered=0,keychain_delivered_at=NULL`).run(member.id, fileName, credential.type);
    if (previous?.file_name) await unlink(path.join(dataDir, 'siget', previous.file_name)).catch(() => {});
    audit(`member:${member.id}`, 'siget.submitted', member.id);
    res.status(201).json({ status:'pending', message:'Recibimos tu carnet SIGET. Mercadeo lo revisará y te notificará.' });
  } catch (error) {
    await unlink(path.join(dataDir, 'siget', fileName)).catch(() => {});
    throw error;
  }
}));
function activePromotionForMember(req) {
  const now = new Date().toISOString();
  const member = db.prepare("SELECT id,name FROM members WHERE token=? AND status='approved'").get(String(req.query.member || ''));
  const promotion = db.prepare('SELECT id,title,image FROM promotions WHERE id=? AND deleted_at IS NULL AND active=1 AND starts_at<=? AND ends_at>=?').get(req.params.id, now, now);
  return member && promotion ? { member, promotion } : null;
}
app.post('/api/promotions/:id/click', (req, res) => {
  const match = activePromotionForMember(req);
  if (!match) return res.status(404).json({ error: 'Esta promoción ya no está disponible.' });
  const { promotion } = match;
  db.prepare('UPDATE promotions SET clicks=clicks+1 WHERE id=?').run(promotion.id);
  res.sendStatus(204);
});
app.get('/api/promotions/:id/whatsapp', (req, res) => {
  const match = activePromotionForMember(req);
  if (!match) return res.status(404).json({ error: 'Esta promoción ya no está disponible.' });
  const { member, promotion } = match;
  db.prepare('UPDATE promotions SET clicks=clicks+1 WHERE id=?').run(promotion.id);
  const imageUrl = promotion.image ? `${appUrl}/api/promotions/${promotion.image}` : '';
  const message = `Estoy interesado en este producto: ${promotion.title}${imageUrl ? `\n${imageUrl}` : ''}\nSoy ${member.name}, miembro del Club de Electricistas.`;
  const whatsappUrl = `https://wa.me/${promotionsWhatsapp}?text=${encodeURIComponent(message)}`;
  const safeUrl = whatsappUrl.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
  res.type('html').send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="refresh" content="0;url=${safeUrl}"><title>Abriendo WhatsApp</title></head><body><p><a href="${safeUrl}">Abrir WhatsApp</a></p></body></html>`);
});
app.get('/api/promotions/:file', wrap(async (req, res) => {
  if (!/^[a-f0-9]{40}\.jpg$/.test(req.params.file)) return res.sendStatus(404);
  const now = new Date().toISOString();
  const p = db.prepare('SELECT id FROM promotions WHERE image=? AND active=1 AND starts_at<=? AND ends_at>=?').get(req.params.file, now, now);
  if (!p) return res.sendStatus(404);
  res.type('jpg').send(await readFile(path.join(dataDir, 'promotions', req.params.file)));
}));
app.get('/api/events/media/:file', wrap(async (req, res) => {
  if (!/^[a-f0-9]{40}\.jpg$/.test(req.params.file)) return res.sendStatus(404);
  const event = db.prepare('SELECT id FROM events WHERE image=? AND deleted_at IS NULL AND active=1').get(req.params.file);
  if (!event) return res.sendStatus(404);
  res.type('jpg').send(await readFile(path.join(dataDir, 'events', req.params.file)));
}));
app.get('/api/rewards/media/:file', wrap(async (req, res) => {
  if (!/^[a-f0-9]{40}\.jpg$/.test(req.params.file)) return res.sendStatus(404);
  const reward = db.prepare('SELECT id FROM rewards WHERE image=? AND deleted_at IS NULL AND active=1').get(req.params.file);
  if (!reward) return res.sendStatus(404);
  res.type('jpg').send(await readFile(path.join(dataDir, 'rewards', req.params.file)));
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
app.use('/api/admin/campaigns', campaignRouter);
app.get('/api/admin/me', (req, res) => res.json(req.admin));
app.post('/api/admin/logout', (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token=?').run(req.session);
  res.clearCookie(cookieName, cookieOptions).json({ ok: true });
});
app.get('/api/admin/members', (_req, res) => {
  const members = db.prepare('SELECT m.*,s.status siget_status,s.submitted_at siget_submitted_at,s.keychain_delivered,s.file_type siget_file_type,s.review_note siget_review_note FROM members m LEFT JOIN siget_submissions s ON s.member_id=m.id ORDER BY m.created_at DESC,m.id DESC').all().map(adminMember);
  const duiCounts = members.reduce((counts, member) => {
    const dui = normalizeDui(member.dui);
    if (dui) counts.set(dui, (counts.get(dui) || 0) + 1);
    return counts;
  }, new Map());
  res.json(members.map(member => ({ ...member, duplicateCount:duiCounts.get(normalizeDui(member.dui)) || 0 })));
});
app.post('/api/admin/members/deduplicate', wrap(async (req, res) => {
  const members = db.prepare('SELECT m.id,m.name,m.number,m.created_at,m.front_file,m.dui_hash,m.dui_encrypted,s.file_name siget_file FROM members m LEFT JOIN siget_submissions s ON s.member_id=m.id ORDER BY m.created_at,m.id').all();
  const groups = new Map();
  for (const member of members) {
    const dui = normalizeDui(decrypt(member.dui_encrypted).toString());
    if (!/^\d{9}$/.test(dui)) continue;
    if (!groups.has(dui)) groups.set(dui, []);
    groups.get(dui).push(member);
  }
  const duplicates = [...groups.entries()].filter(([,items]) => items.length > 1);
  const files = []; let removed = 0; let freedNumbers = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [dui, items] of duplicates) {
      const [survivor, ...discarded] = items;
      for (const member of discarded) {
        db.prepare('UPDATE members SET referred_by=? WHERE referred_by=? AND id<>?').run(survivor.id, member.id, survivor.id);
        db.prepare('UPDATE members SET referred_by=NULL WHERE id=? AND referred_by=?').run(survivor.id, member.id);
        db.prepare('DELETE FROM members WHERE id=?').run(member.id);
        if (member.number != null) { releaseMemberNumber(member.number); freedNumbers += 1; }
        if (member.front_file) files.push(path.join(dataDir, 'documents', member.front_file));
        if (member.siget_file) files.push(path.join(dataDir, 'siget', member.siget_file));
        removed += 1;
      }
      db.prepare('UPDATE members SET dui_hash=? WHERE id=?').run(duiHash(dui), survivor.id);
    }
    audit(req.admin.email, 'members.deduplicated', `${removed} perfiles; ${freedNumbers} números liberados`);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  await Promise.all(files.map(file => unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; })));
  res.json({ groups:duplicates.length, removed, freedNumbers });
}));
const exportFields = {
  number:['N.º de miembro', member => memberNumber(member.number) || ''],
  name:['Nombre', member => member.name],
  email:['Correo', member => member.email],
  whatsapp:['WhatsApp', member => member.whatsapp],
  dui:['DUI', member => decrypt(member.dui_encrypted).toString()],
  branch:['Sucursal', member => ({san_salvador:'San Salvador',san_miguel:'San Miguel',ambas:'Ambas'})[member.branch_preference] || ''],
  status:['Estado', member => ({pending:'Pendiente',approved:'Activo',rejected:'Rechazado',suspended:'Suspendido'})[member.status] || member.status],
  registered_at:['Fecha de registro', member => member.created_at],
  approved_at:['Fecha de aprobación', member => member.approved_at || ''],
  marketing_opt_in:['Autoriza comunicaciones', member => member.marketing_opt_in ? 'Sí' : 'No'],
  profile_views:['Visitas al perfil', member => member.profile_views],
  siget_status:['Carnet SIGET', member => ({pending:'Pendiente',approved:'Aprobado',rejected:'Rechazado'})[member.siget_status] || 'No enviado'],
};
app.post('/api/admin/members/export', wrap(async (req, res) => {
  const options = z.object({
    fields:z.array(z.enum(Object.keys(exportFields))).min(1).max(Object.keys(exportFields).length),
    status:z.enum(['all','pending','approved','rejected','suspended','siget']).default('all'),
    branch:z.enum(['all','san_salvador','san_miguel','ambas']).default('all')
  }).parse(req.body);
  const members = db.prepare('SELECT m.*,s.status siget_status FROM members m LEFT JOIN siget_submissions s ON s.member_id=m.id ORDER BY m.number,m.name').all()
    .filter(member => (options.status==='all'||options.status==='siget'&&member.siget_status==='pending'||member.status===options.status) && (options.branch==='all'||member.branch_preference===options.branch));
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Club de Electricistas PELSA';
  workbook.created = new Date();
  const sheet = workbook.addWorksheet('Miembros');
  sheet.columns = options.fields.map(field => ({ header:exportFields[field][0], key:field, width:field==='name'?34:field.includes('at')?22:20 }));
  for (const member of members) sheet.addRow(Object.fromEntries(options.fields.map(field => [field,exportFields[field][1](member)])));
  sheet.getRow(1).font = { bold:true, color:{argb:'FF1D210F'} };
  sheet.getRow(1).fill = { type:'pattern', pattern:'solid', fgColor:{argb:'FFF6D20B'} };
  sheet.views = [{ state:'frozen', ySplit:1 }];
  sheet.autoFilter = { from:{row:1,column:1}, to:{row:Math.max(1,sheet.rowCount),column:options.fields.length} };
  const buffer = await workbook.xlsx.writeBuffer();
  audit(req.admin.email, 'members.exported', `${members.length} registros`);
  res.set('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.attachment(`miembros-club-pelsa-${new Date().toISOString().slice(0,10)}.xlsx`).send(Buffer.from(buffer));
}));
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
      number = claimMemberNumber();
      token = randomBytes(24).toString('hex');
    }
    db.prepare('UPDATE members SET status=?,number=?,token=?,review_note=?,reviewed_by=?,approved_at=CASE WHEN ?=\'approved\' THEN COALESCE(approved_at,?) ELSE approved_at END WHERE id=?').run(fields.status, number, token, fields.note, req.admin.id, fields.status, new Date().toISOString(), m.id);
    audit(req.admin.email, `member.${fields.status}`, m.id);
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  res.json(adminMember(db.prepare('SELECT * FROM members WHERE id=?').get(m.id)));
});
app.patch('/api/admin/members/:id', (req, res) => {
  const fields = z.object({ name: z.string().trim().min(3).max(120), email: z.union([z.literal(''), z.email().max(254)]), whatsapp: z.string().regex(/^503[267]\d{7}$/), branch_preference: z.enum(['san_salvador', 'san_miguel', 'ambas']), show_email: z.boolean(), show_whatsapp: z.boolean(), marketing_opt_in: z.boolean() }).parse(req.body);
  const result = db.prepare('UPDATE members SET name=?,email=?,whatsapp=?,branch_preference=?,show_email=?,show_whatsapp=?,marketing_opt_in=?,marketing_opt_in_at=CASE WHEN ?=1 THEN COALESCE(marketing_opt_in_at,?) ELSE NULL END WHERE id=?').run(fields.name, fields.email, fields.whatsapp, fields.branch_preference, +fields.show_email, +fields.show_whatsapp, +fields.marketing_opt_in, +fields.marketing_opt_in, new Date().toISOString(), req.params.id);
  if (!result.changes) return res.sendStatus(404);
  audit(req.admin.email, 'member.updated', req.params.id); res.json({ ok: true });
});
app.delete('/api/admin/members/:id', wrap(async (req, res) => {
  const member = db.prepare('SELECT m.id,m.name,m.number,m.front_file,m.dui_hash,m.dui_encrypted,s.file_name siget_file FROM members m LEFT JOIN siget_submissions s ON s.member_id=m.id WHERE m.id=?').get(req.params.id);
  if (!member) return res.sendStatus(404);
  const deletedDui = decrypt(member.dui_encrypted).toString();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE members SET referred_by=NULL WHERE referred_by=?').run(member.id);
    db.prepare('DELETE FROM members WHERE id=?').run(member.id);
    releaseMemberNumber(member.number);
    if (deletedDui && member.dui_hash === duiHash(deletedDui)) {
      const survivor = db.prepare('SELECT id,dui_encrypted FROM members').all().find(candidate => decrypt(candidate.dui_encrypted).toString() === deletedDui);
      if (survivor) db.prepare('UPDATE members SET dui_hash=? WHERE id=?').run(duiHash(deletedDui), survivor.id);
    }
    audit(req.admin.email, 'member.deleted', `${member.id}:${member.number || 'sin-numero'}`);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  if (member.front_file) await unlink(path.join(dataDir, 'documents', member.front_file)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (member.siget_file) await unlink(path.join(dataDir, 'siget', member.siget_file)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  res.json({ ok:true });
}));
app.get('/api/admin/members/:id/documents/:side', wrap(async (req, res) => {
  if (req.params.side !== 'front') return res.sendStatus(404);
  const m = db.prepare('SELECT front_file FROM members WHERE id=?').get(req.params.id);
  if (!m?.front_file) return res.sendStatus(404);
  const file = m.front_file;
  const body = decrypt(await readFile(path.join(dataDir, 'documents', file)));
  audit(req.admin.email, req.query.download === '1' ? 'document.downloaded' : 'document.viewed', `${req.params.id}:${req.params.side}`);
  if (req.query.download === '1') res.attachment(`solicitud-${req.params.id}-${req.params.side}.jpg`);
  res.type('jpg').send(body);
}));
app.get('/api/admin/members/:id/siget', wrap(async (req, res) => {
  const submission = db.prepare('SELECT file_name,file_type FROM siget_submissions WHERE member_id=?').get(req.params.id);
  if (!submission) return res.sendStatus(404);
  const body = decrypt(await readFile(path.join(dataDir, 'siget', submission.file_name)));
  audit(req.admin.email, req.query.download === '1' ? 'siget.downloaded' : 'siget.viewed', req.params.id);
  const extension = submission.file_type === 'application/pdf' ? 'pdf' : 'jpg';
  if (req.query.download === '1' || submission.file_type === 'application/pdf') res.attachment(`carnet-siget-miembro-${req.params.id}.${extension}`);
  res.type(submission.file_type).send(body);
}));
app.post('/api/admin/members/:id/siget/review', (req, res) => {
  const review = z.object({ status:z.enum(['approved','rejected']), note:z.string().trim().max(500).default('') }).parse(req.body);
  if (review.status==='rejected' && !review.note) return res.status(400).json({ error:'Indica el motivo del rechazo.' });
  const result = db.prepare("UPDATE siget_submissions SET status=?,review_note=?,reviewed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),reviewed_by=? WHERE member_id=?").run(review.status, review.note, req.admin.id, req.params.id);
  if (!result.changes) return res.sendStatus(404);
  audit(req.admin.email, `siget.${review.status}`, req.params.id);
  res.json({ ok:true });
});
app.patch('/api/admin/members/:id/siget/keychain', (req, res) => {
  const value = z.object({ delivered:z.boolean() }).parse(req.body);
  const result = db.prepare("UPDATE siget_submissions SET keychain_delivered=?,keychain_delivered_at=CASE WHEN ?=1 THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END WHERE member_id=? AND status='approved'").run(+value.delivered,+value.delivered,req.params.id);
  if (!result.changes) return res.status(404).json({ error:'Primero debes aprobar el carnet SIGET.' });
  audit(req.admin.email, 'siget.keychain', `${req.params.id}:${value.delivered?'entregado':'pendiente'}`);
  res.json({ ok:true });
});
app.get('/api/admin/members/:id/qr', wrap(async (req, res) => {
  const m = db.prepare("SELECT number,token FROM members WHERE id=? AND status='approved'").get(req.params.id);
  if (!m) return res.sendStatus(404);
  const referral = req.query.type === 'referral';
  const url = referral ? `${appUrl}/registro?ref=${memberNumber(m.number)}` : `${appUrl}/m/${m.token}`;
  const png = await QRCode.toBuffer(url, { width: 1000, margin: 4, errorCorrectionLevel: 'M' });
  res.attachment(`${referral ? 'recomendacion' : 'perfil'}-${memberNumber(m.number)}.png`).type('png').send(png);
}));
app.get('/api/admin/content', (_req, res) => res.json({ benefits: db.prepare('SELECT * FROM benefits ORDER BY position,id').all(), solutions: db.prepare('SELECT * FROM solutions ORDER BY position,id').all(), promotions: db.prepare('SELECT * FROM promotions WHERE deleted_at IS NULL ORDER BY id DESC').all(), events: db.prepare("SELECT * FROM events WHERE deleted_at IS NULL ORDER BY COALESCE(NULLIF(starts_at,''),created_at),id").all(), rewards:db.prepare('SELECT * FROM rewards WHERE deleted_at IS NULL ORDER BY starts_at,id').all() }));
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
const solutionSchema = z.object({ kind: z.enum(['service', 'product']), title: z.string().trim().min(3).max(100), description: z.string().trim().min(3).max(240), icon: z.enum(['package', 'wrench', 'zap', 'lightbulb', 'shield', 'cable']), position: z.coerce.number().int().min(0).max(100), active: z.boolean() });
app.post('/api/admin/solutions', (req, res) => {
  const item = solutionSchema.parse(req.body);
  const result = db.prepare('INSERT INTO solutions (kind,title,description,icon,position,active) VALUES (?,?,?,?,?,?)').run(item.kind, item.title, item.description, item.icon, item.position, +item.active);
  audit(req.admin.email, 'solution.created', result.lastInsertRowid); res.status(201).json({ id:Number(result.lastInsertRowid) });
});
app.put('/api/admin/solutions/:id', (req, res) => {
  const item = solutionSchema.parse(req.body);
  const result = db.prepare('UPDATE solutions SET kind=?,title=?,description=?,icon=?,position=?,active=? WHERE id=?').run(item.kind, item.title, item.description, item.icon, item.position, +item.active, req.params.id);
  if (!result.changes) return res.sendStatus(404);
  audit(req.admin.email, 'solution.updated', req.params.id); res.json({ ok:true });
});
app.delete('/api/admin/solutions/:id', (req, res) => {
  const result = db.prepare('DELETE FROM solutions WHERE id=?').run(req.params.id);
  if (!result.changes) return res.sendStatus(404);
  audit(req.admin.email, 'solution.deleted', req.params.id); res.json({ ok:true });
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
const rewardSchema = z.object({
  title:z.string().trim().min(2).max(120),
  description:z.string().trim().max(1000).default(''),
  purchase_amount:z.coerce.number().min(0).max(1000000),
  starts_at:z.iso.datetime(),
  ends_at:z.iso.datetime(),
  active:z.enum(['true','false']).transform(value => value==='true')
}).refine(value => value.ends_at>value.starts_at,'La fecha final debe ser posterior a la inicial.');
async function saveReward(req,res) {
  const reward=rewardSchema.parse(req.body);
  const existing=req.params.id?db.prepare('SELECT * FROM rewards WHERE id=? AND deleted_at IS NULL').get(req.params.id):null;
  if(req.params.id&&!existing)return res.sendStatus(404);
  let image=existing?.image||null;let createdImage;
  if(req.file){const bytes=await cleanImage(req.file);createdImage=`${randomBytes(20).toString('hex')}.jpg`;await writeFile(path.join(dataDir,'rewards',createdImage),bytes);image=createdImage;}
  if(!image)return res.status(400).json({error:'Agrega una imagen del promocional.'});
  try{
    let id=req.params.id;
    const values=[reward.title,reward.description,reward.purchase_amount,reward.starts_at,reward.ends_at,image,+reward.active];
    if(existing)db.prepare('UPDATE rewards SET title=?,description=?,purchase_amount=?,starts_at=?,ends_at=?,image=?,active=? WHERE id=?').run(...values,id);
    else id=Number(db.prepare('INSERT INTO rewards (title,description,purchase_amount,starts_at,ends_at,image,active) VALUES (?,?,?,?,?,?,?)').run(...values).lastInsertRowid);
    if(createdImage&&existing?.image)await unlink(path.join(dataDir,'rewards',existing.image)).catch(()=>{});
    audit(req.admin.email,'reward.saved',id);res.json({id});
  }catch(error){if(createdImage)await unlink(path.join(dataDir,'rewards',createdImage)).catch(()=>{});throw error;}
}
app.post('/api/admin/rewards',upload.single('image'),wrap(saveReward));
app.put('/api/admin/rewards/:id',upload.single('image'),wrap(saveReward));
app.delete('/api/admin/rewards/:id',wrap(async(req,res)=>{
  const reward=db.prepare('SELECT image FROM rewards WHERE id=? AND deleted_at IS NULL').get(req.params.id);
  if(!reward)return res.sendStatus(404);
  db.prepare("UPDATE rewards SET active=0,image=NULL,deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(req.params.id);
  if(reward.image)await unlink(path.join(dataDir,'rewards',reward.image)).catch(()=>{});
  audit(req.admin.email,'reward.deleted',req.params.id);res.json({ok:true});
}));
app.get('/api/admin/rewards/:id/image',wrap(async(req,res)=>{
  const reward=db.prepare('SELECT image FROM rewards WHERE id=? AND deleted_at IS NULL').get(req.params.id);
  if(!reward?.image)return res.sendStatus(404);
  res.type('jpg').send(await readFile(path.join(dataDir,'rewards',reward.image)));
}));
function normalizeVideoUrl(value) {
  if (!value) return { url: '', embed: '', provider: '' };
  let url;
  try { url = new URL(value); } catch { throw new Error('VIDEO:Ingresa un enlace de video válido.'); }
  if (url.protocol !== 'https:') throw new Error('VIDEO:El enlace del video debe comenzar con https://.');
  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  let match;
  if (host === 'youtu.be' || host === 'youtube.com' || host === 'm.youtube.com') {
    const id = host === 'youtu.be' ? url.pathname.split('/')[1] : url.searchParams.get('v') || url.pathname.match(/^\/(?:shorts|embed)\/([\w-]+)/)?.[1];
    if (!/^[\w-]{6,20}$/.test(id || '')) throw new Error('VIDEO:No pudimos reconocer ese video de YouTube.');
    return { url: value, embed: `https://www.youtube-nocookie.com/embed/${id}`, provider: 'youtube' };
  }
  if ((host === 'instagram.com' || host === 'm.instagram.com') && (match = url.pathname.match(/^\/(p|reel|tv)\/([\w-]+)/))) return { url: value, embed: `https://www.instagram.com/${match[1]}/${match[2]}/embed/`, provider: 'instagram' };
  if ((host === 'tiktok.com' || host === 'm.tiktok.com') && (match = url.pathname.match(/\/video\/(\d+)/))) return { url: value, embed: `https://www.tiktok.com/player/v1/${match[1]}`, provider: 'tiktok' };
  if (host === 'facebook.com' || host === 'm.facebook.com' || host === 'fb.watch') return { url: value, embed: `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(value)}&show_text=false`, provider: 'facebook' };
  throw new Error('VIDEO:Usa un enlace público de YouTube, Instagram, Facebook o TikTok.');
}
const eventSchema = z.object({
  title: z.string().trim().max(120).default(''), description: z.string().trim().max(2000).default(''), location: z.string().trim().max(160).default(''),
  starts_at: z.union([z.literal(''),z.iso.datetime()]).default(''), ends_at: z.union([z.literal(''),z.iso.datetime()]).default(''), registration_url: z.string().trim().max(1000).refine(v => !v || /^https:\/\//i.test(v), 'El enlace de inscripción debe comenzar con https://.'),
  video_url: z.string().trim().max(1000).default(''), active: z.enum(['true', 'false']).transform(v => v === 'true')
}).refine(v => !v.starts_at || !v.ends_at || v.ends_at > v.starts_at, 'La fecha final debe ser posterior a la inicial.');
async function saveEvent(req, res) {
  const event = eventSchema.parse(req.body);
  const video = normalizeVideoUrl(event.video_url);
  const existing = req.params.id ? db.prepare('SELECT * FROM events WHERE id=? AND deleted_at IS NULL').get(req.params.id) : null;
  if (req.params.id && !existing) return res.sendStatus(404);
  let image = existing?.image || null; let createdImage;
  if (req.file) {
    const bytes = await cleanImage(req.file); createdImage = `${randomBytes(20).toString('hex')}.jpg`;
    await writeFile(path.join(dataDir, 'events', createdImage), bytes); image = createdImage;
  }
  if (!event.title && !event.description && !event.location && !image && !video.url) return res.status(400).json({ error:'Agrega al menos una imagen, un video o algún texto para el evento.' });
  try {
    let id = req.params.id;
    const values = [event.title, event.description, event.location, event.starts_at, event.ends_at, event.registration_url, image, video.url, video.embed, video.provider, +event.active];
    if (existing) db.prepare('UPDATE events SET title=?,description=?,location=?,starts_at=?,ends_at=?,registration_url=?,image=?,video_url=?,video_embed=?,video_provider=?,active=? WHERE id=?').run(...values, id);
    else id = Number(db.prepare('INSERT INTO events (title,description,location,starts_at,ends_at,registration_url,image,video_url,video_embed,video_provider,active) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(...values).lastInsertRowid);
    if (createdImage && existing?.image) await unlink(path.join(dataDir, 'events', existing.image)).catch(() => {});
    audit(req.admin.email, 'event.saved', id); res.json({ id });
  } catch (err) { if (createdImage) await unlink(path.join(dataDir, 'events', createdImage)).catch(() => {}); throw err; }
}
app.post('/api/admin/events', upload.single('image'), wrap(saveEvent));
app.put('/api/admin/events/:id', upload.single('image'), wrap(saveEvent));
app.delete('/api/admin/events/:id', wrap(async (req, res) => {
  const event = db.prepare('SELECT image FROM events WHERE id=? AND deleted_at IS NULL').get(req.params.id);
  if (!event) return res.sendStatus(404);
  db.prepare("UPDATE events SET active=0,image=NULL,deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(req.params.id);
  if (event.image) await unlink(path.join(dataDir, 'events', event.image)).catch(() => {});
  audit(req.admin.email, 'event.deleted', req.params.id); res.json({ ok: true });
}));
app.get('/api/admin/events/:id/image', wrap(async (req, res) => {
  const event = db.prepare('SELECT image FROM events WHERE id=? AND deleted_at IS NULL').get(req.params.id);
  if (!event?.image) return res.sendStatus(404);
  res.type('jpg').send(await readFile(path.join(dataDir, 'events', event.image)));
}));
app.get('/api/admin/audit', (_req, res) => res.json(db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 150').all()));
app.use('/api', (_req, res) => res.status(404).json({ error: 'No encontramos esa información.' }));
app.use((err, _req, res, _next) => {
  if (err instanceof z.ZodError) return res.status(400).json({ error: 'Revisa los datos del formulario.', details: err.issues.map(i => `${i.path.join('.')}: ${i.message}`) });
  if (err instanceof multer.MulterError) return res.status(400).json({ error: 'Revisa el archivo. Solo puedes adjuntar una imagen de hasta 6 MB.' });
  if (err.message?.startsWith('UPLOAD:')) return res.status(400).json({ error: err.message.slice(7) });
  if (err.message?.startsWith('VIDEO:')) return res.status(400).json({ error: err.message.slice(6) });
  // Do not log request bodies, filenames, DUI numbers or document contents.
  console.error('Request failed:', err.code || err.name);
  res.status(500).json({ error: 'No pudimos completar la operación. Inténtalo nuevamente.' });
});
