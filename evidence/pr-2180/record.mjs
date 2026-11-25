import assert from 'node:assert/strict';
import { mkdir, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

const {APP_URL,VARIANT,OUTPUT_DIR,CHROMIUM_PATH}=process.env;
assert(APP_URL && OUTPUT_DIR && /^(before|after)$/.test(VARIANT ?? ''));
const url=new URL(APP_URL);
assert.equal(url.protocol,'http:');
assert(['127.0.0.1','localhost'].includes(url.hostname));
const { chromium }=createRequire(resolve('apps/app/package.json'))('playwright');
const out=resolve(OUTPUT_DIR);
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,...(CHROMIUM_PATH ? {executablePath:CHROMIUM_PATH} : {})});
const size={width:1280,height:720};
const context=await browser.newContext({viewport:size,recordVideo:{dir:out,size}});
const page=await context.newPage();
const video=page.video();
const topStarted=Promise.withResolvers();
const topRelease=Promise.withResolvers();
const unexpected=[];
const proofTime=Date.UTC(2026,10,25,5,0,0);
const text={
 old:'Latest timeline: Today’s news',
 top:'Top timeline: Most-liked story'
};
const post=(id,content)=>({
  id,content,authorId:'qa-editor',authorKind:'user',authorHandle:'qa-editor',
  authorDisplayName:'QA Editor',createdAt:proofTime-60_000,likeCount:1,replyCount:0,repostCount:0,
});
const fixture=async route=>{
 const x=new URL(route.request().url());
 if(x.origin!==url.origin){unexpected.push(x.href);return route.abort();}
 const path=x.pathname;
 if(path==='/api/events')return route.fulfill({status:200,contentType:'text/event-stream',body:': QA fixture\n\n'});
 if(path==='/api/auth/me')return route.fulfill({json:{authenticated:false,viewer:null,acceptedCountries:['+1'],publicAppUrl:url.origin}});
 if(path==='/api/feed'){
   const tab=x.searchParams.get('tab');
   if(tab==='top'){topStarted.resolve();await topRelease.promise;return route.fulfill({json:{items:[post('top',text.top)],nextCursor:null}});}
   if(tab==='latest')return route.fulfill({json:{items:[post('latest',text.old)],nextCursor:'latest-2'}});
   unexpected.push('feed tab '+tab); return route.fulfill({status:404,json:{}});
 }
 if(path==='/api/skills/hosts')return route.fulfill({json:{hosts:[]}});
 if(path==='/api/trending')return route.fulfill({json:[]});
 if(path==='/api/articles')return route.fulfill({json:[]});
 if(path==='/api/world/status'||path==='/api/world')return route.fulfill({json:{gameRunning:false}});
 return route.fulfill({status:404,json:{}});
};
const label=async content=>{
 await page.evaluate(({variant,content})=>{
   let card=document.getElementById('dot-proof-step');
   if(!card){ card=document.createElement('div'); card.id='dot-proof-step'; Object.assign(card.style,{position:'fixed',right:'10px',bottom:'10px',maxWidth:'430px',zIndex:'2147483647',background:'#182349',color:'white',padding:'10px 12px',font:'600 15px system-ui',borderRadius:'8px',pointerEvents:'none',whiteSpace:'pre-line'}); document.body.append(card); }
   card.textContent=variant.toUpperCase()+' | Feed #2180\n'+content;
 },{variant:VARIANT,content});
};
const deadline=(promise,message)=>Promise.race([promise,new Promise((_,reject)=>{const id=setTimeout(()=>reject(Error(message)),12000);id.unref();})]);
let succeeded=false;
try{
 await page.clock.setFixedTime(proofTime);
 await context.route('**/*',route=>{const req=new URL(route.request().url()); if(req.origin!==url.origin)return route.abort(); return req.pathname.startsWith('/api/')?fixture(route):route.continue();});
 await page.goto(url.href,{waitUntil:'domcontentloaded',timeout:25000});
 const selected=(name)=>page.getByRole('tab',{name,exact:true}).getAttribute('aria-selected');
 const checkVisible=(value)=>page.getByText(value,{exact:true}).waitFor({state:'visible',timeout:10000});
 const initial=page.getByText(text.old,{exact:true});
 const moreButton=page.getByRole('button',{name:'Load more',exact:true});
 await checkVisible(text.old);
 assert.equal(await selected('Latest'),'true');
 const dismiss=page.getByRole('button',{name:'Dismiss',exact:true});
 if(await dismiss.isVisible())await dismiss.click();
 await label('1. Latest is selected and its story is visible.');
 await page.waitForTimeout(1250);
 await page.getByRole('tab',{name:'For You',exact:true}).click();
 await deadline(topStarted.promise,'Top request was not observed');
 await page.waitForTimeout(450);
 assert.equal(await selected('For You'),'true');
 const staleDuringTop=await initial.isVisible();
 const staleCursor=await moreButton.isVisible();
 assert.equal(staleDuringTop,VARIANT==='before','old rows during pending Top');
 assert.equal(staleCursor,VARIANT==='before','old pagination during pending Top');
 await label(VARIANT==='before'?'BUG: Top is selected, but the old Latest story and Load more still show.':'FIXED: Top is selected; the old Latest story and Load more are gone.');
 await page.waitForTimeout(2100);
 topRelease.resolve();
 await checkVisible(text.top);
 assert.equal(await selected('For You'),'true');
 assert(!(await initial.isVisible()));
 assert(!(await moreButton.isVisible()));
 assert.deepEqual(unexpected,[]);
 await label('3. Top arrives and displays its own story.');
 console.log(JSON.stringify({case:2180,variant:VARIANT,activeTab:'For You',staleLatestDuringLoad:staleDuringTop,staleCursorDuringLoad:staleCursor,topPost:true}));
 await page.waitForTimeout(1300);
 succeeded=true;
}finally{
 topRelease.resolve();
 try{await context.close();if(video&&succeeded)await rename(await video.path(),resolve(out,`2180-${VARIANT}.webm`));}finally{await browser.close();}
}
