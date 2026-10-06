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
  for (const [k,v] of Object.entries({name:'Persona de prueba',email:'prueba@example.test',whatsapp:'50370000000',dui,consent:'true',...extra})) f.set(k,v);
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
  let row=db.prepare('SELECT * FROM members LIMIT 1').get(); assert.equal(row.status,'pending'); assert.equal(row.number,null); assert.equal(row.token,null);
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
  await request(`/api/admin/members/${row.id}`,{method:'PATCH',authenticated:true,body:{name:member.name,email:member.email,whatsapp:member.whatsapp,show_email:true,show_whatsapp:false}});
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
  const activePromotion=content.promotions[0]; const activeMember=db.prepare("SELECT token FROM members WHERE status='approved' ORDER BY id LIMIT 1").get(); assert.ok(activePromotion.image); assert.equal((await request(`/api/promotions/${activePromotion.image}`)).status,200);
  const invalidClick=await request(`/api/promotions/${activePromotion.id}/whatsapp?member=invalid`,{redirect:'manual'}); assert.equal(invalidClick.status,404);
  const click=await request(`/api/promotions/${activePromotion.id}/whatsapp?member=${activeMember.token}`,{redirect:'manual'}); assert.equal(click.status,302); assert.match(click.headers.get('location'),/^https:\/\/wa\.me\/50370690808\?text=/); assert.equal(new URL(click.headers.get('location')).searchParams.get('text'),'Me gustaría cotizar Vigente');
  let kpis=await(await request('/api/admin/kpis',{authenticated:true})).json(); assert.equal(kpis.summary.promotionClicks,1); assert.equal(kpis.promotions.find(p=>p.id===activePromotion.id).clicks,1); assert.ok(kpis.summary.profileViews>=2); assert.ok(kpis.members.some(m=>m.profile_views>=2));
  const b=content.benefits[0]; await request(`/api/admin/benefits/${b.id}`,{method:'PUT',authenticated:true,body:{...b,active:false}});
  const after=await(await request('/api/content')).json(); assert.ok(!after.benefits.find(i=>i.id===b.id));
  assert.equal((await request(`/api/admin/promotions/${activePromotion.id}`,{method:'DELETE',authenticated:true})).status,200);
  assert.ok(!(await(await request('/api/content')).json()).promotions.some(p=>p.id===activePromotion.id));
  await assert.rejects(readFile(path.join(testDir,'promotions',activePromotion.image)));
  kpis=await(await request('/api/admin/kpis',{authenticated:true})).json(); assert.ok(kpis.promotions.find(p=>p.id===activePromotion.id).deleted_at); assert.equal(kpis.summary.promotionClicks,1);
});

test('logout invalidates the server-side session',async()=>{
  assert.equal((await request('/api/admin/logout',{method:'POST',authenticated:true})).status,200);
  assert.equal((await request('/api/admin/me',{authenticated:true})).status,401);
});
