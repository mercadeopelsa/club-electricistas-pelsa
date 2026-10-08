import { Router } from 'express';
import { z } from 'zod';
import { db, audit } from './db.mjs';

export const campaignRouter = Router();
const branchWhere = `status='approved' AND marketing_opt_in=1 AND whatsapp GLOB '503[267][0-9][0-9][0-9][0-9][0-9][0-9][0-9]' AND (?='all' OR (?='san_salvador' AND branch_preference IN ('san_salvador','ambas')) OR (?='san_miguel' AND branch_preference IN ('san_miguel','ambas')))`;
const audienceCount = branch => db.prepare(`SELECT COUNT(*) count FROM members WHERE ${branchWhere}`).get(branch,branch,branch).count;
const schema = z.object({ name:z.string().trim().min(3).max(120), channel:z.enum(['sms','whatsapp']), body:z.string().trim().min(3).max(1500), template_sid:z.string().trim().max(80).default(''), audience_branch:z.enum(['all','san_salvador','san_miguel']), scheduled_at:z.union([z.iso.datetime(),z.null()]).default(null) });
const list = () => db.prepare('SELECT * FROM campaigns ORDER BY created_at DESC,id DESC').all();

campaignRouter.get('/', (_req,res) => res.json({ campaigns:list(), config:{ mode:'pending_provider', smsReady:false, whatsappReady:false }, audiences:{ all:audienceCount('all'), san_salvador:audienceCount('san_salvador'), san_miguel:audienceCount('san_miguel') } }));
campaignRouter.post('/', (req,res) => {
  const item=schema.parse(req.body); const result=db.prepare('INSERT INTO campaigns (name,channel,body,template_sid,audience_branch,scheduled_at,created_by) VALUES (?,?,?,?,?,?,?)').run(item.name,item.channel,item.body,item.template_sid,item.audience_branch,item.scheduled_at,req.admin.id);
  audit(req.admin.email,'campaign.created',result.lastInsertRowid); res.status(201).json({id:Number(result.lastInsertRowid)});
});
campaignRouter.put('/:id',(req,res)=>{
  const item=schema.parse(req.body); const result=db.prepare("UPDATE campaigns SET name=?,channel=?,body=?,template_sid=?,audience_branch=?,scheduled_at=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='draft'").run(item.name,item.channel,item.body,item.template_sid,item.audience_branch,item.scheduled_at,req.params.id);
  if(!result.changes)return res.status(404).json({error:'No encontramos un borrador editable con ese identificador.'}); audit(req.admin.email,'campaign.updated',req.params.id); res.json({ok:true});
});
campaignRouter.post('/:id/launch',(_req,res)=>res.status(409).json({error:'El envío automático requiere autorizar y configurar un proveedor empresarial de mensajería.'}));
campaignRouter.delete('/:id',(req,res)=>{
  const result=db.prepare("DELETE FROM campaigns WHERE id=? AND status='draft'").run(req.params.id); if(!result.changes)return res.status(404).json({error:'Solo puedes eliminar campañas en borrador.'}); audit(req.admin.email,'campaign.deleted',req.params.id); res.json({ok:true});
});
