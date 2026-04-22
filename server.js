/**
 * JobHunter AI – Windows Server v2
 * Start: node server.js
 */
const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');
const zlib  = require('zlib');
const net   = require('net');
const tls   = require('tls');
const { DatabaseSync } = require('node:sqlite');

const FILES = {
  jobs:    path.join(__dirname, 'jobs.json'),
  profile: path.join(__dirname, 'profile.json'),
  search:  path.join(__dirname, 'search.json'),
  env:     path.join(__dirname, '.env'),
};

const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
function listUploads() {
  try {
    return fs.readdirSync(UPLOADS_DIR)
      .filter(f => /\.(pdf|docx?|txt|png|jpe?g)$/i.test(f))
      .map(f => ({ name: f, size: fs.statSync(path.join(UPLOADS_DIR, f)).size }));
  } catch(e) { return []; }
}

const CONFIG = { PORT: 3000, ANTHROPIC_API_KEY: '', SCAN_INTERVAL_MINUTES: 60, AI_MODE: 'anthropic', OLLAMA_URL: 'http://localhost:11434', OLLAMA_MODEL: 'llama3.1:70b-instruct-q4_K_M', SMTP_HOST: '', SMTP_PORT: 587, SMTP_USER: '', SMTP_PASS: '', USER_EMAIL: '' };

const DEFAULT_SEARCH = {
  keywords: [
    'Junior Software Developer','Junior Frontend Developer','Junior Backend Developer',
    'Junior Full Stack Developer','Softwareentwickler Junior','Junior React Developer',
    'SAP Junior Consultant','Junior SAP Developer','UX Designer Junior',
    'Junior UX Developer','Junior Embedded Developer','Quereinsteiger Softwareentwicklung',
    'Junior IT Developer','Junior Web Developer',
  ],
  location: 'Schweinfurt',
  radius_km: 10,
  radius_car_km: 50,
  want_remote: true,
  want_local: true,
  want_car: true,
  sources: { aa: true, indeed: true, stepstone: true, linkedin: false, xing: false, heise: true, google: true },
  custom_sources: [],
};

// ── SQLITE DATABASE ──────────────────────────────────────────────────────
const db = new DatabaseSync(path.join(__dirname, 'jobhunter.db'));
db.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA synchronous=NORMAL;
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', company TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '', remote INTEGER NOT NULL DEFAULT 0,
    local INTEGER NOT NULL DEFAULT 1, car INTEGER NOT NULL DEFAULT 0,
    salary TEXT, posted TEXT NOT NULL DEFAULT '', keywords TEXT NOT NULL DEFAULT '[]',
    desc TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'new',
    match INTEGER NOT NULL DEFAULT 0, scraped_at TEXT, applied_at TEXT
  );
  CREATE TABLE IF NOT EXISTS profile (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
  CREATE TABLE IF NOT EXISTS config  (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
`);

function dbGet(key, def='') {
  const r = db.prepare('SELECT value FROM config WHERE key=?').get(key);
  return r ? r.value : def;
}
function dbSet(key, value) {
  db.prepare('INSERT OR REPLACE INTO config (key,value) VALUES (?,?)').run(key, String(value??''));
}

function deserJob(r) {
  return { id:r.id, title:r.title, company:r.company, location:r.location,
    remote:!!r.remote, local:!!r.local, car:!!r.car, salary:r.salary, posted:r.posted,
    keywords:(()=>{try{return JSON.parse(r.keywords);}catch(e){return [];}})(),
    desc:r.desc, url:r.url, source:r.source, status:r.status, match:r.match,
    scrapedAt:r.scraped_at, appliedAt:r.applied_at };
}
function serJob(j) {
  return [j.id, j.title||'', j.company||'', j.location||'',
    j.remote?1:0, j.local!==false?1:0, j.car?1:0,
    j.salary||null, j.posted||'', JSON.stringify(j.keywords||[]),
    j.desc||'', j.url||'', j.source||'', j.status||'new',
    j.match||0, j.scrapedAt||null, j.appliedAt||null];
}

function loadJobs() {
  const jobs = db.prepare('SELECT * FROM jobs ORDER BY match DESC, scraped_at DESC').all().map(deserJob);
  return { jobs, lastScan:dbGet('lastScan')||null, scanCount:parseInt(dbGet('scanCount','0')), newThisScan:parseInt(dbGet('newThisScan','0')) };
}
function saveJobs(data) {
  const ins = db.prepare('INSERT OR REPLACE INTO jobs (id,title,company,location,remote,local,car,salary,posted,keywords,desc,url,source,status,match,scraped_at,applied_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  db.exec('BEGIN');
  try {
    for (const j of data.jobs) ins.run(...serJob(j));
    db.exec("DELETE FROM jobs WHERE id NOT IN (SELECT id FROM jobs ORDER BY match DESC, scraped_at DESC LIMIT 600)");
    db.exec('COMMIT');
  } catch(e) { db.exec('ROLLBACK'); throw e; }
  if (data.lastScan !== undefined) dbSet('lastScan', data.lastScan||'');
  if (data.scanCount !== undefined) dbSet('scanCount', data.scanCount);
  if (data.newThisScan !== undefined) dbSet('newThisScan', data.newThisScan);
}
function getJob(id) {
  const r = db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
  return r ? deserJob(r) : null;
}
function updateJob(id, fields) {
  // Only allow safe columns to be updated
  const colMap = { status:'status', match:'match', appliedAt:'applied_at', applied_at:'applied_at' };
  const entries = Object.entries(fields).map(([k,v])=>[colMap[k],v]).filter(([k])=>k);
  if (!entries.length) return;
  db.prepare(`UPDATE jobs SET ${entries.map(([k])=>k+'=?').join(',')} WHERE id=?`).run(...entries.map(([,v])=>v), id);
}

function loadProfile() {
  const rows = db.prepare('SELECT key,value FROM profile').all();
  const p = { name:'', email:'', phone:'', skills:'', experience:'', bio:'', location:'', cvSkills:[], want_remote:true, want_local:true, want_car:true, radius_km:10, radius_car_km:50 };
  for (const { key, value } of rows) {
    if (key==='cvSkills') { try { p.cvSkills=JSON.parse(value); } catch(e) {} }
    else if (['want_remote','want_local','want_car'].includes(key)) p[key] = value==='true';
    else if (['radius_km','radius_car_km'].includes(key)) p[key] = parseInt(value)||p[key];
    else p[key] = value;
  }
  return p;
}
function saveProfileData(data) {
  const stmt = db.prepare('INSERT OR REPLACE INTO profile (key,value) VALUES (?,?)');
  for (const [key,value] of Object.entries(data)) {
    if (value===undefined) continue;
    stmt.run(key, Array.isArray(value)?JSON.stringify(value):String(value??''));
  }
}
function loadSearch() {
  try { const r=db.prepare("SELECT value FROM config WHERE key='search'").get(); if(r) return {...DEFAULT_SEARCH,...JSON.parse(r.value)}; } catch(e) {}
  return {...DEFAULT_SEARCH};
}
function saveSearch(cfg) { db.prepare("INSERT OR REPLACE INTO config (key,value) VALUES ('search',?)").run(JSON.stringify(cfg)); }

// Migrate existing JSON data on first run (runs once)
function migrateFromJSON() {
  try {
    if (fs.existsSync(FILES.jobs)) {
      const cnt = db.prepare('SELECT COUNT(*) as n FROM jobs').get().n;
      if (cnt === 0) {
        const d = JSON.parse(fs.readFileSync(FILES.jobs,'utf8'));
        if (d.jobs?.length) {
          if (d.lastScan) dbSet('lastScan', d.lastScan);
          if (d.scanCount) dbSet('scanCount', d.scanCount);
          const uins = db.prepare('INSERT OR IGNORE INTO jobs (id,title,company,location,remote,local,car,salary,posted,keywords,desc,url,source,status,match,scraped_at,applied_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
          db.exec('BEGIN');
          for (const j of d.jobs) uins.run(...serJob(j));
          db.exec('COMMIT');
          console.log(`[DB] ${d.jobs.length} Jobs aus jobs.json migriert`);
        }
      }
    }
  } catch(e) { console.log('[DB Migration] jobs:', e.message); }
  try {
    if (fs.existsSync(FILES.profile)) {
      const cnt = db.prepare('SELECT COUNT(*) as n FROM profile').get().n;
      if (cnt === 0) { saveProfileData(JSON.parse(fs.readFileSync(FILES.profile,'utf8'))); console.log('[DB] Profil aus profile.json migriert'); }
    }
  } catch(e) { console.log('[DB Migration] profile:', e.message); }
  try {
    if (fs.existsSync(FILES.search)) {
      const r = db.prepare("SELECT value FROM config WHERE key='search'").get();
      if (!r) { saveSearch(JSON.parse(fs.readFileSync(FILES.search,'utf8'))); console.log('[DB] Suchkonfig aus search.json migriert'); }
    }
  } catch(e) { console.log('[DB Migration] search:', e.message); }
}

function fetchUrl(targetUrl, options={}) {
  return new Promise((resolve,reject) => {
    const parsed = new URL(targetUrl);
    const lib = parsed.protocol==='https:' ? https : http;
    const opts = {
      hostname: parsed.hostname, path: parsed.pathname+parsed.search,
      method: options.method||'GET', timeout: options.timeout||18000,
      headers: {
        'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept':'text/html,application/json,*/*;q=0.8',
        'Accept-Language':'de-DE,de;q=0.9','Accept-Encoding':'identity',
        ...options.headers,
      },
    };
    const req = lib.request(opts, res => {
      if (res.statusCode>=300&&res.statusCode<400&&res.headers.location)
        return fetchUrl(res.headers.location,options).then(resolve).catch(reject);
      let data=''; res.on('data',c=>data+=c); res.on('end',()=>resolve({status:res.statusCode,body:data}));
    });
    req.on('error',reject);
    req.on('timeout',()=>{req.destroy();reject(new Error('Timeout'));});
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function scrapeArbeitsagentur(kw, sc) {
  const jobs=[];
  try {
    const wo=sc.location||'Schweinfurt';
    const umkreis=sc.want_car ? Math.max(sc.radius_km||10, sc.radius_car_km||50) : sc.radius_km||10;
    const params=new URLSearchParams({angebotsart:'1',was:kw,wo,umkreis:String(umkreis),page:'1',size:'25',zeitarbeit:'false'});
    const res=await fetchUrl(`https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/jobs?${params}`,{
      headers:{'X-API-Key':'jobboerse-jobsuche','Accept':'application/json'}
    });
    if (res.status!==200){console.log(`  AA(${kw}): HTTP ${res.status}`);return jobs;}
    const data=JSON.parse(res.body);
    const list=data.stellenangebote||data.jobs||data.items||[];
    for (const s of list.slice(0,20)) {
      // API now returns 'arbeitsort' as single object (not array 'arbeitsorte')
      const ort=s.arbeitsort||s.arbeitsorte?.[0]||{};
      const ortName=ort.ort||ort.bezeichnung||sc.location;
      const locStr=ortName+' '+(ort.region||'');
      const full=s.titel+' '+locStr;
      const isRemote=/remote|homeoffice/i.test(full)||s.homeoffice==='nv_true';
      const hasCar=/dienstwagen|firmenwagen/i.test(s.titel||'');
      // Use refnr (new) or hashId (old) as identifier
      const refnr=s.refnr||s.hashId||s.id||'';
      // Prefer external URL if present, otherwise link to Arbeitsagentur detail
      const jobUrl=s.externeUrl||`https://www.arbeitsagentur.de/jobsuche/jobdetail/${encodeURIComponent(refnr)}`;
      jobs.push({
        id:'aa_'+refnr.replace(/[^a-zA-Z0-9]/g,'-'),
        title:s.titel||kw,
        company:s.arbeitgeber||s.arbeitgeberName||'Unbekannt',
        location:isRemote?'Remote':ortName,
        remote:isRemote,local:!isRemote,car:hasCar,
        salary:s.verguetung||null,
        posted:s.aktuelleVeroeffentlichungsdatum||s.eintrittsdatum||new Date().toISOString().split('T')[0],
        keywords:extractKw(s.titel||''),
        desc:(s.titel||'')+(ortName?' · '+ortName:'')+(s.arbeitgeber?' bei '+s.arbeitgeber:''),
        url:jobUrl,
        source:'Arbeitsagentur',status:'new',match:0,scrapedAt:new Date().toISOString()
      });
    }
  } catch(e){console.log(`  AA(${kw}):${e.message}`);}
  return jobs;
}

async function scrapeIndeed(kw, sc) {
  // HTML scraping with mosaic-provider-jobcards embedded JSON
  const jobs=[];
  try {
    const loc=sc.location||'Deutschland';
    const radius=Math.max(sc.radius_km||10,25);
    const params=new URLSearchParams({q:kw,l:loc,fromage:'14',radius:String(radius),sort:'date'});
    const res=await fetchUrl(`https://de.indeed.com/jobs?${params}`,{
      timeout:20000,
      headers:{
        'Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language':'de-DE,de;q=0.9,en;q=0.8',
        'Referer':'https://de.indeed.com/',
        'Cache-Control':'no-cache','Pragma':'no-cache'
      }
    });
    if (res.status!==200){console.log(`  Indeed(${kw}): HTTP ${res.status}`);return jobs;}
    // Try mosaic embedded JSON
    const mm=res.body.match(/window\.mosaic\.providerData\["mosaic-provider-jobcards"\]\s*=\s*(\{[\s\S]*?\});\s*(?:window|<)/);
    if (mm) {
      try {
        const d=JSON.parse(mm[1]);
        const results=d?.metaData?.mosaicProviderJobCardsModel?.results||[];
        for (const item of results.slice(0,15)) {
          if (!item?.jobkey||!item?.jobTitle) continue;
          const city=item.jobLocationCity||item.formattedLocation||loc;
          const isRemote=/remote|homeoffice/i.test((item.jobTitle||'')+' '+city);
          jobs.push({id:'in_'+item.jobkey,title:item.jobTitle,company:item.company||'Unbekannt',
            location:isRemote?'Remote':city,remote:isRemote,local:!isRemote,
            car:/dienstwagen|firmenwagen/i.test(item.snippet||''),salary:null,
            posted:item.pubDate?new Date(item.pubDate*1000).toISOString().split('T')[0]:new Date().toISOString().split('T')[0],
            keywords:extractKw(item.jobTitle+' '+(item.snippet||'')),
            desc:(item.snippet||item.jobTitle||'').replace(/<[^>]+>/g,'').slice(0,350),
            url:`https://de.indeed.com/viewjob?jk=${item.jobkey}`,
            source:'Indeed',status:'new',match:0,scrapedAt:new Date().toISOString()});
        }
        if (jobs.length>0) return jobs;
      } catch(e){}
    }
    // Fallback: parse data-jk + title from HTML
    const jks=[...res.body.matchAll(/data-jk="([^"]{8,20})"/g)].map(m=>m[1]);
    const titles=[...res.body.matchAll(/<span[^>]+title="([^"]{5,100})"[^>]*>/g)].map(m=>m[1]);
    const companies=[...res.body.matchAll(/class="[^"]*companyName[^"]*"[^>]*>([\s\S]*?)<\/span>/g)].map(m=>m[1].replace(/<[^>]+>/g,'').trim());
    const locRe=[...res.body.matchAll(/class="[^"]*companyLocation[^"]*"[^>]*>([\s\S]*?)<\/div>/g)].map(m=>m[1].replace(/<[^>]+>/g,'').trim());
    for (let i=0;i<Math.min(jks.length,15);i++) {
      const jk=jks[i]; const title=titles[i]||kw;
      const company=companies[i]||'Unbekannt'; const jobLoc=locRe[i]||loc;
      const isRemote=/remote|homeoffice/i.test(title+' '+jobLoc);
      jobs.push({id:'in_'+jk,title,company,location:isRemote?'Remote':jobLoc,
        remote:isRemote,local:!isRemote,car:false,salary:null,
        posted:new Date().toISOString().split('T')[0],keywords:extractKw(title),
        desc:`${title} bei ${company} (${jobLoc})`,
        url:`https://de.indeed.com/viewjob?jk=${jk}`,
        source:'Indeed',status:'new',match:0,scrapedAt:new Date().toISOString()});
    }
  } catch(e){console.log(`  Indeed(${kw}):${e.message}`);}
  return jobs;
}

// Recursively find first array in nested object whose items satisfy pred
function deepFindArr(o,pred,d=0){
  if(d>12||o===null||typeof o!=='object')return null;
  if(Array.isArray(o)){if(o.length>0&&pred(o[0]))return o;for(const v of o){const r=deepFindArr(v,pred,d+1);if(r)return r;}}
  else{for(const v of Object.values(o)){const r=deepFindArr(v,pred,d+1);if(r)return r;}}
  return null;
}

async function scrapeStepstone(kw, sc) {
  const jobs=[];
  try {
    const radius=sc.radius_km||10;
    const loc=(sc.location||'Deutschland').toLowerCase();
    const slug=kw.toLowerCase()
      .replace(/ä/g,'ae').replace(/ö/g,'oe').replace(/ü/g,'ue').replace(/ß/g,'ss')
      .replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
    const locSlug=loc.replace(/ä/g,'ae').replace(/ö/g,'oe').replace(/ü/g,'ue').replace(/ß/g,'ss')
      .replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
    const res=await fetchUrl(
      `https://www.stepstone.de/jobs/${slug}/in-${locSlug}?radius=${radius}&sort=2`,
      {timeout:20000,headers:{'Accept-Language':'de-DE,de;q=0.9','Cache-Control':'no-cache'}}
    );
    if (res.status!==200){console.log(`  SS(${kw}): HTTP ${res.status}`);return jobs;}

    // Primary: recursive search through __NEXT_DATA__
    const ndm=res.body.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (ndm) {
      try {
        const nd=JSON.parse(ndm[1]);
        const pred=item=>!!(item&&item.title&&typeof item.title==='string'&&item.title.length>3&&(item.company||item.employer||item.id||item.jobId));
        const listings=deepFindArr(nd,pred)||[];
        for (const item of listings.slice(0,15)) {
          if (!item||!item.title) continue;
          const company=(typeof item.company==='object'?item.company?.name:item.company)||item.employer?.name||item.companyName||'Unbekannt';
          const city=item.location?.city||item.location?.name||item.city||loc;
          const isRemote=item.isHomeOffice||item.remoteType==='FULL_REMOTE'||/remote|homeoffice/i.test(city+' '+item.title);
          const posted=(item.dateCreated||item.datePosted||'').split('T')[0]||new Date().toISOString().split('T')[0];
          const jobUrl=item.url||(item.slug?`https://www.stepstone.de/stellenangebote/${item.slug}`:'')||`https://www.stepstone.de/jobs/${item.id||''}`;
          const desc=(item.description||item.snippet||item.shortDescription||'').replace(/<[^>]+>/g,'').slice(0,350)||`${item.title} bei ${company}`;
          jobs.push({id:'ss_'+String(item.id||Math.random().toString(36).slice(2,10)),
            title:item.title,company,location:isRemote?'Remote':city,
            remote:isRemote,local:!isRemote,car:/dienstwagen|firmenwagen/i.test(desc),
            salary:item.salary?String(item.salary):null,posted,
            keywords:extractKw(item.title+' '+desc.slice(0,300)),desc,
            url:jobUrl,source:'StepStone',status:'new',match:0,scrapedAt:new Date().toISOString()});
        }
        if (jobs.length>0) return jobs;
      } catch(e){console.log(`  SS __NEXT_DATA__: ${e.message}`);}
    }

    // Fallback: JSON-LD (single or double quotes in type attr)
    for (const m of res.body.matchAll(/<script type=["']application\/ld\+json["']>([\s\S]*?)<\/script>/g)) {
      try {
        const d=JSON.parse(m[1]);
        for (const item of (Array.isArray(d)?d:[d])) {
          if (item['@type']!=='JobPosting') continue;
          const loc2=item.jobLocation?.address?.addressLocality||loc;
          const desc=(item.description||'').replace(/<[^>]+>/g,'');
          const isRemote=item.jobLocationType==='TELECOMMUTE'||/remote|homeoffice/i.test(loc2+' '+item.title);
          jobs.push({id:'ss_'+Buffer.from((item.url||'')+Math.random()).toString('base64').slice(0,12),
            title:item.title||kw,company:item.hiringOrganization?.name||'Unbekannt',
            location:isRemote?'Remote':loc2,remote:isRemote,local:!isRemote,
            car:/dienstwagen|firmenwagen/i.test(desc),
            salary:item.baseSalary?.value?.value?item.baseSalary.value.value+' €':null,
            posted:item.datePosted||new Date().toISOString().split('T')[0],
            keywords:extractKw(item.title+' '+desc.slice(0,300)),desc:desc.slice(0,350),
            url:item.url||'',source:'StepStone',status:'new',match:0,scrapedAt:new Date().toISOString()});
          if (jobs.length>=12) break;
        }
      } catch(e){}
    }
  } catch(e){console.log(`  SS(${kw}):${e.message}`);}
  return jobs;
}

async function scrapeLinkedIn(kw, sc) {
  const jobs=[];
  try {
    const loc=sc.location||'Deutschland';
    const res=await fetchUrl(`https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${encodeURIComponent(kw)}&location=${encodeURIComponent(loc)}&start=0&f_TPR=r604800`,{
      headers:{'Accept':'text/html,application/xhtml+xml,*/*'}
    });
    if (res.status!==200){console.log(`  LinkedIn(${kw}): HTTP ${res.status}`);return jobs;}
    const ids=[...res.body.matchAll(/data-entity-urn="urn:li:jobPosting:(\d+)"/g)].map(m=>m[1]);
    const titles=[...res.body.matchAll(/<h3[^>]*class="[^"]*base-search-card__title[^"]*"[^>]*>([\s\S]*?)<\/h3>/g)].map(m=>m[1].replace(/<[^>]+>/g,'').trim());
    const comps=[...res.body.matchAll(/<h4[^>]*class="[^"]*base-search-card__subtitle[^"]*"[^>]*>([\s\S]*?)<\/h4>/g)].map(m=>m[1].replace(/<[^>]+>/g,'').trim());
    const locs=[...res.body.matchAll(/<span[^>]*class="[^"]*job-search-card__location[^"]*"[^>]*>([\s\S]*?)<\/span>/g)].map(m=>m[1].replace(/<[^>]+>/g,'').trim());
    for (let i=0;i<Math.min(ids.length,15);i++) {
      const title=titles[i]||kw; const company=comps[i]||'Unbekannt'; const location=locs[i]||loc;
      const isRemote=/remote|homeoffice/i.test(title+' '+location);
      jobs.push({id:'li_'+ids[i],title,company,location:isRemote?'Remote':location,
        remote:isRemote,local:!isRemote,car:false,salary:null,posted:'Kürzlich',
        keywords:extractKw(title+' '+company),desc:`${title} bei ${company} (${location})`,
        url:`https://www.linkedin.com/jobs/view/${ids[i]}`,
        source:'LinkedIn',status:'new',match:0,scrapedAt:new Date().toISOString()});
    }
  } catch(e){console.log(`  LinkedIn(${kw}):${e.message}`);}
  return jobs;
}

async function scrapeXing(kw, sc) {
  const jobs=[];
  try {
    const loc=sc.location||'Deutschland';
    const radius=sc.radius_km||10;
    const res=await fetchUrl(
      `https://www.xing.com/jobs/search?keywords=${encodeURIComponent(kw)}&location=${encodeURIComponent(loc)}&radius=${radius}&country=de`,
      {timeout:20000,headers:{'Accept-Language':'de-DE,de;q=0.9','Accept-Encoding':'identity'}}
    );
    if (res.status!==200){console.log(`  Xing(${kw}): HTTP ${res.status}`);return jobs;}
    // JSON-LD
    for (const m of res.body.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
      try {
        const d=JSON.parse(m[1]);
        for (const item of (Array.isArray(d)?d:[d])) {
          if (item['@type']!=='JobPosting') continue;
          const loc2=item.jobLocation?.address?.addressLocality||loc;
          const desc=(item.description||'').replace(/<[^>]+>/g,'');
          const isRemote=item.jobLocationType==='TELECOMMUTE'||/remote|homeoffice/i.test(loc2+' '+item.title);
          jobs.push({id:'xi_'+Buffer.from((item.url||'')+Math.random()).toString('base64').slice(0,12),
            title:item.title||kw,company:item.hiringOrganization?.name||'Unbekannt',
            location:isRemote?'Remote':loc2,remote:isRemote,local:!isRemote,car:false,
            salary:null,posted:item.datePosted||new Date().toISOString().split('T')[0],
            keywords:extractKw(item.title+' '+desc.slice(0,300)),desc:desc.slice(0,350),
            url:item.url||'https://www.xing.com/jobs',source:'Xing',status:'new',match:0,scrapedAt:new Date().toISOString()});
          if(jobs.length>=10) break;
        }
      } catch(e){}
    }
    if (jobs.length>0) return jobs;
    // Fallback: Apollo GraphQL state (React hydration cache)
    const am=res.body.match(/window\.__APOLLO_STATE__\s*=\s*(\{[\s\S]*?\});\s*(?:<\/script>|window\.)/)
            ||res.body.match(/"jobPostings":\{"jobs":\[([\s\S]*?)\]\}/);
    if (am) {
      try {
        const ap=JSON.parse(am[1]);
        for (const [k,v] of Object.entries(ap)) {
          if ((!k.startsWith('Job:')&&!k.startsWith('XingJob:'))||!v?.title) continue;
          const company=ap[v.company?.__ref]?.name||'Unbekannt';
          const city=ap[v.location?.__ref]?.city||v.city||loc;
          const isRemote=/remote|homeoffice/i.test((v.title||'')+' '+city);
          const slug=v.slug||v.id;
          jobs.push({id:'xi_'+String(v.id||k.replace(/\D/g,'')||Math.random().toString(36).slice(2,10)),
            title:v.title,company,location:isRemote?'Remote':city,
            remote:isRemote,local:!isRemote,car:false,salary:null,
            posted:(v.publishedAt||v.createdAt||'').split('T')[0]||new Date().toISOString().split('T')[0],
            keywords:extractKw(v.title||''),
            desc:(v.description||v.title||'').replace(/<[^>]+>/g,'').slice(0,350),
            url:slug?`https://www.xing.com/jobs/${slug}`:'https://www.xing.com/jobs',
            source:'Xing',status:'new',match:0,scrapedAt:new Date().toISOString()});
          if(jobs.length>=10) break;
        }
      } catch(e){}
    }
  } catch(e){console.log(`  Xing(${kw}):${e.message}`);}
  return jobs;
}

async function scrapeHeise(kw, sc) {
  const jobs=[];
  try {
    const loc=sc.location||'';
    const radius=Math.max(sc.radius_km||10,30);
    // Try primary search URL, fallback to alternate param name
    const urls=[
      `https://jobs.heise.de/search?${new URLSearchParams({q:kw,...(loc?{location:loc,radius:String(radius)}:{})}).toString()}`,
      `https://jobs.heise.de/?${new URLSearchParams({search:kw,...(loc?{location:loc}:{})}).toString()}`
    ];
    let res=null;
    for (const u of urls) {
      try{ res=await fetchUrl(u,{timeout:15000,headers:{'Accept-Language':'de-DE,de;q=0.9'}}); }
      catch(e){ continue; }
      if(res.status===200) break;
      console.log(`  Heise(${kw}): HTTP ${res.status}`);
      res=null;
    }
    if (!res) return jobs;
    // JSON-LD (single or double quotes in type attr)
    for (const m of res.body.matchAll(/<script type=["']application\/ld\+json["']>([\s\S]*?)<\/script>/g)) {
      try {
        const d=JSON.parse(m[1]);
        for (const item of (Array.isArray(d)?d:[d])) {
          if (item['@type']!=='JobPosting') continue;
          const loc2=item.jobLocation?.address?.addressLocality||item.jobLocation?.address?.addressRegion||loc||'Deutschland';
          const desc=(item.description||'').replace(/<[^>]+>/g,'');
          const isRemote=item.jobLocationType==='TELECOMMUTE'||/remote|homeoffice/i.test(loc2+' '+item.title);
          jobs.push({id:'hi_'+Buffer.from((item.url||'')+(item.datePosted||'')).toString('base64').slice(0,12),
            title:item.title||kw,company:item.hiringOrganization?.name||'Unbekannt',
            location:isRemote?'Remote':loc2,remote:isRemote,local:!isRemote,car:false,
            salary:null,posted:item.datePosted||new Date().toISOString().split('T')[0],
            keywords:extractKw(item.title+' '+desc.slice(0,300)),desc:desc.slice(0,350),
            url:item.url||'https://jobs.heise.de',source:'Heise Jobs',status:'new',match:0,
            scrapedAt:new Date().toISOString()});
          if(jobs.length>=10) break;
        }
      } catch(e){}
      if(jobs.length>=10) break;
    }
    if (jobs.length>0) return jobs;
    // Fallback: look for embedded state JSON (Angular SSR, Nuxt, Next)
    for (const pat of [
      /window\.__appInitialState__\s*=\s*(\{[\s\S]*?\});\s*(?:<|window)/,
      /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});\s*(?:<|window)/,
      /<script id="ng-state"[^>]*>([\s\S]*?)<\/script>/,
      /window\.__nuxt__\s*=\s*(\{[\s\S]*?\});\s*(?:<|window)/
    ]) {
      const sm=res.body.match(pat);
      if (!sm) continue;
      try {
        const d=JSON.parse(sm[1]);
        const pred=item=>!!(item&&item.title&&typeof item.title==='string'&&item.title.length>3&&item.company);
        const arr=deepFindArr(d,pred)||[];
        for (const item of arr.slice(0,10)) {
          const loc2=item.location||item.city||loc||'Deutschland';
          const isRemote=/remote|homeoffice/i.test((item.title||'')+' '+loc2);
          jobs.push({id:'hi_'+Math.random().toString(36).slice(2,12),
            title:item.title,
            company:typeof item.company==='object'?item.company?.name||'Unbekannt':item.company||'Unbekannt',
            location:isRemote?'Remote':loc2,remote:isRemote,local:!isRemote,car:false,salary:null,
            posted:(item.publishedAt||item.datePosted||'').split('T')[0]||new Date().toISOString().split('T')[0],
            keywords:extractKw(item.title),
            desc:(item.description||item.title||'').replace(/<[^>]+>/g,'').slice(0,350),
            url:item.url||item.link||'https://jobs.heise.de',
            source:'Heise Jobs',status:'new',match:0,scrapedAt:new Date().toISOString()});
        }
        if (jobs.length>0) break;
      } catch(e){}
    }
  } catch(e){console.log(`  Heise(${kw}):${e.message}`);}
  return jobs;
}

async function scrapeGoogle(kw, sc) {
  const jobs=[];
  try {
    const city=sc.location||'Schweinfurt';
    const query=`${kw} ${city}`;
    const res=await fetchUrl(
      `https://www.google.de/search?q=${encodeURIComponent(query)}&hl=de&gl=de&num=15`,
      {timeout:18000,headers:{
        'Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language':'de-DE,de;q=0.9',
        'Referer':'https://www.google.de/',
        'sec-fetch-dest':'document','sec-fetch-mode':'navigate',
      }}
    );
    if (res.status!==200){console.log(`  Google(${kw}): HTTP ${res.status}`);return jobs;}
    // Strategy 1: JSON-LD job postings (clean structured data)
    for (const m of res.body.matchAll(/<script type=["']application\/ld\+json["']>([\s\S]*?)<\/script>/g)) {
      try {
        const d=JSON.parse(m[1]);
        for (const item of (Array.isArray(d)?d:[d])) {
          if (item['@type']!=='JobPosting') continue;
          const loc2=item.jobLocation?.address?.addressLocality||city;
          const desc=(item.description||'').replace(/<[^>]+>/g,'');
          const isRemote=item.jobLocationType==='TELECOMMUTE'||/remote|homeoffice/i.test(loc2+' '+item.title);
          jobs.push({id:'go_'+Buffer.from((item.url||'')+(item.datePosted||'')).toString('base64').slice(0,12),
            title:item.title||kw,company:item.hiringOrganization?.name||'Unbekannt',
            location:isRemote?'Remote':loc2,remote:isRemote,local:!isRemote,car:false,salary:null,
            posted:item.datePosted||new Date().toISOString().split('T')[0],
            keywords:extractKw(item.title+' '+desc.slice(0,200)),desc:desc.slice(0,350)||`${item.title} (via Google)`,
            url:item.url||`https://www.google.de/search?q=${encodeURIComponent(item.title+' '+city)}`,
            source:'Google',status:'new',match:0,scrapedAt:new Date().toISOString()});
          if(jobs.length>=10) break;
        }
      } catch(e){}
    }
    if (jobs.length>0) return jobs;
    // Strategy 2: Extract <a href> + <h3> pairs from organic results
    const seen=new Set();
    for (const [,href,rawTitle] of res.body.matchAll(/<a[^>]+href="(https?:\/\/[^"&]{15,})"[^>]*>[\s\S]{0,300}?<h3[^>]*>([\s\S]*?)<\/h3>/g)) {
      const title=rawTitle.replace(/<[^>]+>/g,'').trim();
      if (!title||title.length<8) continue;
      if (/google\.(de|com)|youtube\.com|wikipedia|translate\./i.test(href)) continue;
      if (!/entwickl|developer|dev|software|web|frontend|backend|fullstack|sap|ux|informatik|ingenieur|engineer|devops|admin|it[\s\-]/i.test(title)) continue;
      if (seen.has(href)) continue; seen.add(href);
      jobs.push({id:'go_'+Buffer.from(href.slice(0,50)).toString('base64').slice(0,12),
        title,company:'Unbekannt',location:city,remote:false,local:true,car:false,salary:null,
        posted:new Date().toISOString().split('T')[0],keywords:extractKw(title),
        desc:`${title} in ${city} (via Google)`,url:href,
        source:'Google',status:'new',match:0,scrapedAt:new Date().toISOString()});
      if(jobs.length>=10) break;
    }
  } catch(e){console.log(`  Google(${kw}):${e.message}`);}
  return jobs;
}

// ── BROWSER AUTOMATION ───────────────────────────────────────────────────
let _puppeteer = null;
function getPuppeteer() {
  if (!_puppeteer) {
    try { _puppeteer = require('puppeteer'); }
    catch(e) { throw new Error('Puppeteer nicht installiert. Bitte einmalig ausführen: npm install (ca. 300MB)'); }
  }
  return _puppeteer;
}

const autoSessions = new Map();

function escHtml(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function generateLetterPDF(letter, profile, job) {
  const pp = getPuppeteer();
  const pdfPath = path.join(UPLOADS_DIR, `_anschreiben_${Date.now()}.pdf`);
  const html = `<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}body{font-family:Arial,Helvetica,sans-serif;font-size:11pt;line-height:1.65;margin:0;padding:0;color:#1a1a1a}
    .page{padding:2.5cm 2.5cm 2cm 2.5cm}.addr{margin-bottom:2em}.name{font-weight:700;font-size:12pt}
    .date{text-align:right;color:#555;margin-bottom:1.8em;font-size:10pt}
    .subject{font-weight:700;margin-bottom:1.5em;font-size:11.5pt}
    p{margin:0 0 0.9em 0;text-align:justify}
  </style></head><body><div class="page">
    <div class="addr">
      <div class="name">${escHtml(profile.name||'')}</div>
      <div>${escHtml(profile.location||'')}</div>
      <div>${escHtml(profile.phone||'')}</div>
      <div>${escHtml(profile.email||'')}</div>
    </div>
    <div class="date">${new Date().toLocaleDateString('de-DE',{day:'2-digit',month:'long',year:'numeric'})}</div>
    <div class="subject">Bewerbung: ${escHtml(job.title||'')} bei ${escHtml(job.company||'')}</div>
    ${letter.split('\n').filter(l=>l.trim()).map(l=>`<p>${escHtml(l)}</p>`).join('\n')}
  </div></body></html>`;
  let b2 = null;
  try {
    b2 = await pp.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox'] });
    const p2 = await b2.newPage();
    await p2.setContent(html, { waitUntil: 'networkidle0', timeout: 15000 });
    await p2.pdf({ path: pdfPath, format: 'A4', printBackground: false,
      margin: { top:'2.5cm', bottom:'2cm', left:'2.5cm', right:'2.5cm' } });
    return pdfPath;
  } finally { if (b2) await b2.close().catch(()=>{}); }
}

async function autoFillForm(page, profile, letter, cvPath, letterPdfPath) {
  const steps = [];
  try {
    await new Promise(r => setTimeout(r, 2500));
    const inputs = await page.$$('input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=image]):not([type=reset]):not([type=checkbox]):not([type=radio]),textarea,select');
    let filled = 0;
    for (const el of inputs) {
      try {
        const info = await el.evaluate(domEl => {
          let label = '';
          if (domEl.labels?.[0]) label = domEl.labels[0].textContent.trim();
          if (!label && domEl.id) { const lb = document.querySelector(`label[for="${domEl.id}"]`); if (lb) label = lb.textContent.trim(); }
          if (!label) {
            let p = domEl.parentElement;
            for (let i=0; i<5&&p; i++,p=p.parentElement) {
              const lb = p.querySelector('label,legend,[class*="label"],[class*="Label"],[class*="title"],[class*="Title"]');
              if (lb && lb!==domEl && !lb.contains(domEl)) { label = lb.textContent.trim(); break; }
            }
          }
          const rect = domEl.getBoundingClientRect();
          return {
            tag: domEl.tagName.toLowerCase(),
            type: (domEl.type||'text').toLowerCase(),
            name: (domEl.name||'').toLowerCase(),
            id: (domEl.id||'').toLowerCase(),
            placeholder: (domEl.placeholder||'').toLowerCase(),
            label: label.toLowerCase().slice(0,80),
            ariaLabel: (domEl.getAttribute('aria-label')||'').toLowerCase(),
            dtId: (domEl.getAttribute('data-testid')||'').toLowerCase(),
            autocomplete: (domEl.getAttribute('autocomplete')||'').toLowerCase(),
            visible: rect.width>0 && rect.height>0,
            disabled: domEl.disabled || domEl.readOnly,
          };
        });
        if (!info.visible || info.disabled) continue;
        const h = [info.label,info.name,info.id,info.placeholder,info.ariaLabel,info.dtId,info.autocomplete].join(' ');

        // --- file inputs ---
        if (info.type === 'file') {
          const uploadPath = /anschreiben|cover|motivat|letter/i.test(h) ? (letterPdfPath||cvPath) : (cvPath||letterPdfPath);
          if (uploadPath) {
            try {
              await el.uploadFile(uploadPath);
              steps.push(`📎 Datei hochgeladen: ${path.basename(uploadPath)}`); filled++;
            } catch(ue) {
              try {
                const [fc] = await Promise.all([page.waitForFileChooser({timeout:3000}), el.click()]);
                await fc.accept([uploadPath]);
                steps.push(`📎 Datei via Chooser: ${path.basename(uploadPath)}`); filled++;
              } catch(ue2) { steps.push(`⚠️ Datei-Upload übersprungen`); }
            }
          }
          continue;
        }

        // --- text / textarea / select ---
        let value = null, fieldName = '';
        const ac = info.autocomplete;
        if      (ac==='email'        || /\be[\s.\-]?mail\b/i.test(h))                                          { value=profile.email;   fieldName='E-Mail'; }
        else if (ac==='tel'          || /phone|telefon|mobil|handy|tel[\s_\-]?nr|rufnr|mobilnr/i.test(h))      { value=profile.phone;   fieldName='Telefon'; }
        else if (ac==='given-name'   || /vorname|first[\s_]?name|fname|given[\s_]?name/i.test(h))              { value=(profile.name||'').trim().split(/\s+/)[0]; fieldName='Vorname'; }
        else if (ac==='family-name'  || /nachname|last[\s_]?name|lname|surname|familienname/i.test(h))         { const p=(profile.name||'').trim().split(/\s+/); value=p.length>1?p.slice(1).join(' '):p[0]; fieldName='Nachname'; }
        else if (ac==='name'         || (/\bname\b/i.test(h) && !/company|firma|unternehmen|employer|arbeitgeber/i.test(h) && info.tag!=='textarea')) { value=profile.name; fieldName='Name'; }
        else if (/stad?t|city|\bort\b|wohnort/i.test(h))                                                       { value=profile.location; fieldName='Ort'; }
        else if (/linkedin/i.test(h))                                                                          { value=profile.linkedin||''; fieldName='LinkedIn'; }
        else if (info.tag==='textarea' && /anschreiben|cover[\s_]?letter|motivat|why.*apply|warum.*bew|freitext|nachricht|message|motivation/i.test(h)) { value=letter; fieldName='Anschreiben'; }

        if (value && value.trim()) {
          if (info.tag === 'select') {
            await el.evaluate((domEl, val) => {
              const lo = val.toLowerCase();
              for (const opt of domEl.options) {
                if (opt.value.toLowerCase()===lo || opt.textContent.toLowerCase().includes(lo)) {
                  domEl.value = opt.value;
                  domEl.dispatchEvent(new Event('change',{bubbles:true}));
                  return;
                }
              }
            }, value);
          } else if (info.tag === 'textarea') {
            await el.click({clickCount:3});
            await el.evaluate(domEl => { domEl.value=''; });
            await el.type(value, {delay:3});
            await el.evaluate(domEl => {
              domEl.dispatchEvent(new Event('input',{bubbles:true}));
              domEl.dispatchEvent(new Event('change',{bubbles:true}));
            });
          } else {
            await el.click({clickCount:3});
            await el.type(value, {delay:8});
            await el.evaluate(domEl => {
              domEl.dispatchEvent(new Event('input',{bubbles:true}));
              domEl.dispatchEvent(new Event('change',{bubbles:true}));
            });
          }
          steps.push(`✓ ${fieldName} eingetragen`);
          filled++;
        }
      } catch(fe) { /* skip broken field */ }
    }
    steps.push(`📝 ${filled} Felder ausgefüllt`);
  } catch(e) { steps.push(`⚠️ Formular-Fehler: ${e.message}`); }
  return steps;
}

// ── VISION AI AGENT ──────────────────────────────────────────────────────
async function askVisionAI(screenshotBase64, context) {
  if (!CONFIG.ANTHROPIC_API_KEY || CONFIG.AI_MODE === 'ollama' || !screenshotBase64) {
    return { action: 'fill_form', target: '', value: '', reason: 'Kein API-Key – direkt ausfüllen' };
  }
  const { job, profile, history, cvPath, letterPdfPath } = context;
  const prompt = `Du steuerst einen Browser um eine Stellenbewerbung auszufüllen.
PROFIL: Name="${profile.name||''}" Email="${profile.email||''}" Tel="${profile.phone||''}" Ort="${profile.location||''}"
JOB: "${job.title||''}" bei "${job.company||''}"
DATEIEN: CV="${cvPath ? path.basename(cvPath) : 'fehlt'}" Anschreiben="${letterPdfPath ? path.basename(letterPdfPath) : 'fehlt'}"
BISHERIGE SCHRITTE: ${history.slice(-5).join(' → ')||'Start'}

Analysiere den Screenshot. Was ist die EINE beste nächste Aktion?
Antworte NUR mit gültigem JSON ohne weitere Erklärung:
{"action":"...","target":"...","value":"...","reason":"..."}

Mögliche action-Werte (NUR einen wählen):
fill_form     → alle sichtbaren Textfelder mit Profildaten ausfüllen
click         → Element anklicken (target = sichtbarer Button-/Link-Text)
type          → Text eintippen (target = Feldbeschreibung, value = einzutippender Text)
upload_cv     → Lebenslauf-PDF hochladen
upload_letter → Anschreiben-PDF hochladen  
scroll_down   → nach unten scrollen (mehr Felder sehen)
next          → Weiter/Next/Continue-Button klicken
submit        → STOP: finale Absendeseite erreicht, Nutzer muss bestätigen
wait          → kurz warten (Seite lädt noch)
need_manual   → manuelle Hilfe nötig (Login, CAPTCHA, Registrierung, Auswahl die ich nicht kenne)
done          → Erfolgsmeldung sichtbar, Bewerbung wurde abgesendet

Regeln: Login-Seite? → need_manual. CAPTCHA? → need_manual. "Danke/Thank you/Erfolgreich"? → done. Review-Seite mit Absenden-Button? → submit. Sichtbarer Button mit Text "Bewerben/Apply/Einfach bewerben/Easy Apply" aber noch kein Formular? → click (target=Buttontext). Leere Formularfelder sichtbar? → fill_form.`;

  try {
    const res = await fetchUrl('https://api.anthropic.com/v1/messages', {
      method: 'POST', timeout: 35000,
      headers: { 'Content-Type': 'application/json', 'x-api-key': CONFIG.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-opus-4-5', max_tokens: 300,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: screenshotBase64 } },
          { type: 'text', text: prompt },
        ]}],
      }),
    });
    const d = JSON.parse(res.body);
    if (d.error) { console.log('[VisionAI]', d.error.message); return { action: 'fill_form', target: '', value: '', reason: 'KI-Fehler: ' + d.error.type }; }
    const text = (d.content||[]).map(b => b.text||'').join('');
    const m = text.match(/\{[\s\S]*?\}/);
    if (m) {
      const parsed = JSON.parse(m[0]);
      if (parsed.action) return parsed;
    }
    console.log('[VisionAI] Ungültige Antwort:', text.slice(0,200));
  } catch(e) { console.log('[VisionAI]', e.message); }
  return { action: 'fill_form', target: '', value: '', reason: 'KI nicht verfügbar – direkt ausfüllen' };
}

async function executeAIAction(page, decision, profile, letter, cvPath, letterPdfPath) {
  const a = decision.action;

  if (a === 'fill_form') {
    return await autoFillForm(page, profile, letter, cvPath, letterPdfPath);
  }

  if (a === 'click') {
    const clicked = await page.evaluate(target => {
      // Try CSS selector first
      try { const el = document.querySelector(target); if (el && el.getBoundingClientRect().width > 0) { el.scrollIntoView({behavior:'instant',block:'center'}); el.click(); return true; } } catch(e) {}
      // Search by visible text
      const lc = (target||'').toLowerCase();
      const all = [...document.querySelectorAll('button,a,[role=button],input[type=submit],label,[tabindex]')];
      const match = all.find(el => { const r = el.getBoundingClientRect(); return r.width > 0 && el.textContent.toLowerCase().trim().includes(lc); });
      if (match) { match.scrollIntoView({behavior:'instant',block:'center'}); match.click(); return true; }
      return false;
    }, decision.target || '').catch(() => false);
    return [`${clicked ? '✅' : '⚠️'} Klick: "${decision.target||''}"`];
  }

  if (a === 'type') {
    const typed = await page.evaluate((target, value) => {
      const lc = (target||'').toLowerCase();
      const all = [...document.querySelectorAll('input:not([type=hidden]):not([type=file]),textarea')];
      const match = all.find(el => {
        if (el.getBoundingClientRect().width === 0 || el.disabled || el.readOnly) return false;
        const h = [el.getAttribute('aria-label'),el.placeholder,el.name,el.id,el.getAttribute('data-testid')].filter(Boolean).join(' ').toLowerCase();
        return h.includes(lc);
      });
      if (match) {
        match.focus(); match.select?.(); match.value = value;
        match.dispatchEvent(new Event('input',{bubbles:true}));
        match.dispatchEvent(new Event('change',{bubbles:true}));
        return true;
      }
      return false;
    }, decision.target||'', decision.value||'').catch(() => false);
    if (!typed && decision.value) await page.keyboard.type(String(decision.value), { delay: 5 }).catch(() => {});
    return [`${typed?'✅':'⌨️'} "${decision.target||''}": "${String(decision.value||'').slice(0,50)}"`];
  }

  if (a === 'upload_cv' || a === 'upload_letter') {
    const filePath = a === 'upload_letter' ? (letterPdfPath||cvPath) : (cvPath||letterPdfPath);
    if (!filePath) return ['⚠️ Keine Datei für Upload verfügbar'];
    const inputs = await page.$$('input[type=file]');
    for (const inp of inputs) {
      try { await inp.uploadFile(filePath); return [`📎 Hochgeladen: ${path.basename(filePath)}`]; } catch(e) {}
    }
    return ['⚠️ Kein Datei-Input gefunden'];
  }

  if (a === 'scroll_down') {
    await page.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 0.75)));
    await new Promise(r => setTimeout(r, 500));
    return ['⬇️ Gescrollt'];
  }

  if (a === 'next') {
    const clicked = await page.evaluate(() => {
      const vis = [...document.querySelectorAll('button,[role=button],input[type=submit]')].filter(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !b.disabled; });
      const btn = vis.find(b => /next|weiter|continue|fortfahren|nächste/i.test((b.textContent||'')+(b.getAttribute('aria-label')||'')+(b.value||'')));
      if (btn) { btn.scrollIntoView({behavior:'instant',block:'center'}); btn.click(); return btn.textContent.trim().slice(0,50)||'Weiter'; }
      return null;
    }).catch(() => null);
    return [clicked ? `➡️ ${clicked}` : '⚠️ Kein Weiter-Button gefunden'];
  }

  if (a === 'wait') {
    await new Promise(r => setTimeout(r, 3000));
    return ['⏳ Gewartet...'];
  }

  return [];
}

async function autoBrowserApply(jobId) {
  const sessionId = 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2,6);
  const job = getJob(jobId);
  if (!job) throw new Error('Job nicht gefunden');
  const profile = loadProfile();
  const session = {
    jobId, status:'starting',
    steps:['🚀 KI-Browser-Bewerbung gestartet...'],
    screenshot:null, url:job.url,
    title:job.title, company:job.company,
    browser:null, page:null, submitSelector:null, letter:'',
  };
  autoSessions.set(sessionId, session);

  (async () => {
    try {
      const pp = getPuppeteer();

      // 1. KI-Anschreiben
      session.steps.push('✍️ Erstelle KI-Anschreiben...');
      const lang = detectLanguage((job.title||'') + ' ' + (job.desc||''));
      const letter = await generateCoverLetter(job, profile, lang);
      session.letter = letter;
      session.steps.push('✅ Anschreiben (' + (lang==='en'?'Englisch':'Deutsch') + ')');

      // 2. Anschreiben PDF
      let letterPdfPath = null;
      try {
        session.steps.push('📄 Anschreiben-PDF...');
        letterPdfPath = await generateLetterPDF(letter, profile, job);
        session.steps.push('✅ Anschreiben.pdf erstellt');
      } catch(pe) { session.steps.push('⚠️ PDF: ' + pe.message); }

      // 3. Lebenslauf finden
      const uploads = listUploads().filter(f => !f.name.startsWith('_anschreiben_'));
      const cvFile = uploads.find(f => /lebenslauf|cv|resume/i.test(f.name)) || uploads.find(f => /\.pdf$/i.test(f.name)) || uploads[0];
      const cvPath = cvFile ? path.join(UPLOADS_DIR, cvFile.name) : null;
      session.steps.push(cvPath ? `📎 Lebenslauf: ${cvFile.name}` : '⚠️ Kein Lebenslauf – bitte hochladen');

      // 4. Browser starten
      session.status = 'launching';
      session.steps.push('🌐 Öffne Browser...');
      const browserProfileDir = path.join(__dirname, 'browser-profile');
      if (!fs.existsSync(browserProfileDir)) fs.mkdirSync(browserProfileDir, { recursive: true });
      const browser = await pp.launch({
        headless: false, defaultViewport: null,
        userDataDir: browserProfileDir,
        args: ['--start-maximized','--no-sandbox','--disable-blink-features=AutomationControlled'],
        ignoreDefaultArgs: ['--enable-automation'],
      });
      session.browser = browser;
      const pages = await browser.pages();
      const page = pages[0] || await browser.newPage();
      session.page = page;

      await page.evaluateOnNewDocument(() => {
        try { delete navigator.__proto__.webdriver; } catch(e) {}
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });

      // 5. Zur Stellenanzeige navigieren
      session.status = 'navigating';
      session.steps.push('🔗 Öffne Stellenanzeige...');
      try { await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 30000 }); }
      catch(ne) { if (!ne.message.includes('net::ERR_ABORTED')) throw ne; }
      await new Promise(r => setTimeout(r, 2500));

      // 6. Bewerben-Button klicken (explizit, vor KI-Loop)
      session.steps.push('🔍 Suche Bewerben-Button...');
      const applyClicked = await page.evaluate(() => {
        const lc = s => (s||'').toLowerCase().replace(/\s+/g,' ').trim();
        const all = [
          ...document.querySelectorAll('button,a,[role=button],[data-testid*="apply"],[class*="apply-btn"],[class*="applyBtn"]'),
          ...document.querySelectorAll('[aria-label*="apply" i],[aria-label*="bewerben" i]'),
        ];
        const seen = new Set();
        const candidates = all.filter(el => {
          if (seen.has(el)) return false; seen.add(el);
          const t = lc(el.textContent); const rl = lc(el.getAttribute('aria-label')||'');
          const cl = lc(el.className||''); const id = lc(el.id||'');
          const rc = el.getBoundingClientRect();
          if (rc.width===0 || rc.height===0) return false;
          return /\b(bewerben|apply|jetzt bewerben|apply now|bewerbung starten|einfach bewerben|easy apply)\b/.test(t)
              || /\bapply\b|\bbewerb/.test(rl)
              || /apply/.test(cl) || /apply/.test(id);
        }).sort((a,b) => {
          const s = el => (el.tagName==='BUTTON'?10:0) + (el.getBoundingClientRect().top < window.innerHeight*1.5 ? 5 : 0);
          return s(b) - s(a);
        });
        for (const el of candidates.slice(0,5)) {
          try { el.scrollIntoView({behavior:'instant',block:'center'}); el.click(); return el.textContent.trim().replace(/\s+/g,' ').slice(0,60); } catch(e) {}
        }
        return null;
      }).catch(() => null);

      if (applyClicked) {
        session.steps.push(`✅ Geklickt: "${applyClicked}"`);
        await new Promise(r => setTimeout(r, 3000));
        session.screenshot = await page.screenshot({ encoding:'base64', type:'jpeg', quality:65 }).catch(()=>null);
        session.url = page.url();
      } else {
        session.steps.push('⚠️ Kein Bewerben-Button – KI sucht weiter...');
      }

      // 7. KI AGENT LOOP
      session.status = 'filling';
      const actionHistory = [];
      const MAX_ITER = 30;

      // Helper: immer den neuesten/aktivsten Tab verwenden
      async function getActivePage() {
        try {
          const allPages = await browser.pages();
          if (allPages.length === 0) return page;
          // Bevorzuge den neuesten Tab (letzter in der Liste) wenn er nicht leer ist
          for (let i = allPages.length - 1; i >= 0; i--) {
            const p = allPages[i];
            try {
              const u = p.url();
              if (u && u !== 'about:blank' && u !== 'chrome://newtab/') {
                await p.bringToFront().catch(() => {});
                return p;
              }
            } catch(e) {}
          }
          return page;
        } catch(e) { return page; }
      }

      let activePage = page;

      // Neuen Tab erkennen und automatisch wechseln
      browser.on('targetcreated', async target => {
        try {
          if (target.type() === 'page') {
            const newPage = await target.page();
            if (!newPage) return;
            await new Promise(r => setTimeout(r, 1500));
            const u = newPage.url();
            if (u && u !== 'about:blank') {
              activePage = newPage;
              await newPage.bringToFront().catch(() => {});
              session.steps.push(`🔀 Neuer Tab erkannt: ${new URL(u).hostname}`);
            }
          }
        } catch(e) {}
      });

      for (let iter = 0; iter < MAX_ITER; iter++) {
        // Warte auf Seitenstabilisierung
        await new Promise(r => setTimeout(r, 1500));

        // Immer den neuesten aktiven Tab verwenden
        const currentPage = await getActivePage();
        if (currentPage !== activePage) {
          activePage = currentPage;
          session.steps.push(`🔀 Wechsel zu: ${new URL(currentPage.url()).hostname}`);
        }
        session.page = activePage;

        // Screenshot machen
        const sc = await activePage.screenshot({ encoding:'base64', type:'jpeg', quality:72 }).catch(() => null);
        if (sc) session.screenshot = sc;
        session.url = activePage.url();

        // Claude fragt: was jetzt?
        const decision = await askVisionAI(sc, { job, profile, history: actionHistory, cvPath, letterPdfPath });
        const label = decision.reason || decision.action;
        session.steps.push(`🤖 [${iter+1}] ${label}`);
        actionHistory.push(decision.action);

        // ── Terminal States ─────────────────────────────────────────────
        if (decision.action === 'submit') {
          // Submit-Button ID merken für späteren Klick
          session.submitSelector = await activePage.evaluate(() => {
            const vis = [...document.querySelectorAll('button,[role=button],input[type=submit]')].filter(b => { const r = b.getBoundingClientRect(); return r.width>0&&r.height>0&&!b.disabled; });
            const btn = vis.find(b => /submit|absenden|send|apply|senden|bewerben/i.test((b.textContent||'')+(b.value||'')+(b.getAttribute('aria-label')||'')));
            if (btn) { if (!btn.id) btn.id = '__jh_submit_' + Date.now(); return '#' + btn.id; }
            return null;
          }).catch(() => null);
          session.status = 'ready';
          session.steps.push('');
          session.steps.push('✅ Formular ausgefüllt – bitte prüfen!');
          session.steps.push('👉 Im Browser alles kontrollieren');
          session.steps.push('👉 Dann hier "Jetzt absenden" klicken');
          break;
        }

        if (decision.action === 'done') {
          session.status = 'submitted';
          session.steps.push('🎉 Bewerbung erfolgreich abgesendet!');
          updateJob(session.jobId, { status:'applied', applied_at: new Date().toISOString() });
          break;
        }

        if (decision.action === 'need_manual') {
          session.status = 'waiting_manual';
          session.steps.push('');
          session.steps.push('🛑 Manuelle Hilfe nötig!');
          session.steps.push('👉 Im Browser erledigen (Login / CAPTCHA / Auswahl)');
          session.steps.push('👉 Dann hier "▶️ Fortsetzen" klicken');
          // Warte bis Nutzer "continue" klickt
          while (session.status === 'waiting_manual') {
            await new Promise(r => setTimeout(r, 600));
            if (!autoSessions.has(sessionId)) return;
          }
          session.steps.push('▶️ Fortgesetzt nach manueller Hilfe');
          continue;
        }

        // ── Aktion ausführen ────────────────────────────────────────────
        const actionSteps = await executeAIAction(activePage, decision, profile, letter, cvPath, letterPdfPath);
        session.steps.push(...actionSteps.filter(Boolean));

        // Schleifenerkennung: 5× gleiche Aktion = feststeckend
        if (actionHistory.length >= 5 && actionHistory.slice(-5).every(a => a === decision.action) && decision.action !== 'wait') {
          session.status = 'waiting_manual';
          session.steps.push('');
          session.steps.push('⚠️ Komme nicht weiter – bitte im Browser helfen');
          session.steps.push('👉 Dann "▶️ Fortsetzen" klicken');
          actionHistory.length = 0; // Reset history
          while (session.status === 'waiting_manual') {
            await new Promise(r => setTimeout(r, 600));
            if (!autoSessions.has(sessionId)) return;
          }
          session.steps.push('▶️ Fortgesetzt...');
        }
      }

      // Wenn MAX_ITER erreicht ohne Abschluss
      if (session.status === 'filling') {
        session.status = 'ready';
        session.steps.push('');
        session.steps.push('⚠️ Maximale Schritte erreicht – bitte manuell prüfen');
        session.steps.push('👉 Dann "Jetzt absenden" klicken');
      }

      browser.on('disconnected', () => {
        if (['ready','waiting_manual','filling'].includes(session.status)) {
          session.steps.push('🔴 Browser geschlossen'); session.status = 'closed';
        }
        setTimeout(() => autoSessions.delete(sessionId), 5000);
      });
      setTimeout(() => {
        if (autoSessions.has(sessionId)) { session.browser?.close().catch(()=>{}); autoSessions.delete(sessionId); }
      }, 45*60*1000);

    } catch(e) {
      session.status = 'error';
      session.steps.push('❌ Fehler: ' + e.message);
      console.error('[AutoApply]', e.message);
    }
  })();
  return { ok: true, sessionId };
}

const TECH_KW=['javascript','typescript','python','java','c#','c++','php','ruby','go','rust','swift','kotlin',
  'react','vue','angular','nextjs','nodejs','express','django','flask','spring','laravel',
  'html','css','sql','nosql','mongodb','postgresql','mysql','redis','docker','kubernetes',
  'aws','azure','git','linux','rest','graphql','agile','scrum','devops','tdd',
  'sap','abap','fiori','ux','figma','embedded','arduino','raspberry','vhdl','selenium','jest'];

function extractKw(text) {
  if (!text) return [];
  const lo=text.toLowerCase();
  const found=TECH_KW.filter(k=>lo.includes(k)).map(k=>k.charAt(0).toUpperCase()+k.slice(1));
  const caps=(text.match(/\b[A-Z][a-zA-Z.+#]{1,15}\b/g)||[])
    .filter(w=>!['Die','Der','Das','Wir','Sie','Für','Und','Mit','Als','Bei','Ihre','Unser','Eine'].includes(w));
  return [...new Set([...found,...caps])].slice(0,8);
}

function scoreJob(job, profile, sc) {
  let score=45;
  const skills=(profile.skills||'').toLowerCase().split(',').map(s=>s.trim()).filter(Boolean);
  const tlo=job.title.toLowerCase(); const dlo=job.desc.toLowerCase();
  const kwlo=(job.keywords||[]).map(k=>k.toLowerCase());
  if (/junior|einsteig|quereinsteig/i.test(tlo+' '+dlo)) score+=18;
  if (/software|entwickl|developer|dev/i.test(tlo)) score+=10;
  if (/frontend|backend|fullstack|web|react|vue/i.test(tlo)) score+=8;
  if (/sap|ux|embedded|hardware/i.test(tlo)) score+=6;
  if (job.remote) score+=12; if (job.car) score+=5;
  const sm=skills.filter(s=>s&&(dlo.includes(s)||tlo.includes(s)||kwlo.some(k=>k.includes(s))));
  score+=Math.min(sm.length*6,20);
  if (/quereinsteiger|berufseinsteiger/i.test(dlo)) score+=8;
  if (/\b(senior|lead|principal|head of|manager)\b/i.test(tlo)) score-=20;
  return Math.min(Math.max(Math.round(score),15),99);
}

// Block non-German locations for local job searches
// English names + German-language translations (LinkedIn uses German)
const NON_GERMAN_RE = /\b(california|texas|new york|new jersey|pennsylvania|ohio|michigan|illinois|virginia|georgia|north carolina|south carolina|florida|chicago|los angeles|san francisco|boston|seattle|denver|atlanta|miami|dallas|houston|austin|san diego|las vegas|phoenix|indianapolis|columbus|charlotte|jacksonville|fort worth|pittsburgh|sacramento|cleveland|raleigh|omaha|tampa|new orleans|portland|nashville|baltimore|minneapolis|virginia beach|san jose|san antonio|irvine|united states|usa|canada|toronto|montreal|vancouver|london|manchester|birmingham|leeds|bristol|united kingdom|england|scotland|wales|ireland|paris|madrid|rome|amsterdam|warsaw|bucharest|budapest|bangalore|mumbai|delhi|beijing|shanghai|tokyo|singapore|sydney|melbourne|brazil|mexico city)\b/i;
function isNonGermanLocation(loc) {
  if (!loc) return false;
  if (NON_GERMAN_RE.test(loc)) return true;
  // German-language country/state names (e.g. from LinkedIn DE localization)
  return /vereinigte\s+staaten|vereinigtes\s+k[oö]nigreich|gro[sß]britannien|nordamerika|nordirland|kalifornien|vereinigte\s+arabische/i.test(loc);
}

function filterJob(job, sc) {
  const text=(job.title+' '+job.desc).toLowerCase();
  if (!/software|entwickl|developer|dev|web|frontend|backend|fullstack|it |informatik|sap|ux|design|embedded|hardware|devops/i.test(text)) return false;
  if (/\b(senior lead|principal staff|head of)\b/i.test(job.title.toLowerCase())) return false;
  // Block non-German locations for non-remote jobs
  if (!job.remote && isNonGermanLocation(job.location)) return false;
  // Respect want_remote / want_local flags
  if (job.remote && sc.want_remote===false) return false;
  if (!job.remote && sc.want_local===false) return false;
  return true;
}

// Remove non-German local jobs that slipped into DB from previous scans
function cleanBadLocalJobs() {
  try {
    const rows = db.prepare('SELECT id, location FROM jobs WHERE remote=0').all();
    const bad = rows.filter(r => isNonGermanLocation(r.location));
    if (bad.length > 0) {
      const ids = bad.map(r => r.id);
      db.prepare(`DELETE FROM jobs WHERE id IN (${ids.map(()=>'?').join(',')})`).run(...ids);
      console.log(`[DB] ${bad.length} nicht-deutsche Lokal-Jobs bereinigt (${[...new Set(bad.map(r=>r.location))].slice(0,3).join(', ')}...)`);
    }
  } catch(e) { console.log('[DB] Cleanup:', e.message); }
}

function dedup(existing, incoming) {
  const ids=new Set(existing.map(j=>j.id));
  const keys=new Set(existing.map(j=>(j.title+j.company).toLowerCase().replace(/\W/g,'')));
  return incoming.filter(j=>{
    if (ids.has(j.id)) return false;
    const k=(j.title+j.company).toLowerCase().replace(/\W/g,'');
    if (keys.has(k)) return false; keys.add(k); return true;
  });
}

async function runScan() {
  const sc=loadSearch(), data=loadJobs(), profile=loadProfile(), allNew=[];
  // Profile is ALWAYS the source of truth for location/radius/preferences
  if (profile.location) sc.location=profile.location;
  if (profile.radius_km)     sc.radius_km=profile.radius_km;
  if (profile.radius_car_km) sc.radius_car_km=profile.radius_car_km;
  sc.want_remote = profile.want_remote;
  sc.want_local  = profile.want_local;
  sc.want_car    = profile.want_car;
  console.log(`  Standort: ${sc.location} · Radius lokal: ${sc.radius_km} km · Dienstwagen: ${sc.radius_car_km} km`);
  const src=sc.sources||{aa:true,indeed:true,stepstone:true,linkedin:false,xing:false,heise:true};
  console.log(`\n${'='.repeat(52)}\n🔍 Scan: ${new Date().toLocaleString('de-DE')} · ${sc.keywords.length} Keywords\n${'='.repeat(52)}`);
  const active=[src.aa!==false&&'AA',src.indeed!==false&&'Indeed',src.stepstone!==false&&'StepStone',src.linkedin&&'LinkedIn',src.xing&&'Xing',src.heise!==false&&'Heise',src.google!==false&&'Google'].filter(Boolean);
  console.log(`  Quellen: ${active.join(', ')}`);
  for (const kw of sc.keywords) {
    console.log(`\n  "${kw}"`);
    if (src.aa!==false){const aa=await scrapeArbeitsagentur(kw,sc);console.log(`    AA: ${aa.length}`);allNew.push(...aa);await sleep(1200);}
    if (src.indeed!==false){const ind=await scrapeIndeed(kw,sc);console.log(`    Indeed: ${ind.length}`);allNew.push(...ind);await sleep(1800);}
    if (src.stepstone!==false){const ss=await scrapeStepstone(kw,sc);console.log(`    SS: ${ss.length}`);allNew.push(...ss);await sleep(1500);}
    if (src.linkedin){const li=await scrapeLinkedIn(kw,sc);console.log(`    LinkedIn: ${li.length}`);allNew.push(...li);await sleep(2000);}
    if (src.xing){const xi=await scrapeXing(kw,sc);console.log(`    Xing: ${xi.length}`);allNew.push(...xi);await sleep(1500);}
    if (src.heise!==false){const hi=await scrapeHeise(kw,sc);console.log(`    Heise: ${hi.length}`);allNew.push(...hi);await sleep(1200);}
    if (src.google!==false){const go=await scrapeGoogle(kw,sc);console.log(`    Google: ${go.length}`);allNew.push(...go);await sleep(2000);}
  }
  const filtered=allNew.filter(j=>filterJob(j,sc));
  const unique=dedup(data.jobs,filtered);
  unique.forEach(j=>{j.match=scoreJob(j,profile,sc);});
  unique.sort((a,b)=>b.match-a.match);
  // Save only new jobs to DB (saveJobs handles 600-cap internally via SQL)
  const newData={ jobs:unique, lastScan:new Date().toISOString(), scanCount:(data.scanCount||0)+1, newThisScan:unique.length };
  saveJobs(newData);
  console.log(`\n✅ ${unique.length} neue Stellen (${allNew.length} gesamt gefunden)`);
  return unique.length;
}

function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

// ── AI BACKEND: ANTHROPIC or OLLAMA ──────────────────────────────────────
async function callAI(messages, maxTokens=1000) {
  if (CONFIG.AI_MODE === 'ollama') {
    return callOllama(messages, maxTokens);
  }
  return callAnthropic(messages, maxTokens);
}

async function callAnthropic(messages, maxTokens=1000) {
  if (!CONFIG.ANTHROPIC_API_KEY) throw new Error('Kein Anthropic API Key gesetzt');
  const cleanMessages = messages.map(m => ({ ...m, content: m.content }));
  const res = await fetchUrl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    timeout: 60000,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': CONFIG.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: 'claude-opus-4-5', max_tokens: maxTokens, messages: cleanMessages }),
  });
  console.log(`[Anthropic] HTTP ${res.status}`);
  let d;
  try { d = JSON.parse(res.body); } catch(e) { throw new Error(`Anthropic Antwort ungültig (HTTP ${res.status})`); }
  if (d.error) {
    const msg = d.error.message || JSON.stringify(d.error);
    console.error('[Anthropic] Fehler:', JSON.stringify(d.error));
    if (res.status === 401) throw new Error('API Key ungültig oder abgelaufen (401)');
    if (res.status === 403) throw new Error('API Key hat keine Berechtigung (403) – neuen Key erstellen');
    throw new Error(`Anthropic: ${msg}`);
  }
  return d.content?.map(b => b.text||'').join('') || '';
}

async function callOllama(messages, maxTokens=1000) {
  // Flatten any multipart messages (PDFs not supported in Ollama – text only)
  const flatMessages = messages.map(m => ({
    role: m.role,
    content: Array.isArray(m.content)
      ? m.content.map(c => c.type === 'text' ? c.text : '[PDF-Dokument – Ollama unterstützt keine PDFs]').join('\n')
      : m.content,
  }));
  // Pre-check: test TCP connection so we get a clear error if Ollama isn't running
  try { await fetchUrl(`${CONFIG.OLLAMA_URL}/api/tags`, { timeout: 4000 }); } catch(e) {
    throw new Error(`Ollama nicht erreichbar (${CONFIG.OLLAMA_URL}). Bitte Ollama starten: ollama serve`);
  }
  const res = await fetchUrl(`${CONFIG.OLLAMA_URL}/api/chat`, {
    method: 'POST',
    timeout: 120000,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: CONFIG.OLLAMA_MODEL,
      messages: flatMessages,
      stream: false,
      options: { num_predict: maxTokens, temperature: 0.75 },
    }),
  });
  const d = JSON.parse(res.body);
  if (d.error) throw new Error('Ollama: ' + d.error);
  return d.message?.content || '';
}

async function checkOllamaStatus() {
  try {
    const res = await fetchUrl(`${CONFIG.OLLAMA_URL}/api/tags`);
    const d = JSON.parse(res.body);
    const models = (d.models||[]).map(m => m.name);
    return { running: true, models };
  } catch(e) {
    return { running: false, models: [] };
  }
}

async function generateCoverLetter(job, profile, lang) {
  if (!lang) lang = detectLanguage((job.title||'')+' '+(job.desc||''));
  let prompt;
  if (lang === 'en') {
    prompt = `Write a professional job application cover letter. IMPORTANT: human, personal, direct tone. No AI clichés like "I am excited to apply" or "I am writing to express my interest". Modern, authentic, concise.

Position: ${job.title} at ${job.company}
Location: ${job.location}
Description: ${job.desc}
Keywords: ${(job.keywords||[]).join(', ')}

Applicant:
Name: ${profile.name||'Applicant'}
Skills: ${profile.skills||'Software Development'}
Experience: ${profile.experience||'Career changer'}
${profile.bio?'About me: '+profile.bio:''}

~270 words. Naturally include keywords: ${(job.keywords||[]).slice(0,3).join(', ')}. Output only the finished cover letter, no headings, no extra commentary.`;
  } else {
    prompt = `Du schreibst ein Bewerbungsanschreiben. WICHTIG: menschlich, persönlich, direkt. Kein KI-Stil, keine Floskeln wie "Mit großem Interesse bewerbe ich mich". Zeitgemäß, authentisch.

Stelle: ${job.title} bei ${job.company}
Ort: ${job.location}
Beschreibung: ${job.desc}
Keywords: ${(job.keywords||[]).join(', ')}

Bewerber:
Name: ${profile.name||'Bewerber'}
Skills: ${profile.skills||'Softwareentwicklung'}
Erfahrung: ${profile.experience||'Quereinsteiger'}
${profile.bio?'Über mich: '+profile.bio:''}

~270 Wörter. Keywords ${(job.keywords||[]).slice(0,3).join(', ')} natürlich einbauen. Nur das fertige Anschreiben, keine Überschriften.`;
  }
  return callAI([{ role: 'user', content: prompt }]);
}

// Detect language from job text (simple word-frequency approach)
function detectLanguage(text) {
  const lo = ' ' + text.toLowerCase() + ' ';
  const en = [' the ',' and ',' with ',' our ',' your ',' for ',' are ',' have ',' will ',' from ',' team ',' work ',' join ',' role ',' company ',' skills ',' experience ',' looking ',' strong ',' based ',' position ',' requirements '].filter(w=>lo.includes(w)).length;
  const de = [' die ',' der ',' das ',' und ',' mit ',' für ',' wir ',' sie ',' bei ',' als ',' eine ',' nicht ',' auch ',' ihre ',' werden ',' haben ',' können ',' suchen ',' bieten ',' uns '].filter(w=>lo.includes(w)).length;
  return en > de ? 'en' : 'de';
}

// Extract first email address found in text
function extractEmailFromText(text) {
  const m = (text||'').match(/\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/);
  return m ? m[0] : null;
}

// Fetch Arbeitsagentur job detail (may contain contact email)
async function fetchAAJobDetail(refnr) {
  try {
    const res = await fetchUrl(`https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/jobdetails/${encodeURIComponent(refnr)}`, {
      headers: { 'X-API-Key': 'jobboerse-jobsuche', 'Accept': 'application/json' },
      timeout: 10000,
    });
    if (res.status !== 200) return null;
    return JSON.parse(res.body);
  } catch(e) { return null; }
}

// Minimal SMTP client using STARTTLS (port 587) – no npm deps
async function sendSMTP({ to, subject, body }) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = CONFIG;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) throw new Error('SMTP nicht konfiguriert – bitte in Einstellungen → E-Mail eintragen');
  return new Promise((resolve, reject) => {
    let step = 0, buf = '', activeSock;
    const write = s => activeSock.write(s + '\r\n');
    const b64   = s => Buffer.from(s, 'utf8').toString('base64');
    const onLine = line => {
      if (!line.trim()) return;
      const code = parseInt(line.substring(0, 3));
      const isFinal = line.length < 4 || line[3] === ' ';
      if (!isFinal) return; // continuation line
      if (code >= 500) { reject(new Error(`SMTP ${code}: ${line.substring(4).trim()}`)); activeSock.destroy(); return; }
      switch(step) {
        case 0: if(code===220){step=1;write('EHLO localhost');}break;
        case 1: if(code===250){step=2;write('STARTTLS');}break;
        case 2: if(code===220){
          step=3;
          plain.removeAllListeners('data');
          const tlsSock=tls.connect({socket:plain,host:SMTP_HOST,servername:SMTP_HOST});
          tlsSock.on('error',reject);
          tlsSock.on('connect',()=>{activeSock=tlsSock;buf='';tlsSock.on('data',handleData);write('EHLO localhost');step=4;});
        }break;
        case 4: if(code===250){step=5;write('AUTH LOGIN');}break;
        case 5: if(code===334){step=6;write(b64(SMTP_USER));}break;
        case 6: if(code===334){step=7;write(b64(SMTP_PASS));}break;
        case 7: if(code===235){step=8;write(`MAIL FROM:<${SMTP_USER}>`);}break;
        case 8: if(code===250){step=9;write(`RCPT TO:<${to}>`);}break;
        case 9: if(code===250){step=10;write('DATA');}break;
        case 10: if(code===354){
          step=11;
          const date=new Date().toUTCString();
          const escaped=body.replace(/\r?\n/g,'\r\n').split('\r\n').map(l=>l==='.'?'..':l).join('\r\n');
          activeSock.write(`From: JobHunter AI <${SMTP_USER}>\r\nTo: ${to}\r\nSubject: =?UTF-8?B?${b64(subject)}?=\r\nDate: ${date}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${escaped}\r\n.\r\n`);
        }break;
        case 11: if(code===250){step=12;write('QUIT');resolve();activeSock.destroy();}break;
      }
    };
    const handleData = data => { buf+=data.toString(); const lines=buf.split('\r\n'); buf=lines.pop(); for(const l of lines)onLine(l); };
    const plain=net.createConnection(parseInt(SMTP_PORT)||587, SMTP_HOST);
    activeSock=plain;
    plain.on('data',handleData);
    plain.on('error',reject);
    plain.setTimeout(25000,()=>{reject(new Error('SMTP Timeout'));plain.destroy();});
  });
}

// Core apply-job logic (used by both /api/apply and /api/apply-batch)
async function applyJob(jobId) {
  const job = getJob(jobId);
  if (!job) throw new Error('Job nicht gefunden');
  const profile = loadProfile();
  const lang = detectLanguage((job.title||'')+' '+(job.desc||''));
  const letter = await generateCoverLetter(job, profile, lang);

  // Try to extract a contact email
  let contactEmail = extractEmailFromText(job.desc||'');
  if (!contactEmail && job.id.startsWith('aa_')) {
    const detail = await fetchAAJobDetail(job.id.replace(/^aa_/,''));
    if (detail) contactEmail = extractEmailFromText(JSON.stringify(detail));
  }

  let method = 'clipboard'; // fallback: copy + open URL
  const smtpReady = CONFIG.SMTP_HOST && CONFIG.SMTP_USER && CONFIG.SMTP_PASS;

  if (contactEmail && smtpReady) {
    const subjectLine = lang==='en' ? `Application: ${job.title}` : `Bewerbung: ${job.title} bei ${job.company}`;
    const footer = lang==='en' ? '\n\n-- Sent via JobHunter AI' : '\n\n-- Gesendet via JobHunter AI';
    await sendSMTP({ to: contactEmail, subject: subjectLine, body: letter + footer });
    method = 'email_sent';
    // Confirmation to user's own email
    if (CONFIG.USER_EMAIL) {
      try {
        const confSubject = lang==='en' ? `✅ Application sent: ${job.title}` : `✅ Bewerbung gesendet: ${job.title}`;
        const confBody = (lang==='en'
          ? `Your application was sent!\n\nJob: ${job.title}\nCompany: ${job.company}\nSent to: ${contactEmail}\nDate: ${new Date().toLocaleString('de-DE')}`
          : `Deine Bewerbung wurde gesendet!\n\nStelle: ${job.title}\nFirma: ${job.company}\nGesendet an: ${contactEmail}\nDatum: ${new Date().toLocaleString('de-DE')}`)
          + `\n\n${'─'.repeat(40)}\n\n${letter}`;
        await sendSMTP({ to: CONFIG.USER_EMAIL, subject: confSubject, body: confBody });
      } catch(e) { console.log('[SMTP] Bestätigung fehlgeschlagen:', e.message); }
    }
  } else if (contactEmail) {
    method = 'mailto'; // has email but no SMTP config
  }

  const appliedAt = new Date().toISOString();
  updateJob(jobId, { status: 'applied', applied_at: appliedAt });
  return { ok: true, method, contactEmail, letter, lang, title: job.title, company: job.company, url: job.url };
}

// Extract readable text from a base64-encoded PDF without external dependencies.
// Works for text-based PDFs (not scanned images). Uses built-in zlib for
// FlateDecode streams, then pulls text from BT...ET PDF operator blocks.
function extractPdfText(base64) {
  // Cap input: a 3 MB binary is more than enough for any CV
  const buf = Buffer.from(base64.slice(0, 4 * 1024 * 1024), 'base64');
  const raw = buf.slice(0, 3 * 1024 * 1024).toString('binary');
  let allText = '';

  // Walk through all stream...endstream segments
  const streamRe = /stream\r?\n([\s\S]*?)endstream/g;
  let sm;
  while ((sm = streamRe.exec(raw)) !== null) {
    const dictEnd = sm.index;
    const dictStart = raw.lastIndexOf('<<', dictEnd);
    const dict = dictStart >= 0 ? raw.slice(dictStart, dictEnd) : '';
    const isFlate = /FlateDecode|\bFl\b/.test(dict);
    const data = Buffer.from(sm[1], 'binary');
    if (isFlate) {
      for (const inflate of [zlib.inflateSync, zlib.inflateRawSync]) {
        try { allText += inflate(data).toString('latin1') + '\n'; break; } catch(e) {}
      }
    } else {
      allText += data.toString('latin1') + '\n';
    }
  }

  function decOct(s) {
    return s.replace(/\\(\d{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
            .replace(/\\n/g,'\n').replace(/\\r/g,' ').replace(/\\t/g,' ')
            .replace(/\\\(/g,'(').replace(/\\\)/g,')').replace(/\\\\/g,'\\');
  }

  let text = '';
  const btRe = /BT([\s\S]*?)ET/g;
  let bm;
  while ((bm = btRe.exec(allText)) !== null) {
    const blk = bm[1];
    const tjRe = /\(([^)\\]*(?:\\.[^)\\]*)*)\)\s*Tj/g; let tm;
    while ((tm = tjRe.exec(blk)) !== null) text += decOct(tm[1]) + ' ';
    const taRe = /\[([^\]]*)\]\s*TJ/g; let tam;
    while ((tam = taRe.exec(blk)) !== null) {
      const parts = tam[1].match(/\(([^)\\]*(?:\\.[^)\\]*)*)\)/g);
      if (parts) text += parts.map(p => decOct(p.slice(1,-1))).join('') + ' ';
    }
    if (/T[dD*']/.test(blk)) text += '\n';
  }

  // Fallback: printable ASCII runs if PDF operator parsing yielded nothing
  if (text.trim().length < 80) {
    text = raw.replace(/[^\x20-\x7E\n\r\t]/g,' ').replace(/\s{4,}/g,' ');
  }

  return text.trim().slice(0, 8000);
}

async function analyzeCV(base64) {
  if (CONFIG.AI_MODE === 'ollama') {
    const pdfText = extractPdfText(base64);
    if (!pdfText || pdfText.trim().length < 60) {
      throw new Error('PDF-Text konnte nicht extrahiert werden (ggf. gescanntes PDF). Bitte Skills manuell eintragen.');
    }
    const prompt = `Analysiere den folgenden Lebenslauf-Text und extrahiere ALLE Skills – auch implizite aus Berufserfahrung, Projekten und Studium.\n\nLebenslauf:\n${pdfText}\n\nAntworte NUR mit JSON, kein Markdown:\n{"technical":[],"languages":[],"tools":[],"soft":[],"domains":[],"experience_summary":""}`;
    return callOllama([{ role: 'user', content: prompt }], 1000);
  }
  return callAnthropic([{role:'user',content:[
    {type:'document',source:{type:'base64',media_type:'application/pdf',data:base64}},
    {type:'text',text:'Analysiere diesen Lebenslauf. Extrahiere ALLE Skills – auch implizite aus Jobs, Projekten, Studium.\n\nAntworte NUR mit JSON, kein Markdown:\n{"technical":[],"languages":[],"tools":[],"soft":[],"domains":[],"experience_summary":""}'}
  ]}],800);
}

const CORS={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,OPTIONS','Access-Control-Allow-Headers':'Content-Type'};

function sendJSON(res, data, status=200) {
  const body=JSON.stringify(data);
  res.writeHead(status,{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body),...CORS});
  res.end(body);
}
function sendFile(res, fp, ct) {
  try{const c=fs.readFileSync(fp);res.writeHead(200,{'Content-Type':ct});res.end(c);}
  catch(e){res.writeHead(404);res.end('Not found');}
}
function readBody(req) {
  return new Promise(resolve=>{
    const chunks=[];
    req.on('data',c=>chunks.push(c));
    req.on('end',()=>{const raw=Buffer.concat(chunks).toString('utf8');try{resolve(JSON.parse(raw));}catch(e){resolve({});}});
  });
}

const server=http.createServer(async(req,res)=>{
  const {pathname}=url.parse(req.url,true);
  if (req.method==='OPTIONS'){res.writeHead(204,CORS);return res.end();}
  if (pathname==='/'||pathname==='/index.html') return sendFile(res,path.join(__dirname,'app.html'),'text/html;charset=utf-8');
  if (pathname==='/api/jobs'&&req.method==='GET') return sendJSON(res,loadJobs());
  if (pathname.startsWith('/api/jobs/')&&req.method==='PUT') {
    const id=pathname.replace('/api/jobs/',''); const body=await readBody(req);
    updateJob(id, body); return sendJSON(res,{ok:true});
  }
  if (pathname==='/api/test-anthropic'&&req.method==='GET') {
    if (!CONFIG.ANTHROPIC_API_KEY) return sendJSON(res,{ok:false,error:'Kein API Key gesetzt'},400);
    let models = [];
    try {
      const mr = await fetchUrl('https://api.anthropic.com/v1/models', {
        timeout: 15000,
        headers: { 'x-api-key': CONFIG.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      });
      const md = JSON.parse(mr.body);
      models = (md.data || []).map(m => m.id);
    } catch(e) { /* ignore */ }
    // Auto-switch to first available model if current one isn't in the list
    if (models.length && !models.includes(CONFIG.ANTHROPIC_MODEL)) {
      CONFIG.ANTHROPIC_MODEL = models[0];
      console.log(`[Anthropic] Modell automatisch gewechselt zu: ${CONFIG.ANTHROPIC_MODEL}`);
    }
    try {
      const reply = await callAnthropic([{role:'user',content:'Antworte nur mit: OK'}], 10);
      return sendJSON(res,{ok:true,reply,models,activeModel:CONFIG.ANTHROPIC_MODEL});
    } catch(e) { return sendJSON(res,{ok:false,error:e.message,models,activeModel:CONFIG.ANTHROPIC_MODEL},400); }
  }
  if (pathname==='/api/coverletter'&&req.method==='POST') {
    const {job}=await readBody(req);
    try{
      const lang=detectLanguage((job.title||'')+' '+(job.desc||''));
      return sendJSON(res,{letter:await generateCoverLetter(job,loadProfile(),lang),lang});
    }
    catch(e){return sendJSON(res,{error:e.message},500);}
  }
  if (pathname==='/api/apply'&&req.method==='POST') {
    const {jobId}=await readBody(req);
    try { return sendJSON(res, await applyJob(jobId)); }
    catch(e) { return sendJSON(res,{error:e.message},500); }
  }
  if (pathname==='/api/apply-batch'&&req.method==='POST') {
    const {jobIds}=await readBody(req);
    if (!Array.isArray(jobIds)||jobIds.length===0) return sendJSON(res,{error:'Keine Jobs ausgewählt'},400);
    const results=[];
    for (const id of jobIds) {
      try { results.push(await applyJob(id)); }
      catch(e) { results.push({ok:false,jobId:id,error:e.message}); }
    }
    return sendJSON(res,{ok:true,results});
  }
  if (pathname==='/api/analyze-cv'&&req.method==='POST') {
    const {base64}=await readBody(req);
    try{const raw=await analyzeCV(base64);return sendJSON(res,{raw});}
    catch(e){return sendJSON(res,{error:e.message},500);}
  }
  if (pathname==='/api/profile') {
    if (req.method==='GET') return sendJSON(res,loadProfile());
    if (req.method==='POST'){const body=await readBody(req);saveProfileData(body);return sendJSON(res,{ok:true});}
  }
  if (pathname==='/api/search') {
    if (req.method==='GET') return sendJSON(res,loadSearch());
    if (req.method==='POST'){const body=await readBody(req);saveSearch({...loadSearch(),...body});return sendJSON(res,{ok:true});}
  }
  if (pathname==='/api/scan'&&req.method==='POST'){sendJSON(res,{ok:true});runScan().catch(console.error);return;}
  if (pathname==='/api/status') {
    const data=loadJobs();
    return sendJSON(res,{running:true,lastScan:data.lastScan,scanCount:data.scanCount||0,jobCount:data.jobs?.length||0,newThisScan:data.newThisScan||0,nextScanIn:CONFIG.SCAN_INTERVAL_MINUTES,apiKeySet:!!CONFIG.ANTHROPIC_API_KEY,aiMode:CONFIG.AI_MODE,ollamaModel:CONFIG.OLLAMA_MODEL,anthropicModel:'claude-opus-4-7',smtpConfigured:!!(CONFIG.SMTP_HOST&&CONFIG.SMTP_USER&&CONFIG.SMTP_PASS),userEmail:CONFIG.USER_EMAIL||''});
  }
  if (pathname==='/api/config'&&req.method==='POST') {
    const body=await readBody(req);
    if (body.apiKey) {
      CONFIG.ANTHROPIC_API_KEY=body.apiKey;
      saveEnvKey('ANTHROPIC_API_KEY', body.apiKey);
    }
    if (body.scanInterval) { CONFIG.SCAN_INTERVAL_MINUTES=parseInt(body.scanInterval); restartScheduler(); }
    if (body.aiMode) CONFIG.AI_MODE=body.aiMode;
    if (body.ollamaModel) CONFIG.OLLAMA_MODEL=body.ollamaModel;
    if (body.ollamaUrl) CONFIG.OLLAMA_URL=body.ollamaUrl;
    if (body.anthropicModel) CONFIG.ANTHROPIC_MODEL=body.anthropicModel;
    if (body.smtpHost    !== undefined) { CONFIG.SMTP_HOST=body.smtpHost;   saveEnvKey('SMTP_HOST',   body.smtpHost); }
    if (body.smtpPort    !== undefined) { CONFIG.SMTP_PORT=parseInt(body.smtpPort)||587; saveEnvKey('SMTP_PORT', String(CONFIG.SMTP_PORT)); }
    if (body.smtpUser    !== undefined) { CONFIG.SMTP_USER=body.smtpUser;   saveEnvKey('SMTP_USER',   body.smtpUser); }
    if (body.smtpPass    !== undefined) { CONFIG.SMTP_PASS=body.smtpPass;   saveEnvKey('SMTP_PASS',   body.smtpPass); }
    if (body.userEmail   !== undefined) { CONFIG.USER_EMAIL=body.userEmail; saveEnvKey('USER_EMAIL',  body.userEmail); }
    return sendJSON(res,{ok:true});
  }
  if (pathname==='/api/ollama-status'&&req.method==='GET') {
    const status=await checkOllamaStatus();
    return sendJSON(res,{...status, currentModel:CONFIG.OLLAMA_MODEL, aiMode:CONFIG.AI_MODE});
  }

  // ── PDF AUS BEARBEITETEM TEXT ─────────────────────────────────────────
  if (pathname==='/api/generate-pdf' && req.method==='POST') {
    const { letter, title, company } = await readBody(req);
    if (!letter || letter.trim().length < 10) return sendJSON(res, { error: 'Kein Text' }, 400);
    try {
      const profile = loadProfile();
      const job = { title: title||'', company: company||'', url: '' };
      const pdfPath = await generateLetterPDF(letter, profile, job);
      const pdfBase64 = fs.readFileSync(pdfPath).toString('base64');
      setTimeout(() => { try { if (pdfPath.includes('_anschreiben_')) fs.unlinkSync(pdfPath); } catch(e){} }, 10*60*1000);
      return sendJSON(res, { ok: true, pdfBase64 });
    } catch(e) {
      return sendJSON(res, { error: e.message }, 500);
    }
  }

  // ── ANSCHREIBEN AUS URL ───────────────────────────────────────────────
  if (pathname==='/api/letter-from-url' && req.method==='POST') {
    const { url: jobUrl } = await readBody(req);
    if (!jobUrl || !/^https?:\/\//i.test(jobUrl)) return sendJSON(res, { error: 'Ungültige URL' }, 400);
    try {
      // Seite laden
      const pageRes = await fetchUrl(jobUrl, {
        timeout: 20000,
        headers: { 'Accept-Language': 'de-DE,de;q=0.9,en;q=0.7', 'Accept': 'text/html,*/*' }
      });
      const html = pageRes.body || '';
      // Text extrahieren (JSON-LD + sichtbarer Text)
      let title = '', company = '', desc = '';
      const jld = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)||[];
      for (const blk of jld) {
        try {
          const d = JSON.parse(blk.replace(/<script[^>]*>|<\/script>/gi,'').trim());
          const items = Array.isArray(d) ? d : [d];
          for (const it of items) {
            if (it['@type']==='JobPosting') {
              title   = it.title || title;
              company = it.hiringOrganization?.name || company;
              desc    = (it.description||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,1200);
            }
          }
        } catch(e) {}
      }
      if (!title) {
        const tm = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        title = tm ? tm[1].replace(/\s*[-|–]\s*.*$/,'').trim().slice(0,120) : new URL(jobUrl).hostname;
      }
      if (!desc) {
        // Grobe Texterkennung: alles aus <main> oder <article> oder <body>
        const bodyMatch = html.match(/<(?:main|article|section)[^>]*>([\s\S]*?)<\/(?:main|article|section)>/i)
                        || html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
        if (bodyMatch) desc = bodyMatch[1].replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,1200);
      }
      const job = { title, company: company||new URL(jobUrl).hostname, url: jobUrl, desc, keywords: [] };
      const profile = loadProfile();
      const lang = detectLanguage(title + ' ' + desc);
      const letter = await generateCoverLetter(job, profile, lang);
      return sendJSON(res, { ok: true, letter, title, company: job.company, lang });
    } catch(e) {
      return sendJSON(res, { error: e.message }, 500);
    }
  }

  if (pathname==='/api/browser-setup' && req.method==='POST') {
    try {
      const pp = getPuppeteer();
      const browserProfileDir = path.join(__dirname, 'browser-profile');
      if (!fs.existsSync(browserProfileDir)) fs.mkdirSync(browserProfileDir, { recursive: true });
      const browser = await pp.launch({
        headless: false, defaultViewport: null,
        userDataDir: browserProfileDir,
        args: ['--start-maximized','--no-sandbox','--disable-blink-features=AutomationControlled'],
        ignoreDefaultArgs: ['--enable-automation'],
      });
      const pages = await browser.pages();
      const page = pages[0] || await browser.newPage();
      await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(()=>{});
      browser.on('disconnected', () => {});
      return sendJSON(res, { ok: true, msg: 'Browser geöffnet – bitte auf LinkedIn, Xing, StepStone usw. einloggen und dann Browser schließen.' });
    } catch(e) { return sendJSON(res, { error: e.message }, 500); }
  }

  // ── FILE UPLOAD / MANAGEMENT ──────────────────────────────────────────
  if (pathname==='/api/files' && req.method==='GET') {
    return sendJSON(res, { files: listUploads() });
  }
  if (pathname==='/api/upload' && req.method==='POST') {
    const { filename, data } = await readBody(req);
    if (!filename || !data) return sendJSON(res, { error: 'filename und data erforderlich' }, 400);
    const safe = path.basename(String(filename)).replace(/[^\w.\-äöüÄÖÜß ]/g,'_').slice(0,100);
    if (!/\.(pdf|docx?|txt|png|jpe?g)$/i.test(safe)) return sendJSON(res, { error: 'Nur PDF/Word/Bild erlaubt' }, 400);
    fs.writeFileSync(path.join(UPLOADS_DIR, safe), Buffer.from(String(data), 'base64'));
    return sendJSON(res, { ok: true, filename: safe });
  }
  if (pathname.startsWith('/api/files/') && req.method==='DELETE') {
    const fn = path.basename(decodeURIComponent(pathname.slice('/api/files/'.length)));
    const fp = path.join(UPLOADS_DIR, fn);
    const resolved = path.resolve(fp);
    if (resolved.startsWith(path.resolve(UPLOADS_DIR)) && fs.existsSync(resolved)) fs.unlinkSync(resolved);
    return sendJSON(res, { ok: true });
  }

  // ── BROWSER AUTOMATION ────────────────────────────────────────────────
  if (pathname==='/api/auto-apply' && req.method==='POST') {
    const { jobId } = await readBody(req);
    try { return sendJSON(res, await autoBrowserApply(jobId)); }
    catch(e) { return sendJSON(res, { error: e.message }, 500); }
  }
  if (pathname.startsWith('/api/auto-apply/') && req.method==='GET') {
    const sid = pathname.slice('/api/auto-apply/'.length).split('/')[0];
    const s = autoSessions.get(sid);
    if (!s) return sendJSON(res, { status:'gone', steps:['Session abgelaufen oder nicht gefunden'], screenshot:null });
    return sendJSON(res, { status:s.status, steps:s.steps, screenshot:s.screenshot, url:s.url });
  }
  if (pathname.startsWith('/api/auto-apply/') && req.method==='POST') {
    const parts = pathname.slice('/api/auto-apply/'.length).split('/');
    const sid = parts[0], action = parts[1];
    const s = autoSessions.get(sid);
    if (!s) return sendJSON(res, { error: 'Session nicht gefunden' }, 404);
    if (action === 'submit') {
      if (!s.page) return sendJSON(res, { error: 'Kein Browser aktiv' }, 400);
      try {
        if (s.submitSelector) {
          await s.page.click(s.submitSelector).catch(async () => {
            await s.page.evaluate(sel => { const el=document.querySelector(sel); if(el) el.click(); }, s.submitSelector);
          });
        } else {
          await s.page.evaluate(() => {
            const btns = [...document.querySelectorAll('button,input[type=submit],[role=button]')];
            const b = btns.find(b => /submit|absenden|bewerben|senden|apply/i.test((b.textContent||'')+(b.value||'')));
            if (b) b.click();
          });
        }
        await new Promise(r => setTimeout(r, 3500));
        s.status = 'submitted';
        s.steps.push('🎉 Bewerbung abgesendet!');
        const sc = await s.page.screenshot({ encoding:'base64', type:'jpeg', quality:80 }).catch(()=>null);
        s.screenshot = sc;
        s.url = s.page.url();
        updateJob(s.jobId, { status:'applied', applied_at: new Date().toISOString() });
        return sendJSON(res, { ok:true, screenshot:sc, url:s.url });
      } catch(e) { return sendJSON(res, { error: e.message }, 500); }
    }
    if (action === 'close') {
      await s.browser?.close().catch(()=>{});
      autoSessions.delete(sid);
      return sendJSON(res, { ok: true });
    }
    if (action === 'continue') {
      if (s.status === 'waiting_manual') s.status = 'filling';
      return sendJSON(res, { ok: true });
    }
    return sendJSON(res, { error: 'Unbekannte Aktion' }, 400);
  }

  res.writeHead(404);res.end('Not found');
});

let schedulerTimer=null;
function restartScheduler(){if(schedulerTimer)clearInterval(schedulerTimer);schedulerTimer=setInterval(()=>runScan().catch(console.error),CONFIG.SCAN_INTERVAL_MINUTES*60*1000);}
function startScheduler(){console.log(`⏰ Scan alle ${CONFIG.SCAN_INTERVAL_MINUTES} Min`);setTimeout(()=>runScan().catch(console.error),6000);restartScheduler();}

function loadEnv(){
  try{
    if(!fs.existsSync(FILES.env))return;
    fs.readFileSync(FILES.env,'utf8').split('\n').forEach(line=>{const[k,...v]=line.split('=');if(k&&v.length)process.env[k.trim()]=v.join('=').trim();});
    if(process.env.ANTHROPIC_API_KEY)CONFIG.ANTHROPIC_API_KEY=process.env.ANTHROPIC_API_KEY;
    if(process.env.SMTP_HOST)CONFIG.SMTP_HOST=process.env.SMTP_HOST;
    if(process.env.SMTP_PORT)CONFIG.SMTP_PORT=parseInt(process.env.SMTP_PORT)||587;
    if(process.env.SMTP_USER)CONFIG.SMTP_USER=process.env.SMTP_USER;
    if(process.env.SMTP_PASS)CONFIG.SMTP_PASS=process.env.SMTP_PASS;
    if(process.env.USER_EMAIL)CONFIG.USER_EMAIL=process.env.USER_EMAIL;
  }catch(e){}
}

function saveEnvKey(key, value) {
  try {
    const env = fs.existsSync(FILES.env) ? fs.readFileSync(FILES.env,'utf8') : '';
    const lines = env.split('\n').filter(l => !l.startsWith(key+'=') && l.trim());
    if (value) lines.push(`${key}=${value}`);
    fs.writeFileSync(FILES.env, lines.join('\n') + '\n');
  } catch(e) {}
}

loadEnv();
migrateFromJSON();
cleanBadLocalJobs();
const nets=require('os').networkInterfaces();
let localIP='localhost';
for(const iface of Object.values(nets).flat()){if(iface.family==='IPv4'&&!iface.internal){localIP=iface.address;break;}}

server.listen(CONFIG.PORT,'0.0.0.0',()=>{
  console.log(`\n${'█'.repeat(54)}\n  🚀  JobHunter AI  –  Server läuft!\n${'█'.repeat(54)}`);
  console.log(`\n  💻  PC:      http://localhost:${CONFIG.PORT}`);
  console.log(`  📱  iPhone:  http://${localIP}:${CONFIG.PORT}  ← diese Adresse!`);
  console.log('\n  In Safari öffnen → Teilen → Zum Home-Bildschirm');
  console.log(`${'─'.repeat(54)}\n  ${CONFIG.ANTHROPIC_API_KEY?'✅ API Key geladen':'⚠️  Kein API Key → in App unter Einstellungen'}\n${'─'.repeat(54)}\n`);
  startScheduler();
});
server.on('error',e=>{if(e.code==='EADDRINUSE')console.error(`\n❌ Port ${CONFIG.PORT} belegt.`);else console.error('Fehler:',e.message);process.exit(1);});
