import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';

const testDir = await mkdtemp(path.join(os.tmpdir(), 'pelsa-test-'));
process.env.DATA_DIR = testDir; process.env.DATA_KEY = randomBytes(32).toString('hex');
process.env.APP_URL = 'http://localhost:4173'; process.env.COOKIE_SECURE = 'false';
const { db, passwordHash, decrypt } = await import('../server/db.mjs');
const { app } = await import('../server/app.mjs');
let server, base, cookie;
const image = await sharp({ create: { width: 80, height: 50, channels: 3, background: '#eecb00' } }).png().toBuffer();
function form(dui = '12345678-9', extra = {}) {
  const f = new FormData();
  for (const [k,v] of Object.entries({name:'Persona de prueba',email:'prueba@example.test',whatsapp:'50370000000',dui,branch_preference:'san_salvador',consent:'true',...extra})) f.set(k,v);
  f.set('front',new Blob([image],{type:'image/png'}),'front.png'); return f;
}
async function request(url, { method='GET', body, authenticated=false, origin='http://localhost:4173', redirect='follow' }={}) {
  const headers = { Origin:origin }; if (authenticated) headers.Cookie=cookie;
  if (body && !(body instanceof FormData)) { headers['Content-Type']='application/json'; body=JSON.stringify(body); }
  return fetch(base+url,{method,headers,body,redirect});
}
before(async()=>{
  db.prepare('INSERT INTO admins (email,name,password) VALUES (?,?,?)').run('admin@example.test','Admin de prueba',await passwordHash('test-password-long'));
  server = app.listen(0,'127.0.0.1'); await new Promise(r=>server.once('listening',r)); base=`http://127.0.0.1:${server.address().port}`;
  const response=await request('/api/login',{method:'POST',body:{email:'admin@example.test',password:'test-password-long'}});
  assert.equal(response.status,200); cookie=response.headers.get('set-cookie').split(';')[0]; assert.match(response.headers.get('set-cookie'),/HttpOnly/); assert.match(response.headers.get('set-cookie'),/SameSite=Strict/);
});
after(async()=>{ await new Promise(r=>server.close(r)); db.close(); const target=path.resolve(testDir); assert.ok(target.startsWith(path.resolve(os.tmpdir())+path.sep)); assert.ok(path.basename(target).startsWith('pelsa-test-')); await rm(target,{recursive:true,force:true}); });

test('registration, approval, privacy, referrals and suspension are durable and consistent',async()=>{
  assert.equal((await request('/api/admin/members')).status,401);
  assert.equal((await request('/api/admin/members/1/documents/front')).status,401);
  assert.equal((await request('/api/registrations',{method:'POST',body:form(),origin:'https://other.example'})).status,403);
  assert.equal((await request('/api/registrations',{method:'POST',body:form()})).status,201);
  assert.equal((await request('/api/registrations',{method:'POST',body:form('123456789')})).status,409);
  let row=db.prepare('SELECT * FROM members LIMIT 1').get(); assert.equal(row.status,'pending'); assert.equal(row.number,null); assert.equal(row.token,null); assert.equal(row.branch_preference,'san_salvador');
  assert.equal(row.back_file,'');
  assert.ok(!Buffer.from(row.dui_encrypted).includes(Buffer.from('123456789'))); assert.equal(decrypt(row.dui_encrypted).toString(),'123456789');
  const document=await readFile(path.join(testDir,'documents',row.front_file)); assert.notEqual(document[0],0xff); assert.ok(decrypt(document).length>0);
  const approved=await request(`/api/admin/members/${row.id}/review`,{method:'POST',authenticated:true,body:{status:'approved'}}); assert.equal(approved.status,200);
  const member=await approved.json(); assert.equal(member.number,'000001'); assert.equal(member.token.length,48);
  const profile=await(await request(`/api/members/${member.token}`)).json(); assert.equal(profile.email,null); assert.equal(profile.whatsapp,null); assert.equal(profile.dui,undefined); assert.equal(profile.front_file,undefined); assert.equal(profile.status,undefined);
  assert.equal((await request(`/api/admin/members/${row.id}/documents/front`,{authenticated:true})).headers.get('content-type'),'image/jpeg');
  assert.equal((await request(`/api/admin/members/${row.id}/documents/back`,{authenticated:true})).status,404);
  assert.equal((await request(`/api/admin/members/${row.id}/qr`,{authenticated:true})).headers.get('content-type'),'image/png');
  assert.equal((await request(`/api/admin/members/${row.id}/qr?type=referral`,{authenticated:true})).status,200);
  await request(`/api/admin/members/${row.id}`,{method:'PATCH',authenticated:true,body:{name:member.name,email:member.email,whatsapp:member.whatsapp,branch_preference:'ambas',show_email:true,show_whatsapp:false,marketing_opt_in:true}});
  assert.equal(db.prepare('SELECT branch_preference FROM members WHERE id=?').get(row.id).branch_preference,'ambas');
  const changed=await(await request(`/api/members/${member.token}`)).json(); assert.equal(changed.email,member.email); assert.equal(changed.whatsapp,null);
  await request(`/api/admin/members/${row.id}/review`,{method:'POST',authenticated:true,body:{status:'suspended'}}); assert.equal((await request(`/api/members/${member.token}`)).status,404);
  const reactivated=await(await request(`/api/admin/members/${row.id}/review`,{method:'POST',authenticated:true,body:{status:'approved'}})).json(); assert.equal(reactivated.number,member.number); assert.equal(reactivated.token,member.token);
  assert.equal((await request('/api/registrations',{method:'POST',body:form('98765432-1',{referral:'000001'})})).status,201);
  const referred=db.prepare('SELECT * FROM members WHERE id!=?').get(row.id); assert.equal(referred.referred_by,row.id);
  const second=await(await request(`/api/admin/members/${referred.id}/review`,{method:'POST',authenticated:true,body:{status:'approved'}})).json(); assert.equal(second.number,'000002');
  assert.equal((await request(`/api/admin/members/${referred.id}/review`,{method:'POST',authenticated:true,body:{status:'pending'}})).status,400);
  assert.ok(db.prepare('SELECT id FROM audit WHERE action=?').get('member.approved'));
});

test('invalid documents and referrals are rejected without orphan files',async()=>{
  const before=(await readdir(path.join(testDir,'documents'))).length;
  const f=form('11111111-1'); f.set('front',new Blob(['not an image'],{type:'image/png'}),'fake.png');
  assert.equal((await request('/api/registrations',{method:'POST',body:f})).status,400);
  assert.equal((await request('/api/registrations',{method:'POST',body:form('11111111-1',{referral:'999999'})})).status,400);
  assert.equal((await readdir(path.join(testDir,'documents'))).length,before);
  assert.equal((await request('/api/registrations',{method:'POST',body:form('invalid')})).status,400);
  assert.equal((await request('/api/registrations',{method:'POST',body:form('22222222-2',{whatsapp:'5037000A000'})})).status,400);
  const missingFront=form('33333333-3'); missingFront.delete('front');
  assert.equal((await request('/api/registrations',{method:'POST',body:missingFront})).status,400);
});

test('scheduled promotions and hidden benefits are excluded from public responses',async()=>{
  const now=Date.now();
  for (const [title,start,end,active] of [['Vigente',now-3600000,now+3600000,'true'],['Futura',now+3600000,now+7200000,'true'],['Pasada',now-7200000,now-3600000,'true'],['Oculta',now-3600000,now+3600000,'false']]) {
    const f=new FormData(); for(const[k,v] of Object.entries({title,description:'Condiciones de prueba',starts_at:new Date(start).toISOString(),ends_at:new Date(end).toISOString(),active})) f.set(k,v);
    if(title==='Vigente') f.set('image',new Blob([image],{type:'image/png'}),'promotion.png');
    assert.equal((await request('/api/admin/promotions',{method:'POST',authenticated:true,body:f})).status,200);
  }
  const content=await(await request('/api/content')).json(); assert.deepEqual(content.promotions.map(p=>p.title),['Vigente']);
  const activePromotion=content.promotions[0]; const activeMember=db.prepare("SELECT token,name FROM members WHERE status='approved' ORDER BY id LIMIT 1").get(); assert.ok(activePromotion.image); assert.equal((await request(`/api/promotions/${activePromotion.image}`)).status,200);
  const invalidClick=await request(`/api/promotions/${activePromotion.id}/click?member=invalid`,{method:'POST'}); assert.equal(invalidClick.status,404);
  const click=await request(`/api/promotions/${activePromotion.id}/click?member=${activeMember.token}`,{method:'POST'}); assert.equal(click.status,204);
  const fallback=await request(`/api/promotions/${activePromotion.id}/whatsapp?member=${activeMember.token}`); assert.equal(fallback.status,200); const fallbackHtml=await fallback.text(); assert.ok(fallbackHtml.includes(encodeURIComponent(`Soy ${activeMember.name}, miembro del Club de Electricistas.`)));
  let kpis=await(await request('/api/admin/kpis',{authenticated:true})).json(); assert.equal(kpis.summary.promotionClicks,2); assert.equal(kpis.promotions.find(p=>p.id===activePromotion.id).clicks,2); assert.ok(kpis.summary.profileViews>=2); assert.ok(kpis.members.some(m=>m.profile_views>=2));
  const b=content.benefits[0]; await request(`/api/admin/benefits/${b.id}`,{method:'PUT',authenticated:true,body:{...b,active:false}});
  const after=await(await request('/api/content')).json(); assert.ok(!after.benefits.find(i=>i.id===b.id));
  assert.equal((await request(`/api/admin/promotions/${activePromotion.id}`,{method:'DELETE',authenticated:true})).status,200);
  assert.ok(!(await(await request('/api/content')).json()).promotions.some(p=>p.id===activePromotion.id));
  await assert.rejects(readFile(path.join(testDir,'promotions',activePromotion.image)));
  kpis=await(await request('/api/admin/kpis',{authenticated:true})).json(); assert.ok(kpis.promotions.find(p=>p.id===activePromotion.id).deleted_at); assert.equal(kpis.summary.promotionClicks,2);
});

test('upcoming events support images and approved embedded video providers',async()=>{
  const now=Date.now();
  const videos=[['YouTube','https://www.youtube.com/watch?v=dQw4w9WgXcQ','youtube'],['Instagram','https://www.instagram.com/reel/ABC_123/','instagram'],['Facebook','https://www.facebook.com/example/videos/123456789/','facebook'],['TikTok','https://www.tiktok.com/@example/video/7123456789012345678','tiktok']];
  const ids=[];
  for (const [title,video,provider] of videos) {
    const f=new FormData(); for(const[k,v] of Object.entries({title:`Evento ${title}`,description:'Actividad para miembros del club',location:'PELSA San Salvador',starts_at:new Date(now+3600000).toISOString(),ends_at:new Date(now+7200000).toISOString(),registration_url:'https://example.test/registro',video_url:video,active:'true'})) f.set(k,v);
    if(title==='YouTube') f.set('image',new Blob([image],{type:'image/png'}),'evento.png');
    const response=await request('/api/admin/events',{method:'POST',authenticated:true,body:f}); assert.equal(response.status,200); ids.push((await response.json()).id);
    assert.equal(db.prepare('SELECT video_provider FROM events WHERE id=?').get(ids.at(-1)).video_provider,provider);
  }
  const invalid=new FormData(); for(const[k,v] of Object.entries({title:'Evento inválido',description:'No debe guardarse',location:'PELSA',starts_at:new Date(now+3600000).toISOString(),ends_at:new Date(now+7200000).toISOString(),registration_url:'',video_url:'https://example.com/video/123',active:'true'})) invalid.set(k,v);
  assert.equal((await request('/api/admin/events',{method:'POST',authenticated:true,body:invalid})).status,400);
  const content=await(await request('/api/content')).json(); assert.equal(content.events.length,4); assert.deepEqual(new Set(content.events.map(event=>event.video_provider)),new Set(['youtube','instagram','facebook','tiktok']));
  const first=content.events.find(event=>event.video_provider==='youtube'); assert.ok(first.image); assert.equal((await request(`/api/events/media/${first.image}`)).status,200); assert.equal((await request(`/api/admin/events/${first.id}/image`,{authenticated:true})).status,200);
  assert.equal((await request(`/api/admin/events/${first.id}`,{method:'DELETE',authenticated:true})).status,200); assert.ok(!(await(await request('/api/content')).json()).events.some(event=>event.id===first.id)); await assert.rejects(readFile(path.join(testDir,'events',first.image)));
});

test('services and product categories are editable, ordered and publicly filtered',async()=>{
  assert.equal(db.prepare('SELECT COUNT(*) count FROM solutions').get().count,20); db.prepare('DELETE FROM solutions').run();
  assert.equal((await request('/api/admin/solutions',{method:'POST',body:{kind:'service',title:'Sin acceso',description:'No debe guardarse',icon:'wrench',position:0,active:true}})).status,401);
  const product=await(await request('/api/admin/solutions',{method:'POST',authenticated:true,body:{kind:'product',title:'Iluminación',description:'Categoría de productos para proyectos eléctricos.',icon:'lightbulb',position:2,active:true}})).json();
  const service=await(await request('/api/admin/solutions',{method:'POST',authenticated:true,body:{kind:'service',title:'Asesoría técnica',description:'Acompañamiento para elegir soluciones.',icon:'wrench',position:1,active:true}})).json();
  await request('/api/admin/solutions',{method:'POST',authenticated:true,body:{kind:'product',title:'Categoría oculta',description:'No debe aparecer públicamente.',icon:'package',position:0,active:false}});
  let content=await(await request('/api/content')).json(); assert.deepEqual(content.solutions.map(item=>item.title),['Asesoría técnica','Iluminación']);
  assert.equal((await request(`/api/admin/solutions/${product.id}`,{method:'PUT',authenticated:true,body:{kind:'product',title:'Iluminación y control',description:'Portafolio actualizado.',icon:'zap',position:0,active:true}})).status,200);
  content=await(await request('/api/content')).json(); assert.equal(content.solutions[0].title,'Iluminación y control');
  assert.equal((await request(`/api/admin/solutions/${service.id}`,{method:'DELETE',authenticated:true})).status,200); assert.ok(!(await(await request('/api/content')).json()).solutions.some(item=>item.id===service.id));
});

test('campaign drafts segment only members with communication consent',async()=>{
  assert.equal((await request('/api/admin/campaigns')).status,401);
  let dashboard=await(await request('/api/admin/campaigns',{authenticated:true})).json(); assert.ok(dashboard.audiences.all>=1); assert.equal(dashboard.config.mode,'pending_provider');
  const created=await(await request('/api/admin/campaigns',{method:'POST',authenticated:true,body:{name:'Evento de prueba',channel:'whatsapp',body:'Te esperamos en nuestro próximo evento.',template_sid:'',audience_branch:'all',scheduled_at:null}})).json(); assert.ok(created.id);
  dashboard=await(await request('/api/admin/campaigns',{authenticated:true})).json(); assert.equal(dashboard.campaigns[0].name,'Evento de prueba');
  assert.equal((await request(`/api/admin/campaigns/${created.id}/launch`,{method:'POST',authenticated:true})).status,409);
  assert.equal((await request(`/api/admin/campaigns/${created.id}`,{method:'DELETE',authenticated:true})).status,200);
});

test('admins can permanently remove a profile without breaking referrals',async()=>{
  const member=db.prepare("SELECT * FROM members WHERE status='approved' ORDER BY id LIMIT 1").get(); assert.ok(member);
  const referred=db.prepare('SELECT id FROM members WHERE referred_by=? LIMIT 1').get(member.id); assert.ok(referred);
  assert.equal((await request(`/api/admin/members/${member.id}`,{method:'DELETE',authenticated:true})).status,200);
  assert.equal((await request(`/api/members/${member.token}`)).status,404);
  assert.equal(db.prepare('SELECT referred_by FROM members WHERE id=?').get(referred.id).referred_by,null);
  assert.ok(db.prepare("SELECT id FROM audit WHERE action='member.deleted'").get());
  assert.equal((await request('/api/registrations',{method:'POST',body:form('44444444-4')})).status,201);
  const replacement=db.prepare("SELECT * FROM members WHERE dui_hash!=? AND number IS NULL ORDER BY id DESC LIMIT 1").get(member.dui_hash); assert.ok(replacement);
  const approved=await(await request(`/api/admin/members/${replacement.id}/review`,{method:'POST',authenticated:true,body:{status:'approved'}})).json(); assert.equal(approved.number,String(member.number).padStart(6,'0'));
});

test('logout invalidates the server-side session',async()=>{
  assert.equal((await request('/api/admin/logout',{method:'POST',authenticated:true})).status,200);
  assert.equal((await request('/api/admin/me',{authenticated:true})).status,401);
});
