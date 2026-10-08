import { Router } from 'express';
import { z } from 'zod';
import { db, audit } from './db.mjs';

export const campaignRouter = Router();

const mode = ['disabled', 'test', 'twilio'].includes(process.env.MESSAGING_MODE)
  ? process.env.MESSAGING_MODE
  : 'disabled';
const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim() || '';
const authToken = process.env.TWILIO_AUTH_TOKEN?.trim() || '';
const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID?.trim() || '';
const smsFrom = process.env.TWILIO_SMS_FROM?.trim() || '';
const whatsappFrom = process.env.TWILIO_WHATSAPP_FROM?.trim() || '';
const hasCredentials = Boolean(accountSid && authToken);
const smsReady = mode === 'test' || (mode === 'twilio' && hasCredentials && Boolean(messagingServiceSid || smsFrom));
const whatsappReady = mode === 'test' || (mode === 'twilio' && hasCredentials && Boolean(whatsappFrom));
const contentSidPattern = /^HX[a-fA-F0-9]{32}$/;
const branchWhere = `status='approved' AND marketing_opt_in=1 AND whatsapp GLOB '503[267][0-9][0-9][0-9][0-9][0-9][0-9][0-9]' AND (?='all' OR (?='san_salvador' AND branch_preference IN ('san_salvador','ambas')) OR (?='san_miguel' AND branch_preference IN ('san_miguel','ambas')))`;
const audienceCount = branch => db.prepare(`SELECT COUNT(*) count FROM members WHERE ${branchWhere}`).get(branch, branch, branch).count;
const audienceMembers = branch => db.prepare(`SELECT id, whatsapp FROM members WHERE ${branchWhere} ORDER BY number, id`).all(branch, branch, branch);
const schema = z.object({
  name: z.string().trim().min(3).max(120),
  channel: z.enum(['sms', 'whatsapp']),
  body: z.string().trim().min(3).max(1500),
  template_sid: z.string().trim().max(80).default(''),
  audience_branch: z.enum(['all', 'san_salvador', 'san_miguel']),
  scheduled_at: z.union([z.iso.datetime(), z.null()]).default(null),
});
const list = () => db.prepare('SELECT * FROM campaigns ORDER BY created_at DESC,id DESC').all();
const publicConfig = () => ({ mode, smsReady, whatsappReady });

function normalizeSender(value, channel) {
  const clean = value.replace(/^whatsapp:/i, '').replace(/[^+\d]/g, '');
  return channel === 'whatsapp'
    ? `whatsapp:${clean.startsWith('+') ? clean : `+${clean}`}`
    : (clean.startsWith('+') ? clean : `+${clean}`);
}

async function sendThroughTwilio(campaign, recipient) {
  if (mode === 'test') return { sid: `TEST-${campaign.id}-${recipient.id}` };
  const values = new URLSearchParams();
  if (campaign.channel === 'whatsapp') {
    values.set('To', `whatsapp:+${recipient.phone}`);
    values.set('From', normalizeSender(whatsappFrom, 'whatsapp'));
    values.set('ContentSid', campaign.template_sid);
    values.set('ContentVariables', JSON.stringify({ 1: campaign.body }));
  } else {
    values.set('To', `+${recipient.phone}`);
    values.set('Body', campaign.body);
    if (messagingServiceSid) values.set('MessagingServiceSid', messagingServiceSid);
    else values.set('From', normalizeSender(smsFrom, 'sms'));
  }
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    },
    body: values,
    signal: AbortSignal.timeout(20_000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.message || `Twilio respondió con estado ${response.status}.`);
  return { sid: result.sid || '' };
}

let processing = false;
export async function processCampaignQueue() {
  if (processing || mode === 'disabled') return;
  processing = true;
  try {
    const due = db.prepare("SELECT * FROM campaigns WHERE status='scheduled' AND datetime(scheduled_at)<=datetime('now') ORDER BY scheduled_at,id LIMIT 10").all();
    for (const campaign of due) {
      db.prepare("UPDATE campaigns SET status='running',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='scheduled'").run(campaign.id);
      const recipients = db.prepare("SELECT * FROM campaign_recipients WHERE campaign_id=? AND status='pending' ORDER BY id").all(campaign.id);
      for (const recipient of recipients) {
        try {
          const sent = await sendThroughTwilio(campaign, recipient);
          db.prepare("UPDATE campaign_recipients SET status='sent',provider_id=?,error='',sent_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(sent.sid, recipient.id);
        } catch (error) {
          db.prepare("UPDATE campaign_recipients SET status='failed',error=? WHERE id=?").run(String(error.message || error).slice(0, 500), recipient.id);
        }
      }
      const totals = db.prepare("SELECT COUNT(*) recipient_count,SUM(status='sent') sent_count,SUM(status='failed') failed_count FROM campaign_recipients WHERE campaign_id=?").get(campaign.id);
      db.prepare("UPDATE campaigns SET status='completed',recipient_count=?,sent_count=?,failed_count=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(totals.recipient_count || 0, totals.sent_count || 0, totals.failed_count || 0, campaign.id);
      audit('system', 'campaign.completed', campaign.id);
    }
  } finally {
    processing = false;
  }
}

let worker;
export function startCampaignWorker() {
  if (worker || mode === 'disabled') return;
  processCampaignQueue().catch(error => console.error('No se pudo procesar la cola de campañas:', error.message));
  worker = setInterval(() => processCampaignQueue().catch(error => console.error('No se pudo procesar la cola de campañas:', error.message)), 15_000);
  worker.unref?.();
}

campaignRouter.get('/', (_req, res) => res.json({
  campaigns: list(),
  config: publicConfig(),
  audiences: {
    all: audienceCount('all'),
    san_salvador: audienceCount('san_salvador'),
    san_miguel: audienceCount('san_miguel'),
  },
}));

campaignRouter.post('/', (req, res) => {
  const item = schema.parse(req.body);
  const result = db.prepare('INSERT INTO campaigns (name,channel,body,template_sid,audience_branch,scheduled_at,created_by) VALUES (?,?,?,?,?,?,?)').run(item.name, item.channel, item.body, item.template_sid, item.audience_branch, item.scheduled_at, req.admin.id);
  audit(req.admin.email, 'campaign.created', result.lastInsertRowid);
  res.status(201).json({ id: Number(result.lastInsertRowid) });
});

campaignRouter.put('/:id', (req, res) => {
  const item = schema.parse(req.body);
  const result = db.prepare("UPDATE campaigns SET name=?,channel=?,body=?,template_sid=?,audience_branch=?,scheduled_at=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='draft'").run(item.name, item.channel, item.body, item.template_sid, item.audience_branch, item.scheduled_at, req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'No encontramos un borrador editable con ese identificador.' });
  audit(req.admin.email, 'campaign.updated', req.params.id);
  res.json({ ok: true });
});

campaignRouter.post('/:id/launch', (req, res) => {
  const campaign = db.prepare("SELECT * FROM campaigns WHERE id=? AND status='draft'").get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'No encontramos un borrador disponible para enviar.' });
  if (mode === 'disabled') return res.status(409).json({ error: 'El proveedor de mensajería todavía no está habilitado en el servidor.' });
  if (campaign.channel === 'sms' && !smsReady) return res.status(409).json({ error: 'Falta configurar el remitente de SMS de Twilio.' });
  if (campaign.channel === 'whatsapp' && !whatsappReady) return res.status(409).json({ error: 'Falta configurar el remitente de WhatsApp de Twilio.' });
  if (campaign.channel === 'whatsapp' && !contentSidPattern.test(campaign.template_sid)) return res.status(400).json({ error: 'WhatsApp requiere el Content SID de una plantilla aprobada por Twilio (comienza con HX).' });
  const members = audienceMembers(campaign.audience_branch);
  if (!members.length) return res.status(400).json({ error: 'No hay miembros aprobados con autorización de comunicaciones en esta audiencia.' });
  const scheduledAt = campaign.scheduled_at || new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    const insert = db.prepare('INSERT INTO campaign_recipients (campaign_id,member_id,phone) VALUES (?,?,?)');
    for (const member of members) insert.run(campaign.id, member.id, member.whatsapp);
    db.prepare("UPDATE campaigns SET status='scheduled',scheduled_at=?,recipient_count=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(scheduledAt, members.length, campaign.id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  audit(req.admin.email, 'campaign.launched', campaign.id);
  res.json({ ok: true, recipients: members.length, scheduled_at: scheduledAt });
  processCampaignQueue().catch(error => console.error('No se pudo procesar la campaña:', error.message));
});

campaignRouter.delete('/:id', (req, res) => {
  const result = db.prepare("DELETE FROM campaigns WHERE id=? AND status='draft'").run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Solo puedes eliminar campañas en borrador.' });
  audit(req.admin.email, 'campaign.deleted', req.params.id);
  res.json({ ok: true });
});
