/**
 * JobHunter AI - Windows Server v2
 * Start: node server.js
 */
// Force UTF-8 output on Windows so console shows correct characters
if (process.stdout.isTTY) { try { process.stdout.setEncoding('utf8'); } catch(e) {} }
try { process.stdout._handle && process.stdout._handle.setBlocking && process.stdout._handle.setBlocking(true); } catch(e) {}
const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');
const zlib  = require('zlib');
const net   = require('net');
const tls   = require('tls');
const crypto= require('crypto');
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

const CONFIG = { PORT: process.env.PORT || 3000, ANTHROPIC_API_KEY: '', ACCESS_PIN: '', SCAN_INTERVAL_MINUTES: 60, AI_MODE: 'anthropic', OLLAMA_URL: 'http://localhost:11434', OLLAMA_MODEL: 'llama3.1:70b-instruct-q4_K_M', OLLAMA_VISION_MODEL: 'llava:latest', OLLAMA_LETTER_MODEL: '', SMTP_HOST: '', SMTP_PORT: 587, SMTP_USER: '', SMTP_PASS: '', USER_EMAIL: '' };

// -- MODELL-ZUWEISUNG PRO AUFGABE --------------------------------------
// haiku:  $0.80/$4.00  per 1M tokens  ï¿½ schnell, gï¿½nstig, gut fï¿½r strukturierte Aufgaben
// sonnet: $3.00/$15.00 per 1M tokens  ï¿½ ausgeglichen, gut fï¿½r komplexe Dokumente
// opus:   $15.00/$75.00 per 1M tokens ï¿½ stï¿½rkste Qualitï¿½t (derzeit nicht genutzt)
const MODELS = {
  coverLetter: 'claude-haiku-4-5',      // Anschreiben: haiku reicht, 18x gï¿½nstiger als Opus
  cvAnalysis:  'claude-3-5-sonnet-20241022', // Lebenslauf lesen: Sonnet fï¿½r gute Extraktion
  vision:      'claude-haiku-4-5',      // VisionAI (Browser-Steuerung): haiku reicht fï¿½r JSON-Entscheidungen
  testPing:    'claude-haiku-4-5',      // Verbindungstest
};

// -- ANTHROPIC KOSTEN-TRACKER ---------------------------------------------
// Preise in $ pro 1M Tokens (Stand April 2026 ï¿½ ggf. anpassen)
const ANTHROPIC_PRICES = {
  'claude-opus-4-5':          { in: 15.00,  out: 75.00 },
  'claude-opus-4-7':          { in: 15.00,  out: 75.00 },
  'claude-3-opus-20240229':   { in: 15.00,  out: 75.00 },
  'claude-3-5-sonnet-20241022':{ in: 3.00,  out: 15.00 },
  'claude-3-5-haiku-20241022':{ in: 0.80,  out: 4.00  },
  'claude-haiku-4-5':         { in: 0.80,  out: 4.00  },
  'claude-3-haiku-20240307':  { in: 0.25,  out: 1.25  },
};
function getPriceForModel(model) {
  if (ANTHROPIC_PRICES[model]) return ANTHROPIC_PRICES[model];
  if (model.includes('opus'))  return { in: 15.00, out: 75.00 };
  if (model.includes('sonnet'))return { in: 3.00,  out: 15.00 };
  if (model.includes('haiku')) return { in: 0.80,  out: 4.00  };
  return { in: 3.00, out: 15.00 };
}
const aiCostTracker = {
  session_start: new Date().toISOString(),
  calls: [],
  total_input_tokens: 0,
  total_output_tokens: 0,
  total_cost_usd: 0,
};
function trackCost(label, model, inputTokens, outputTokens) {
  const price = getPriceForModel(model);
  const cost = (inputTokens / 1e6) * price.in + (outputTokens / 1e6) * price.out;
  aiCostTracker.total_input_tokens  += inputTokens;
  aiCostTracker.total_output_tokens += outputTokens;
  aiCostTracker.total_cost_usd      += cost;
  aiCostTracker.calls.push({ ts: new Date().toISOString(), label, model, inputTokens, outputTokens, cost_usd: +cost.toFixed(6) });
  // Keep only last 200 calls to avoid unbounded memory
  if (aiCostTracker.calls.length > 200) aiCostTracker.calls = aiCostTracker.calls.slice(-200);
  console.log(`[AI-Cost] ${label} ï¿½ ${model} ï¿½ in:${inputTokens} out:${outputTokens} ï¿½ $${cost.toFixed(4)} ï¿½ Gesamt: $${aiCostTracker.total_cost_usd.toFixed(4)}`);
}

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
  sources: { aa: true, stepstone: true, linkedin: true, xing: false, heise: true, google: true, remotive: true, arbeitnow: true },
  custom_sources: [],
};

// -- AUTH (PIN) ------------------------------------------------------------
const activeSessions = new Map(); // token ? { created: timestamp }
let scanRunning = false; // global scan lock
let scanStarted = null; // timestamp when current scan began
let scanStep    = '';   // current scrape target for UI progress
function genToken() { return crypto.randomBytes(24).toString('hex'); }
function checkAuth(req) {
  const pin = (CONFIG.ACCESS_PIN||'').trim();
  if (!pin) return true; // No PIN configured ? open access
  const q = url.parse(req.url, true).query;
  const hToken = (req.headers['authorization']||'').replace(/^Bearer\s+/i,'');
  const token = (q.token||hToken||'').trim();
  if (!token) return false;
  const sess = activeSessions.get(token);
  if (!sess) return false;
  if (Date.now() - sess.created > 30*24*60*60*1000) { activeSessions.delete(token); return false; }
  return true;
}

// -- SQLITE DATABASE ------------------------------------------------------
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
try { db.exec('ALTER TABLE jobs ADD COLUMN letter TEXT'); } catch(e) {}

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
    scrapedAt:r.scraped_at, appliedAt:r.applied_at, letter:r.letter||null };
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
  const p = { name:'', email:'', phone:'', street:'', zip:'', skills:'', experience:'', bio:'', location:'', languages:'', bachelorFach:'', bachelorNote:'', hochschule:'', abschlussjahr:'', cvSkills:[], want_remote:true, want_local:true, want_car:true, radius_km:10, radius_car_km:50, salary:null, salaryMin:null, salaryMax:null };
  for (const { key, value } of rows) {
    if (key==='cvSkills' || key==='cvProjects') { try { p[key]=JSON.parse(value); } catch(e) {} }
    else if (['want_remote','want_local','want_car'].includes(key)) p[key] = value==='true';
    else if (['radius_km','radius_car_km','salary','salaryMin','salaryMax'].includes(key)) p[key] = parseInt(value)||null;
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
      // Delete profile.json after migration — DB is the single source of truth
      fs.unlinkSync(FILES.profile);
      console.log('[DB] profile.json geloescht (Daten in DB)');
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
      hostname: parsed.hostname,
      port: parsed.port ? parseInt(parsed.port) : (parsed.protocol==='https:' ? 443 : 80),
      path: parsed.pathname+parsed.search,
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
    const umkreis=sc.radius_km||10; // local radius only; car-range jobs handled separately
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
        desc:(s.titel||'')+(ortName?' ï¿½ '+ortName:'')+(s.arbeitgeber?' bei '+s.arbeitgeber:''),
        url:jobUrl,
        source:'Arbeitsagentur',status:'new',match:0,scrapedAt:new Date().toISOString()
      });
    }
  } catch(e){console.log(`  AA(${kw}):${e.message}`);}
  return jobs;
}

// -- USER-AGENT ROTATION --------------------------------------------------
const UA_POOL=[
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0',
];
function randUA(){return UA_POOL[Math.floor(Math.random()*UA_POOL.length)];}

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
    const loc=sc.location||'Deutschland';
    const searchUrl=`https://www.stepstone.de/jobs/${encodeURIComponent(kw).replace(/%20/g,'-')}/in-${encodeURIComponent(loc).replace(/%20/g,'-')}?radius=${radius}&sort=2`;
    const pp=getPuppeteer();
    let browser=null;
    try {
      browser=await pp.launch({headless:true,args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled'],timeout:30000});
      const page=await browser.newPage();
      await page.setUserAgent(randUA());
      await page.setExtraHTTPHeaders({'Accept-Language':'de-DE,de;q=0.9'});
      await page.setViewport({width:1280,height:900});
      await page.goto(searchUrl,{waitUntil:'networkidle2',timeout:30000}).catch(()=>page.goto(searchUrl,{waitUntil:'domcontentloaded',timeout:25000}));
      // Wait for job list items
      await page.waitForSelector('li[data-at="job-item"],article[data-at="job-item"],[data-genesis-element="JOB_ITEM"]',{timeout:8000}).catch(()=>{});
      const html=await page.content();
      console.log(`  SS(${kw}): Puppeteer body=${html.length}`);
      // Parse job items: StepStone uses data-at="job-item"
      const decodeHtml=s=>s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").trim();
      // Try job items via data-at
      const liRe=/<(?:li|article)[^>]+data-at="job-item"[^>]*>([\s\S]*?)(?=<(?:li|article)[^>]+data-at="job-item"|<\/(?:ul|ol|section|main)|$)/g;
      for (const [,block] of html.matchAll(liRe)) {
        // Title from data-at="job-item-title"
        const titleM=block.match(/data-at="job-item-title"[^>]*>([\s\S]*?)<\/(?:a|h2|h3|span)>/)||block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
        if (!titleM) continue;
        const title=decodeHtml(titleM[1].replace(/<[^>]+>/g,''));
        if (!title||title.length<3) continue;
        const companyM=block.match(/data-at="job-item-company-name"[^>]*>([\s\S]*?)<\/(?:a|span|p|div)>/)||block.match(/<span[^>]*company[^>]*>([\s\S]*?)<\/span>/i);
        const company=companyM?decodeHtml(companyM[1].replace(/<[^>]+>/g,'')):'Unbekannt';
        const locM=block.match(/data-at="job-item-location"[^>]*>([\s\S]*?)<\/(?:span|div|a)>/)||block.match(/class="[^"]*location[^"]*"[^>]*>([\s\S]*?)<\/(?:span|div)>/i);
        const cityRaw=locM?decodeHtml(locM[1].replace(/<[^>]+>/g,'')).trim():'';
        const city=cityRaw||'Deutschland';
        const cityKnown=!!cityRaw;
        const isRemote=/remote|homeoffice/i.test(city+' '+title);
        // Extract URL
        const urlM=block.match(/href="(https?:\/\/www\.stepstone\.de\/[^"]+)"/)||block.match(/href="(\/stellenangebote\/[^"]+)"/);
        const jobUrl=urlM?(urlM[1].startsWith('http')?urlM[1]:`https://www.stepstone.de${urlM[1]}`):'https://www.stepstone.de';
        // Extract job ID from URL
        const idM=jobUrl.match(/--(\d+)\.html/)||jobUrl.match(/id=(\d+)/)||jobUrl.match(/\/(\d{6,})/);
        const jobId=idM?idM[1]:Math.random().toString(36).slice(2,12);
        const posted=new Date().toISOString().split('T')[0];
        jobs.push({id:'ss_'+jobId,title,company,
          location:isRemote?'Remote':city,remote:isRemote,local:cityKnown&&!isRemote,
          car:false,salary:null,posted,
          keywords:extractKw(title),
          desc:`${title} bei ${company} (${city})`,
          url:jobUrl,source:'StepStone',status:'new',match:0,scrapedAt:new Date().toISOString()});
        if(jobs.length>=12) break;
      }
    } finally { if(browser) await browser.close().catch(()=>{}); }
  } catch(e){console.log(`  SS(${kw}): ${e.message}`);}
  return jobs;
}

async function scrapeLinkedIn(kw, sc) {
  const jobs=[];
  const seenIds=new Set();
  const liHeaders={
    'User-Agent':randUA(),
    'Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language':'de-DE,de;q=0.9,en;q=0.8',
    'Referer':'https://www.linkedin.com/',
    'Sec-Fetch-Dest':'empty','Sec-Fetch-Mode':'cors','Sec-Fetch-Site':'same-origin',
  };
  // Pass 1: local area search
  // Pass 2: remote-only search across Germany (f_WT=2)
  const loc=sc.location||'Deutschland';
  const searches=[
    {url:`https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${encodeURIComponent(kw)}&location=${encodeURIComponent(loc)}&f_TPR=r2592000&start=0`, forceRemote:false},
    {url:`https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${encodeURIComponent(kw)}&location=Deutschland&geoId=101282230&f_WT=2&f_TPR=r2592000&start=0`, forceRemote:true},
    {url:`https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${encodeURIComponent(kw)}&location=Deutschland&geoId=101282230&f_WT=2&f_TPR=r2592000&start=25`, forceRemote:true},
  ];
  for (const search of searches) {
    try {
      const res=await fetchUrl(search.url,{timeout:22000,headers:liHeaders});
      if (res.status!==200||res.body.length<200){console.log(`  LinkedIn(${kw})[${search.forceRemote?'remote':'local'}]: HTTP ${res.status}`);continue;}
      // Extract IDs
      const ids=[
        ...[...res.body.matchAll(/data-entity-urn="urn:li:jobPosting:(\d+)"/g)].map(m=>m[1]),
        ...[...res.body.matchAll(/jobPostingId["\s]*[:=]["\s]*(\d{8,})/g)].map(m=>m[1]),
        ...[...res.body.matchAll(/\/jobs\/view\/(\d{8,})/g)].map(m=>m[1]),
      ].filter((v,i,a)=>a.indexOf(v)===i&&!seenIds.has(v));
      ids.forEach(id=>seenIds.add(id));
      // Extract titles, companies, locations
      const titles=[
        ...[...res.body.matchAll(/<h3[^>]*class="[^"]*base-search-card__title[^"]*"[^>]*>([\s\S]*?)<\/h3>/g)],
        ...[...res.body.matchAll(/<span[^>]*class="[^"]*result-card__title[^"]*"[^>]*>([\s\S]*?)<\/span>/g)],
      ].map(m=>m[1].replace(/<[^>]+>/g,'').trim()).filter(Boolean);
      const comps=[
        ...[...res.body.matchAll(/<h4[^>]*class="[^"]*base-search-card__subtitle[^"]*"[^>]*>([\s\S]*?)<\/h4>/g)],
        ...[...res.body.matchAll(/<a[^>]*class="[^"]*result-card__subtitle[^"]*"[^>]*>([\s\S]*?)<\/a>/g)],
      ].map(m=>m[1].replace(/<[^>]+>/g,'').trim()).filter(Boolean);
      const locs=[
        ...[...res.body.matchAll(/<span[^>]*class="[^"]*job-search-card__location[^"]*"[^>]*>([\s\S]*?)<\/span>/g)],
        ...[...res.body.matchAll(/<span[^>]*class="[^"]*result-card__location[^"]*"[^>]*>([\s\S]*?)<\/span>/g)],
      ].map(m=>m[1].replace(/<[^>]+>/g,'').trim()).filter(Boolean);
      for (let i=0;i<Math.min(ids.length,25);i++) {
        const title=titles[i]||kw; const company=comps[i]||'Unbekannt';
        const locationRaw=locs[i]||''; const location=locationRaw||'Deutschland';
        const locKnown=!!locationRaw;
        const isRemote=search.forceRemote||/remote|homeoffice|home.?office/i.test(title+' '+location);
        jobs.push({id:'li_'+ids[i],title,company,location:isRemote?'Remote':location,
          remote:isRemote,local:locKnown&&!isRemote,car:false,salary:null,posted:'Kï¿½rzlich',
          keywords:extractKw(title+' '+company),desc:`${title} bei ${company} (${location})`,
          url:`https://www.linkedin.com/jobs/view/${ids[i]}`,
          source:'LinkedIn',status:'new',match:0,scrapedAt:new Date().toISOString()});
      }
      console.log(`  LinkedIn(${kw})[${search.forceRemote?'remote':'local'}]: ${ids.length} IDs`);
      await sleep(800);
    } catch(e){console.log(`  LinkedIn(${kw}): ${e.message}`);}
  }
  return jobs;
}

async function scrapeXing(kw, sc) {
  const jobs=[];
  try {
    const loc=sc.location||'Deutschland';
    const radius=sc.radius_km||10;
    const res=await fetchUrl(
      `https://www.xing.com/jobs/search?keywords=${encodeURIComponent(kw)}&location=${encodeURIComponent(loc)}&radius=${radius}&country=de`,
      {timeout:20000,headers:{'User-Agent':randUA(),'Accept':'text/html,application/xhtml+xml,*/*;q=0.8','Accept-Language':'de-DE,de;q=0.9','Accept-Encoding':'identity'}}
    );
    if (res.status!==200){console.log(`  Xing(${kw}): HTTP ${res.status}`);return jobs;}
    console.log(`  Xing(${kw}): HTTP ${res.status} body=${res.body.length}`);
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
  const decodeHtml=s=>s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").trim();
  try {
    const loc=sc.location||'';
    const radius=Math.max(sc.radius_km||10,30);
    const urls=[
      `https://jobs.heise.de/search?${new URLSearchParams({q:kw,...(loc?{location:loc,radius:String(radius)}:{})}).toString()}`,
      `https://jobs.heise.de/?${new URLSearchParams({search:kw,...(loc?{location:loc}:{})}).toString()}`
    ];
    let res=null;
    for (const u of urls) {
      try{ res=await fetchUrl(u,{timeout:15000,headers:{'User-Agent':randUA(),'Accept':'text/html,application/xhtml+xml,*/*;q=0.8','Accept-Language':'de-DE,de;q=0.9'}}); }
      catch(e){ continue; }
      if(res.status===200) break;
      console.log(`  Heise(${kw}): HTTP ${res.status}`);
      res=null;
    }
    if (!res) return jobs;
    console.log(`  Heise(${kw}): HTTP 200 body=${res.body.length}`);
    // Primary: parse <li data-id="..."> job card structure (Heise Next.js SSR)
    const liRe=/<li[^>]+data-id="(\d+)"[^>]*>([\s\S]*?)(?=<li[^>]+data-id="|<\/ul>|<\/ol>|$)/g;
    for (const [,jobId,block] of res.body.matchAll(liRe)) {
      const h2m=block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
      if (!h2m) continue;
      // Strip badge spans (TOP, NEU, etc.) before removing all tags
      const cleanH2=h2m[1].replace(/<span[^>]*>[A-Z]{2,10}<\/span>/g,'');
      const title=decodeHtml(cleanH2.replace(/<[^>]+>/g,''));
      if (!title||title.length<3) continue;
      const companyM=block.match(/<\/h2><span[^>]*>([\s\S]*?)<\/span>/);
      const company=companyM?decodeHtml(companyM[1].replace(/<[^>]+>/g,'')):'Unbekannt';
      const locM=block.match(/class="[^"]*\bloc\b[^"]*"[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/);
      const cityRaw=locM?decodeHtml(locM[1].replace(/<[^>]+>/g,'')):'';
      const city=cityRaw||'Deutschland';
      const cityKnown=!!cityRaw;
      const isRemote=/remote|homeoffice/i.test(city+' '+title);
      const descM=block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
      const desc=descM?decodeHtml(descM[1].replace(/<[^>]+>/g,'')).slice(0,350):`${title} bei ${company}`;
      jobs.push({id:'hi_'+jobId,title,company,
        location:isRemote?'Remote':city,remote:isRemote,local:cityKnown&&!isRemote,car:false,salary:null,
        posted:new Date().toISOString().split('T')[0],
        keywords:extractKw(title+' '+desc.slice(0,300)),desc,
        url:`https://jobs.heise.de/job?id=${jobId}`,
        source:'Heise Jobs',status:'new',match:0,scrapedAt:new Date().toISOString()});
      if(jobs.length>=12) break;
    }
  } catch(e){console.log(`  Heise(${kw}):${e.message}`);}
  return jobs;
}

async function scrapeBing(kw, sc) {
  const jobs=[];
  try {
    const city=sc.location||'Schweinfurt';
    // Strategy 1: Bing Jobs dedicated search (best structured data)
    const bjRes=await fetchUrl(
      `https://www.bing.com/jobs/search?q=${encodeURIComponent(kw+' '+city)}&language=de&cc=DE`,
      {timeout:18000,headers:{
        'User-Agent':randUA(),
        'Accept':'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language':'de-DE,de;q=0.9',
        'Referer':'https://www.bing.com/',
        'Sec-Fetch-Dest':'document','Sec-Fetch-Mode':'navigate','Sec-Fetch-Site':'none',
      }}
    ).catch(()=>null);
    if (bjRes&&bjRes.status===200) {
      for (const m of bjRes.body.matchAll(/<script type=["']application\/ld\+json["']>([\s\S]*?)<\/script>/g)) {
        try {
          const d=JSON.parse(m[1]);
          for (const item of (Array.isArray(d)?d:[d])) {
            if (item['@type']!=='JobPosting') continue;
            const loc2=item.jobLocation?.address?.addressLocality||city;
            const desc=(item.description||'').replace(/<[^>]+>/g,'');
            const isRemote=item.jobLocationType==='TELECOMMUTE'||/remote|homeoffice/i.test(loc2+' '+item.title);
            jobs.push({id:'bi_'+Buffer.from((item.url||'')+(item.datePosted||'')).toString('base64').slice(0,12),
              title:item.title||kw,company:item.hiringOrganization?.name||'Unbekannt',
              location:isRemote?'Remote':loc2,remote:isRemote,local:!isRemote,car:false,salary:null,
              posted:item.datePosted||new Date().toISOString().split('T')[0],
              keywords:extractKw(item.title+' '+desc.slice(0,200)),
              desc:desc.slice(0,350)||`${item.title} (via Bing)`,
              url:item.url||`https://www.bing.com/jobs/search?q=${encodeURIComponent(item.title+' '+city)}`,
              source:'Bing',status:'new',match:0,scrapedAt:new Date().toISOString()});
            if(jobs.length>=10) break;
          }
        } catch(e){}
      }
      if (jobs.length>0) return jobs;
    }
    // Strategy 2: Bing Web Search with job site filter
    const query=`${kw} Stelle site:stepstone.de OR site:arbeitsagentur.de ${city}`;
    const res=await fetchUrl(
      `https://www.bing.com/search?q=${encodeURIComponent(query)}&mkt=de-DE&cc=DE&count=15&setlang=de-DE`,
      {timeout:18000,headers:{
        'User-Agent':randUA(),
        'Accept':'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language':'de-DE,de;q=0.9',
        'Referer':'https://www.bing.com/',
        'Sec-Fetch-Dest':'document','Sec-Fetch-Mode':'navigate','Sec-Fetch-Site':'none',
      }}
    );
    if (res.status!==200){console.log(`  Bing(${kw}): HTTP ${res.status}`);return jobs;}
    // Only block on actual Bing challenge/captcha page (very specific patterns)
    if (/C_ChallengeEndLocation|data-w=["']ChallengeRendered["']|BingCaptchaChallenge/i.test(res.body)){console.log(`  Bing(${kw}): Bot-Erkennung`);return jobs;}
    // JSON-LD in Bing results
    for (const m of res.body.matchAll(/<script type=["']application\/ld\+json["']>([\s\S]*?)<\/script>/g)) {
      try {
        const d=JSON.parse(m[1]);
        for (const item of (Array.isArray(d)?d:[d])) {
          if (item['@type']!=='JobPosting') continue;
          const loc2=item.jobLocation?.address?.addressLocality||city;
          const desc=(item.description||'').replace(/<[^>]+>/g,'');
          const isRemote=item.jobLocationType==='TELECOMMUTE'||/remote|homeoffice/i.test(loc2+' '+item.title);
          jobs.push({id:'bi_'+Buffer.from((item.url||'')+(item.datePosted||'')).toString('base64').slice(0,12),
            title:item.title||kw,company:item.hiringOrganization?.name||'Unbekannt',
            location:isRemote?'Remote':loc2,remote:isRemote,local:!isRemote,car:false,salary:null,
            posted:item.datePosted||new Date().toISOString().split('T')[0],
            keywords:extractKw(item.title+' '+desc.slice(0,200)),
            desc:desc.slice(0,350)||`${item.title} (via Bing)`,
            url:item.url||`https://www.bing.com/search?q=${encodeURIComponent(item.title+' '+city)}`,
            source:'Bing',status:'new',match:0,scrapedAt:new Date().toISOString()});
          if(jobs.length>=10) break;
        }
      } catch(e){}
    }
    if (jobs.length>0) return jobs;
    // Organic results fallback
    const seen=new Set();
    for (const [,rawHref,rawTitle] of res.body.matchAll(/<a[^>]+href="(https?:\/\/[^"]{10,})"[^>]*>[\s\S]{0,600}?<h2[^>]*>([\s\S]*?)<\/h2>/g)) {
      if (/bing\.com|microsoft\.com|youtube\.com|wikipedia\./i.test(rawHref)) continue;
      if (seen.has(rawHref)) continue; seen.add(rawHref);
      const title=rawTitle.replace(/<[^>]+>/g,'').trim();
      if (!title||title.length<6) continue;
      jobs.push({id:'bi_'+Buffer.from(rawHref.slice(0,60)).toString('base64').slice(0,12),
        title,company:'Unbekannt',location:city,remote:false,local:true,car:false,salary:null,
        posted:new Date().toISOString().split('T')[0],keywords:extractKw(title),
        desc:`${title} in ${city} (via Bing)`,url:rawHref,
        source:'Bing',status:'new',match:0,scrapedAt:new Date().toISOString()});
      if(jobs.length>=10) break;
    }
  } catch(e){console.log(`  Bing(${kw}):${e.message}`);}
  return jobs;
}

// -- REMOTIVE ï¿½ kostenlose Remote-Jobs API -------------------------------
async function scrapeRemotive(kw, sc) {
  const jobs=[];
  try {
    const res=await fetchUrl(`https://remotive.com/api/remote-jobs?search=${encodeURIComponent(kw)}&limit=15`,{
      timeout:15000,
      headers:{'Accept':'application/json','User-Agent':randUA()},
    });
    if (res.status!==200){console.log(`  Remotive(${kw}): HTTP ${res.status}`);return jobs;}
    const data=JSON.parse(res.body);
    for (const job of (data.jobs||[]).slice(0,25)) {
      // DACH filter: allow worldwide/Europe/DACH/empty location, block US-only etc.
      const rloc=(job.candidate_required_location||'').toLowerCase();
      if (rloc && !/worldwide|anywhere|global|europe|dach|germany|deutschland|austria|ï¿½sterreich|schweiz|switzerland|remote|\beu\b|international/i.test(rloc)) continue;
      const desc=(job.description||'').replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim().slice(0,350);
      jobs.push({
        id:'rm_'+job.id,
        title:job.title||kw,
        company:job.company_name||'Unbekannt',
        location:'Remote',
        remote:true,local:false,car:false,
        salary:job.salary||null,
        posted:(job.publication_date||'').split('T')[0]||new Date().toISOString().split('T')[0],
        keywords:extractKw(job.title+' '+(job.tags||[]).join(' ')),
        desc:desc||job.title,
        url:job.url||'https://remotive.com',
        source:'Remotive',status:'new',match:0,scrapedAt:new Date().toISOString(),
      });
    }
  } catch(e){console.log(`  Remotive(${kw}): ${e.message}`);}
  return jobs;
}

// -- ARBEITNOW ï¿½ kostenlose DE/EU Jobs API --------------------------------
async function scrapeArbeitnow(kw, sc) {
  const jobs=[];
  try {
    const res=await fetchUrl(`https://www.arbeitnow.com/api/job-board-api?search=${encodeURIComponent(kw)}`,{
      timeout:15000,
      headers:{'Accept':'application/json','User-Agent':randUA()},
    });
    if (res.status!==200){console.log(`  Arbeitnow(${kw}): HTTP ${res.status}`);return jobs;}
    const data=JSON.parse(res.body);
    for (const job of (data.data||[]).slice(0,25)) {
      const isRemote=!!(job.remote)||/remote|homeoffice/i.test(job.location||'');
      // DACH filter: only keep DE/AT/CH or remote jobs
      const jloc=(job.location||'').toLowerCase();
      const isDACH=/deutschland|germany|berlin|mï¿½nchen|munich|hamburg|frankfurt|kï¿½ln|cologne|dï¿½sseldorf|dortmund|essen|stuttgart|austria|ï¿½sterreich|wien|graz|salzburg|schweiz|switzerland|zï¿½rich|genf|basel|remote|homeoffice|home.?office/i.test(jloc);
      if (!isRemote && jloc && !isDACH) continue;
      // Fix created_at: Arbeitnow returns Unix timestamp (number) or ISO string
      const ca=job.created_at;
      let posted=new Date().toISOString().split('T')[0];
      if (ca!==undefined&&ca!==null) {
        try { posted=new Date(typeof ca==='number'?ca*1000:ca).toISOString().split('T')[0]; } catch(e) {}
      }
      const locationRaw=(job.location||'').trim();
      const locationVal=locationRaw||'Deutschland';
      const locKnown=!!locationRaw;
      const desc=(job.description||'').replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim().slice(0,350);
      jobs.push({
        id:'an_'+(job.slug||Math.random().toString(36).slice(2,12)),
        title:job.title||kw,
        company:job.company_name||'Unbekannt',
        location:isRemote?'Remote':locationVal,
        remote:isRemote,local:locKnown&&!isRemote,car:false,
        salary:null,
        posted,
        keywords:extractKw(job.title+' '+(job.tags||[]).join(' ')),
        desc:desc||job.title,
        url:job.url||`https://www.arbeitnow.com/jobs/${job.slug||''}`,
        source:'Arbeitnow',status:'new',match:0,scrapedAt:new Date().toISOString(),
      });
    }
  } catch(e){console.log(`  Arbeitnow(${kw}): ${e.message}`);}
  return jobs;
}

// -- BROWSER AUTOMATION ---------------------------------------------------
let _puppeteer = null;
function getPuppeteer() {
  if (!_puppeteer) {
    try { _puppeteer = require('puppeteer'); }
    catch(e) { throw new Error('Puppeteer nicht installiert. Bitte einmalig ausfï¿½hren: npm install (ca. 300MB)'); }
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
  const accent = '#1e1b2e';
  const isDE = /\b(ich|mich|meine|haben|habe|bin|bei|und|oder|mit|auf|für|sich|dass|ist|wird|werden)\b/i.test(letter);
  const badgeText = isDE ? 'Anschreiben' : 'Cover<br>Letter';

  // Split name into first / last
  const nameParts = (profile.name||'Bewerber').trim().split(/\s+/);
  const firstName = nameParts.length > 1 ? nameParts[0] : '';
  const lastName  = nameParts.length > 1 ? nameParts.slice(1).join(' ') : nameParts[0];

  // First non-empty line = subject line, rest = body
  const lines = letter.split('\n');
  const firstIdx = lines.findIndex(l => l.trim());
  const subjectLine = firstIdx >= 0 ? escHtml(lines[firstIdx].trim()) : '';
  const bodyLines = lines.slice(firstIdx + 1);

  const bodyParagraphs = bodyLines
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .map(l => `<p>${escHtml(l).replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/\*([^*]+)\*/g,'<em>$1</em>')}</p>`)
    .join('\n');

  const dateStr = new Date().toLocaleDateString('de-DE',{day:'2-digit',month:'long',year:'numeric'});
  const jobTitle = escHtml(job.title || '');

  const html = `<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"><style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Helvetica Neue',Arial,sans-serif;font-size:10.5pt;color:#1a1a1a;background:#fff}
    .header{display:flex;align-items:flex-start;padding:1.5cm 1.8cm 1cm 1.8cm;gap:18px}
    .badge{background:${accent};color:#fff;font-size:7.5pt;font-weight:700;letter-spacing:.5px;
           padding:8px 7px;line-height:1.4;text-align:center;flex-shrink:0;min-width:46px;border-radius:2px}
    .name-first{font-size:26pt;font-weight:300;line-height:1;color:#1a1a1a}
    .name-last{font-size:26pt;font-weight:800;line-height:1;margin-bottom:9px;color:#1a1a1a}
    .title-pill{display:inline-flex;align-items:center;gap:6px;border:1.5px solid ${accent};
                border-radius:20px;padding:3px 13px;font-size:7.5pt;font-weight:700;
                color:${accent};letter-spacing:1.2px;text-transform:uppercase}
    .title-pill::after{content:'\\2022';font-size:10pt}
    .divider{height:1px;background:#d8d8d8}
    .body{padding:.9cm 1.8cm 2.8cm 1.8cm;line-height:1.65}
    .date{text-align:right;color:#555;font-size:9pt;margin-bottom:1.1em}
    .subject{font-weight:700;font-size:10.5pt;margin-bottom:1.2em}
    p{margin:0 0 .8em 0;text-align:justify}
    .footer{position:fixed;bottom:0;left:0;right:0;background:${accent};color:#fff;
            padding:8px 1.8cm;font-size:8pt;display:flex;justify-content:space-between;align-items:center}
  </style></head><body>
  <div class="header">
    <div class="badge">${badgeText}</div>
    <div>
      ${firstName ? `<div class="name-first">${escHtml(firstName)}</div>` : ''}
      <div class="name-last">${escHtml(lastName)}</div>
      ${jobTitle ? `<div class="title-pill">${jobTitle}</div>` : ''}
    </div>
  </div>
  <div class="divider"></div>
  <div class="body">
    <div class="date">${dateStr}</div>
    ${subjectLine ? `<div class="subject">${subjectLine}</div>` : ''}
    ${bodyParagraphs}
  </div>
  <div class="footer">
    <span>${escHtml(profile.email||'')}</span>
    <span>${escHtml(profile.phone||'')}</span>
    <span>${escHtml(profile.location||'')}</span>
  </div>
  </body></html>`;

  let b2 = null;
  try {
    b2 = await pp.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox'] });
    const p2 = await b2.newPage();
    await p2.setContent(html, { waitUntil: 'networkidle0', timeout: 15000 });
    await p2.pdf({ path: pdfPath, format: 'A4', printBackground: true,
      margin: { top:'0', bottom:'0', left:'0', right:'0' } });
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

        // --- file inputs: only upload to clearly matching fields ---
        if (info.type === 'file') {
          const isLetter = /anschreiben|cover|motivat|letter/i.test(h);
          const isCv = /lebenslauf|cv|resume|bewerbung/i.test(h);
          const uploadPath = isLetter ? letterPdfPath : isCv ? cvPath : null;
          if (uploadPath) {
            try {
              await el.uploadFile(uploadPath);
              steps.push(`?? Datei hochgeladen: ${path.basename(uploadPath)}`); filled++;
            } catch(ue) {
              try {
                const [fc] = await Promise.all([page.waitForFileChooser({timeout:3000}), el.click()]);
                await fc.accept([uploadPath]);
                steps.push(`?? Datei via Chooser: ${path.basename(uploadPath)}`); filled++;
              } catch(ue2) { steps.push(`?? Datei-Upload ï¿½bersprungen`); }
            }
          }
          // Unbekannte Datei-Felder werden vom KI-Agenten via upload_doc/upload_cv/upload_letter behandelt
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
        else if (/salary|gehalt|verguetung|vergütung|lohn|wunschgehalt|desired.*salary|expected.*salary|gehaltsvorstellung/i.test(h)) {
          // Use range if available, otherwise single value
          if (/min|von|from|ab/i.test(h) && profile.salaryMin) { value=String(profile.salaryMin); fieldName='Gehalt (Min)'; }
          else if (/max|bis|to/i.test(h) && profile.salaryMax) { value=String(profile.salaryMax); fieldName='Gehalt (Max)'; }
          else if (profile.salary) { value=String(profile.salary); fieldName='Gehaltsvorstellung'; }
          else if (profile.salaryMin && profile.salaryMax) { value=String(Math.round((profile.salaryMin+profile.salaryMax)/2)); fieldName='Gehaltsvorstellung'; }
        }
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
          steps.push(`? ${fieldName} eingetragen`);
          filled++;
        }
      } catch(fe) { /* skip broken field */ }
    }
    steps.push(`?? ${filled} Felder ausgefï¿½llt`);
  } catch(e) { steps.push(`?? Formular-Fehler: ${e.message}`); }
  return steps;
}

// -- VISION AI AGENT ------------------------------------------------------
// DOM-only fallback: click Next/Weiter/Continue/Submit button
async function tryAutoNavigate(page) {
  return page.evaluate(() => {
    const all = [...document.querySelectorAll('button,[role=button],input[type=submit],a[role=button]')];
    const vis = all.filter(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !b.disabled; });
    // Priority 1: explicit Next/Weiter/Continue/Fortfahren
    const nxt = vis.find(b => /^(next|weiter|continue|fortfahren|vor|proceed|nï¿½chste|go|los)[\s>]*$/i.test((b.textContent||'').trim()));
    if (nxt) { nxt.scrollIntoView({behavior:'instant',block:'center'}); nxt.click(); return 'Weiter-Button: "' + nxt.textContent.trim().slice(0,30) + '"'; }
    // Priority 2: button containing Next text alongside other words
    const nxt2 = vis.find(b => /\b(next|weiter|continue|fortfahren|proceed)\b/i.test(b.textContent||''));
    if (nxt2) { nxt2.scrollIntoView({behavior:'instant',block:'center'}); nxt2.click(); return 'Weiter: "' + nxt2.textContent.trim().slice(0,30) + '"'; }
    // Priority 3: Submit/Apply/Bewerben
    const sub = vis.find(b => /submit|absenden|apply|senden|bewerben|bewerbung\s+absenden/i.test((b.textContent||'') + (b.value||'')));
    if (sub) { sub.scrollIntoView({behavior:'instant',block:'center'}); sub.click(); return 'Submit: "' + sub.textContent.trim().slice(0,30) + '"'; }
    return null;
  }).catch(() => null);
}

// DOM-only: detect if page shows success / completion
async function detectPageState(page) {
  return page.evaluate(() => {
    const body = document.body?.innerText || '';
    if (/danke|thank\s+you|erfolgreich|success|bewerbung.*eingegangen|application.*received|submitted/i.test(body)) return 'done';
    if (/login|sign\s+in|passwort|password|captcha|verify/i.test(body.slice(0, 2000))) return 'login';
    // count visible unfilled text inputs
    const empty = [...document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=file]):not([type=checkbox]):not([type=radio]),textarea')]
      .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && !el.disabled && !el.readOnly && !el.value; }).length;
    const filled = [...document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=file]):not([type=checkbox]):not([type=radio]),textarea')]
      .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && !el.disabled && !el.readOnly && el.value; }).length;
    return { emptyInputs: empty, filledInputs: filled };
  }).catch(() => null);
}

async function askVisionAI(screenshotBase64, context, logCallback = null) {
  if (!screenshotBase64) {
    return { action: 'fill_form', target: '', value: '', reason: 'Kein Screenshot' };
  }
  const { job, profile, history, cvPath, letterPdfPath, extraInstruction, extraDocs, page } = context;
  const prompt = `Browser-Bewerbungsassistent. Analysiere Screenshot, waehle EINE Aktion.
PROFIL: ${profile.name||''} | ${profile.email||''} | ${profile.phone||''} | ${profile.location||''}
JOB: ${job.title||''} @ ${job.company||''}
DATEIEN: CV=${cvPath?'OK':'fehlt'} Brief=${letterPdfPath?'OK':'fehlt'}${(extraDocs&&extraDocs.length)?' Docs='+extraDocs.length:''}
VERLAUF: ${history.slice(-3).join('->')||'Start'}${extraInstruction?'\nPRIORITAET: '+extraInstruction:''}

Antwort NUR als JSON: {"action":"...","target":"...","value":"...","reason":"..."}

Aktionen: fill_form|click|type|upload_cv|upload_letter|upload_doc|scroll_down|next|submit|wait|need_manual|done
Regeln: Login/CAPTCHA->need_manual. Danke/Erfolgreich->done. Review+Absenden->submit. Bewerben-Button sichtbar->click. Formularfelder leer->fill_form.`;

  // â”€â”€ Ollama vision path â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // ── Ollama vision path ─────────────────────────────────────────────
  if (CONFIG.AI_MODE === 'ollama') {
    const visionModel = CONFIG.OLLAMA_VISION_MODEL || 'llava:latest';
    try {
      console.log(`[VisionAI] Ollama DOM+qwen (${CONFIG.OLLAMA_MODEL})...`);

      // Step 1: Extract page content via DOM (reliable, no hallucination)
      let pageDescription = '';
      if (page) {
        try {
          pageDescription = await page.evaluate(() => {
            const title = document.title || '';
            const url = location.href;
            // Visible buttons
            const btns = [...document.querySelectorAll('button,[role=button],input[type=submit],input[type=button],a[class*=btn],a[class*=button]')]
              .filter(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top < window.innerHeight + 200; })
              .map(b => (b.textContent||b.value||b.getAttribute('aria-label')||'').trim().replace(/\s+/g,' '))
              .filter(t => t.length > 0 && t.length < 80)
              .slice(0, 20);
            // Visible form fields
            const fields = [...document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]),select,textarea')]
              .filter(f => { const r = f.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
              .map(f => {
                const lbl = f.getAttribute('placeholder') || f.getAttribute('aria-label') ||
                  document.querySelector(`label[for="${f.id}"]`)?.textContent?.trim() || f.name || f.type;
                return `${f.tagName.toLowerCase()}[${f.type||'text'}]: ${lbl||'unlabeled'} (value: ${(f.value||'').slice(0,40)||'empty'})`;
              }).slice(0, 30);
            // Main visible text (headings + short paragraphs)
            const headings = [...document.querySelectorAll('h1,h2,h3,[class*=title],[class*=heading]')]
              .filter(h => { const r = h.getBoundingClientRect(); return r.width > 0 && r.top < window.innerHeight + 400; })
              .map(h => h.textContent.trim().replace(/\s+/g,' ').slice(0,100))
              .filter(t => t).slice(0, 10);
            // Check for success/thank you messages
            const bodyText = (document.body?.innerText||'').slice(0,3000);
            const hasCookie = !!document.querySelector('[class*=cookie],[class*=consent],[id*=cookie],[id*=consent],[id*=gdpr]');
            return JSON.stringify({ title, url, btns, fields, headings, hasCookie, bodyText: bodyText.slice(0,1500) });
          }).catch(() => null);
          if (pageDescription) {
            const d = JSON.parse(pageDescription);
            const parts = [
              `PAGE: ${d.title} | ${d.url}`,
              d.headings.length ? `HEADINGS: ${d.headings.join(' | ')}` : '',
              d.btns.length ? `BUTTONS: ${d.btns.join(', ')}` : 'BUTTONS: none',
              d.fields.length ? `FORM FIELDS:\n${d.fields.join('\n')}` : 'FORM FIELDS: none',
              d.hasCookie ? 'COOKIE BANNER: visible' : '',
              `PAGE TEXT (excerpt): ${d.bodyText.slice(0,600)}`,
            ].filter(Boolean).join('\n');
            pageDescription = parts;
            if (logCallback) logCallback(`[Vision] DOM extrahiert: ${d.btns.length} Buttons, ${d.fields.length} Felder`);
          }
        } catch(domErr) {
          pageDescription = '';
          console.log('[VisionAI] DOM-Fehler:', domErr.message);
        }
      }

      // Step 1b: If DOM empty, fall back to llava (with hallucination guard)
      if (!pageDescription) {
        if (logCallback) logCallback(`[Vision] DOM leer -> ${visionModel} Fallback...`);
        try {
          const descPrompt = 'Describe this browser screenshot in detail. List ALL visible buttons, form fields, links, and text. What is the exact page title and URL shown? What is the purpose of this specific page?';
          const raw = await callOllamaVision(screenshotBase64, descPrompt);
          // Hallucination guard: reject generic descriptions
          const isHallucination = /home.*about.*services.*contact|about us.*services.*contact.*blog/i.test(raw);
          if (!isHallucination) {
            pageDescription = raw;
            if (logCallback) logCallback(`[Vision-Raw] ${raw.slice(0, 300)}`);
          } else {
            if (logCallback) logCallback('[Vision] llava halluziniert - ignoriert, nutze DOM-Fallback');
            pageDescription = 'Page content could not be determined. Assume form fields may be present.';
          }
        } catch(e) {
          pageDescription = 'Could not capture page state.';
        }
      }

      // Step 2: qwen decides action based on DOM description
      if (logCallback) logCallback(`[Vision] ${CONFIG.OLLAMA_MODEL} entscheidet Aktion...`);
      const decisionPrompt = `You are a browser automation assistant helping apply for jobs. Analyze the page content and choose ONE action.

PAGE CONTENT:
${pageDescription.slice(0, 1200)}

CONTEXT:
- Applicant: ${profile.name||''} | ${profile.email||''} | ${profile.phone||''}
- Job: ${job.title||''} at ${job.company||''}
- Files: CV=${cvPath?'available':'missing'} CoverLetter=${letterPdfPath?'available':'missing'}
- Previous actions: ${history.slice(-4).join(' -> ')||'none'}
${extraInstruction ? '- PRIORITY INSTRUCTION: ' + extraInstruction : ''}

Output ONLY a JSON object (no markdown, no explanation):
- Cookie/consent banner visible -> {"action":"click","target":"EXACT button text","value":"","reason":"dismiss cookie"}
- Apply/Bewerben button visible -> {"action":"click","target":"EXACT button text","value":"","reason":"apply button"}
- Empty form fields visible -> {"action":"fill_form","target":"","value":"","reason":"fill form fields"}
- Next/Weiter button after filling -> {"action":"next","target":"","value":"","reason":"next step"}
- Submit/Absenden button, form filled -> {"action":"submit","target":"","value":"","reason":"submit application"}
- Login page or CAPTCHA -> {"action":"need_manual","target":"","value":"","reason":"login/captcha needed"}
- Thank you / success page -> {"action":"done","target":"","value":"","reason":"submitted"}
- Need to scroll for more content -> {"action":"scroll_down","target":"","value":"","reason":"content below"}

IMPORTANT: Use EXACT text from PAGE CONTENT for target field.
/no_think`;

      // qwen3/thinking models output <think>...</think> before JSON — strip it, allow enough tokens
      const jsonRaw = await callOllama([{role:'user', content: decisionPrompt}], 600);
      const jsonText = jsonRaw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      console.log('[VisionAI] Entscheidung:', jsonText.slice(0,200));
      const m = jsonText.match(/\{[\s\S]*?\}/);
      if (m) {
        try {
          const parsed = JSON.parse(m[0]);
          if (parsed.action) {
            console.log('[VisionAI] OK:', parsed.action, parsed.reason||'');
            if (logCallback) logCallback(`[Vision-OK] ${parsed.action}: ${parsed.reason||''}`);
            return parsed;
          }
        } catch(je) {}
      }
      if (logCallback) logCallback('[Vision-Fehler] Kein JSON - DOM-Modus wird aktiviert');
      return { action: '__no_json__', target: '', value: '', reason: 'Kein JSON vom Textmodell' };
    } catch(e) {
      console.log('[VisionAI] Ollama Fehler:', e.message);
      if (logCallback) logCallback(`[Vision-Fehler] ${e.message.slice(0,120)}`);
      return { action: '__no_json__', target: '', value: '', reason: 'Ollama-Fehler: ' + e.message.slice(0,80) };
    }
  }

  // â”€â”€ Anthropic path â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (!CONFIG.ANTHROPIC_API_KEY) {
    return { action: 'fill_form', target: '', value: '', reason: 'Kein Anthropic API-Key' };
  }
  try {
    const visionModel = MODELS.vision;
    const res = await fetchUrl('https://api.anthropic.com/v1/messages', {
      method: 'POST', timeout: 35000,
      headers: { 'Content-Type': 'application/json', 'x-api-key': CONFIG.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: visionModel, max_tokens: 300,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: screenshotBase64 } },
          { type: 'text', text: prompt },
        ]}],
      }),
    });
    const d = JSON.parse(res.body);
    if (d.error) { console.log('[VisionAI]', d.error.message); return { action: 'fill_form', target: '', value: '', reason: 'KI-Fehler: ' + d.error.type }; }
    const usage = d.usage || {};
    if (usage.input_tokens || usage.output_tokens) trackCost('VisionAI', visionModel, usage.input_tokens||0, usage.output_tokens||0);
    const text = (d.content||[]).map(b => b.text||'').join('');
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      const parsed = JSON.parse(m[0]);
      if (parsed.action) return parsed;
    }
    console.log('[VisionAI] Ungueltige Antwort:', text.slice(0,200));
  } catch(e) { console.log('[VisionAI]', e.message); }
  return { action: 'fill_form', target: '', value: '', reason: 'KI nicht verfuegbar - direkt ausfuellen' };
}

async function executeAIAction(page, decision, profile, letter, cvPath, letterPdfPath, extraDocs) {
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
    return [`${clicked ? '?' : '??'} Klick: "${decision.target||''}"`];
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
    return [`${typed?'?':'??'} "${decision.target||''}": "${String(decision.value||'').slice(0,50)}"`];
  }

  if (a === 'upload_cv' || a === 'upload_letter') {
    const filePath = a === 'upload_letter' ? (letterPdfPath||cvPath) : (cvPath||letterPdfPath);
    if (!filePath) return ['?? Keine Datei fï¿½r Upload verfï¿½gbar'];
    const matchPat = a === 'upload_letter' ? /anschreiben|cover|motivat|letter/i : /lebenslauf|cv|resume|bewerbung/i;
    const inputs = await page.$$('input[type=file]');
    // Zuerst passendes Feld suchen
    for (const inp of inputs) {
      try {
        const h = await inp.evaluate(el => [
          el.name, el.id, el.getAttribute('aria-label'), el.getAttribute('placeholder'),
          ...[...document.querySelectorAll(`label[for="${el.id}"]`)].map(l => l.textContent)
        ].filter(Boolean).join(' ').toLowerCase());
        if (matchPat.test(h)) { await inp.uploadFile(filePath); return [`?? Hochgeladen: ${path.basename(filePath)}`]; }
      } catch(e) {}
    }
    // Fallback: erstes verfï¿½gbares Feld
    for (const inp of inputs) {
      try { await inp.uploadFile(filePath); return [`?? Hochgeladen: ${path.basename(filePath)}`]; } catch(e) {}
    }
    return ['?? Kein Datei-Input gefunden'];
  }

  if (a === 'upload_doc') {
    const docs = extraDocs || [];
    if (!docs.length) return ['?? Keine weiteren Dokumente vorhanden'];
    const target = (decision.target||'').toLowerCase();
    const docPath = docs.find(p => target && path.basename(p).toLowerCase().includes(target))
      || docs.find(p => /zeugnis/i.test(path.basename(p)) && /zeugnis/i.test(target))
      || docs.find(p => /certif|zertif/i.test(path.basename(p)) && /certif|zertif/i.test(target))
      || docs[0];
    const inputs = await page.$$('input[type=file]');
    for (const inp of inputs) {
      try { await inp.uploadFile(docPath); return [`?? Dokument hochgeladen: ${path.basename(docPath)}`]; } catch(e) {}
    }
    return ['?? Kein Datei-Input fï¿½r Dokument gefunden'];
  }

  if (a === 'scroll_down') {
    await page.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 0.75)));
    await new Promise(r => setTimeout(r, 500));
    return ['?? Gescrollt'];
  }

  if (a === 'next') {
    const clicked = await page.evaluate(() => {
      const vis = [...document.querySelectorAll('button,[role=button],input[type=submit]')].filter(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !b.disabled; });
      const btn = vis.find(b => /next|weiter|continue|fortfahren|nï¿½chste/i.test((b.textContent||'')+(b.getAttribute('aria-label')||'')+(b.value||'')));
      if (btn) { btn.scrollIntoView({behavior:'instant',block:'center'}); btn.click(); return btn.textContent.trim().slice(0,50)||'Weiter'; }
      return null;
    }).catch(() => null);
    return [clicked ? `?? ${clicked}` : '?? Kein Weiter-Button gefunden'];
  }

  if (a === 'wait') {
    await new Promise(r => setTimeout(r, 3000));
    return ['? Gewartet...'];
  }

  return [];
}

async function autoBrowserApply(jobId) {
  // Only 1 bot at a time — Chromium locks the profile directory
  const activeSessions = [...autoSessions.values()].filter(s => !['submitted','closed','error'].includes(s.status));
  if (activeSessions.length >= 1) {
    throw new Error('Ein Bot läuft bereits. Bitte erst abschliessen oder schliessen bevor ein neuer gestartet wird.');
  }
  const sessionId = 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2,6);
  const job = getJob(jobId);
  if (!job) throw new Error('Job nicht gefunden');
  const profile = loadProfile();
  const session = {
    jobId, status:'starting',
    steps:['KI-Browser-Bewerbung gestartet...'],
    screenshot:null, url:job.url,
    title:job.title, company:job.company,
    browser:null, page:null, submitSelector:null, letter:'',
  };
  autoSessions.set(sessionId, session);

  (async () => {
    try {
      const pp = getPuppeteer();

      // 1. KI-Anschreiben
      session.steps.push('?? Erstelle KI-Anschreiben...');
      const lang = detectLanguage((job.title||'') + ' ' + (job.desc||''));
      const letter = await generateCoverLetter(job, profile, lang);
      session.letter = letter;
      session.steps.push('? Anschreiben (' + (lang==='en'?'Englisch':'Deutsch') + ')');

      // 2. Anschreiben PDF
      let letterPdfPath = null;
      try {
        session.steps.push('?? Anschreiben-PDF...');
        letterPdfPath = await generateLetterPDF(letter, profile, job);
        session.steps.push('? Anschreiben.pdf erstellt');
      } catch(pe) { session.steps.push('?? PDF: ' + pe.message); }

      // 3. Lebenslauf finden
      const uploads = listUploads().filter(f => !f.name.startsWith('_anschreiben_'));
      const cvFile = uploads.find(f => /lebenslauf|cv|resume/i.test(f.name)) || uploads.find(f => /\.pdf$/i.test(f.name)) || uploads[0];
      const cvPath = cvFile ? path.join(UPLOADS_DIR, cvFile.name) : null;
      session.steps.push(cvPath ? `?? Lebenslauf: ${cvFile.name}` : '?? Kein Lebenslauf ï¿½ bitte hochladen');
      const extraDocs = uploads.filter(f => f !== cvFile).map(f => path.join(UPLOADS_DIR, f.name));
      session.extraDocs = extraDocs;
      if (extraDocs.length) session.steps.push(`?? Weitere Dokumente: ${extraDocs.map(p => path.basename(p)).join(', ')}`);

      // 4. Browser starten
      session.status = 'launching';
      session.steps.push('Oeffne Browser...');
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

      // Helper: check if current page is a login page and pause if so
      async function checkLoginAndPause(label) {
        const curUrl = page.url();
        const isLogin = /login|signin|sign-in|anmeld|auth\/|\/account\/login/i.test(curUrl)
          || await page.evaluate(() => {
              const hasPwField = !!document.querySelector('input[type=password]');
              const hasLoginText = /anmeld|einloggen|login|sign.?in/i.test(document.body?.innerText?.slice(0,2000)||'');
              return hasPwField && hasLoginText;
            }).catch(() => false);
        if (isLogin) {
          session.status = 'waiting_manual';
          session.steps.push('');
          session.steps.push(`?? ${label} ï¿½ Login erforderlich`);
          session.steps.push('?? Im Browser einloggen, dann "?? Fortsetzen" klicken');
          while (session.status === 'waiting_manual') {
            await new Promise(r => setTimeout(r, 600));
            if (!autoSessions.has(sessionId)) return true; // closed
          }
          session.steps.push('?? Login erkannt ï¿½ weiter...');
          session.status = 'filling';
          return true; // was login
        }
        return false;
      }

      // 5. Zur Stellenanzeige navigieren
      session.status = 'navigating';
      session.steps.push('?? ï¿½ffne Stellenanzeige...');
      try { await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 30000 }); }
      catch(ne) { if (!ne.message.includes('net::ERR_ABORTED')) throw ne; }
      await new Promise(r => setTimeout(r, 2500));

      // Check for immediate login redirect on page load
      if (await checkLoginAndPause('Seite erfordert Login')) {
        // Re-navigate to job after login
        try { await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 30000 }); }
        catch(ne) { if (!ne.message.includes('net::ERR_ABORTED')) throw ne; }
        await new Promise(r => setTimeout(r, 2000));
      }

      // 5b. Heise Jobs: "Originalanzeige" button ? redirect to company site
      if (/jobs\.heise\.de/i.test(job.url)) {
        session.steps.push('?? Heise: suche Originalanzeige-Button...');
        const beforeUrl = page.url();
        // Listen for new tab opened by Originalanzeige link
        let originalTabPage = null;
        const newTabPromise = new Promise(resolve => {
          browser.once('targetcreated', async target => {
            try {
              if (target.type() === 'page') {
                const np = await target.page();
                if (np) { await new Promise(r => setTimeout(r, 2000)); resolve(np); }
              }
            } catch(e) { resolve(null); }
          });
          // Timeout after 6s
          setTimeout(() => resolve(null), 6000);
        });

        const originalClicked = await page.evaluate(() => {
          const candidates = [...document.querySelectorAll('a,button,[role=button]')];
          const btn = candidates.find(el => {
            const t = (el.textContent||'').toLowerCase().trim();
            const lbl = (el.getAttribute('aria-label')||'').toLowerCase();
            return /originalanzeige|original.?anzeige|zur.?anzeige|zur.?original|external.?apply|company.?site|beim.?unternehmen/i.test(t + lbl);
          });
          if (btn) { btn.scrollIntoView({behavior:'instant',block:'center'}); btn.click(); return btn.textContent.trim().slice(0,60); }
          return null;
        }).catch(() => null);

        if (originalClicked) {
          session.steps.push(`? Geklickt: "${originalClicked}" ï¿½ warte auf Unternehmensseite...`);
          const newTab = await newTabPromise;
          if (newTab && newTab.url() !== 'about:blank') {
            activePage = newTab;
            await newTab.bringToFront().catch(() => {});
            session.url = newTab.url();
            session.steps.push(`?? Unternehmensseite: ${new URL(newTab.url()).hostname}`);
            // Skip the standard apply-button step, go directly to KI loop
            session.status = 'filling';
            goto_ailoop: {
              // Jump past apply-button block by setting a flag
              session._skippedApplyBtn = true;
            }
          } else {
            // Same tab navigation
            await new Promise(r => setTimeout(r, 2000));
            if (page.url() !== beforeUrl) {
              session.url = page.url();
              session.steps.push(`?? Weitergeleitet: ${new URL(page.url()).hostname}`);
              session._skippedApplyBtn = true;
            }
          }
        } else {
          session.steps.push('?? Kein Originalanzeige-Button ï¿½ versuche direkt zu bewerben...');
        }
      }

      // 6. Bewerben-Button klicken (explizit, vor KI-Loop) ï¿½ auï¿½er wenn Heise?Originalanzeige bereits navigiert hat
      if (!session._skippedApplyBtn) {
      session.steps.push('?? Suche Bewerben-Button...');
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
        session.steps.push(`? Geklickt: "${applyClicked}"`);
        await new Promise(r => setTimeout(r, 3000));
        // Check if apply button redirected to login
        if (await checkLoginAndPause('Bewerben erfordert Login')) {
          // Re-navigate to job and retry apply button after login
          try { await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 30000 }); }
          catch(ne) { if (!ne.message.includes('net::ERR_ABORTED')) throw ne; }
          await new Promise(r => setTimeout(r, 2000));
        }
        session.screenshot = await page.screenshot({ encoding:'base64', type:'jpeg', quality:65 }).catch(()=>null);
        session.url = page.url();
      } else {
        session.steps.push('?? Kein Bewerben-Button ï¿½ KI sucht weiter...');
      }
      } // end if (!session._skippedApplyBtn)

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
      let visionFailCount = 0; // consecutive VisionAI auth/network failures
      const DOM_ONLY_THRESHOLD = 2; // switch to DOM-only after this many failures

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
              session.steps.push(`?? Neuer Tab erkannt: ${new URL(u).hostname}`);
            }
          }
        } catch(e) {}
      });

      let _lastUrl = '';
      let _stuckCount = 0; // iterations with same URL + same action

      for (let iter = 0; iter < MAX_ITER; iter++) {
        // Warte auf Seitenstabilisierung
        await new Promise(r => setTimeout(r, 1800));

        // Immer den neuesten aktiven Tab verwenden
        const currentPage = await getActivePage();
        if (currentPage !== activePage) {
          activePage = currentPage;
          session.steps.push(`🔀 Wechsel zu: ${new URL(currentPage.url()).hostname}`);
          _stuckCount = 0;
        }
        session.page = activePage;

        // Cookie-Banner automatisch wegklicken (vor Screenshot)
        try {
          const cookieClicked = await activePage.evaluate(() => {
            const patterns = /ablehnen|decline|reject|only necessary|nur notwendige|alle ablehnen|reject all|disagree|nein danke|no thanks/i;
            const acceptFallback = /akzeptieren|accept all|alle akzeptieren|agree|zustimmen/i;
            const btns = [...document.querySelectorAll('button,a,[role=button]')].filter(b => {
              const r = b.getBoundingClientRect();
              return r.width > 0 && r.height > 0 && r.top < window.innerHeight;
            });
            // Prefer reject/decline
            const deny = btns.find(b => patterns.test(b.textContent.trim()));
            if (deny) { deny.click(); return 'Abgelehnt: ' + deny.textContent.trim().slice(0,40); }
            // Check if there's a visible consent overlay
            const hasOverlay = !!document.querySelector('[class*=cookie],[class*=consent],[id*=cookie],[id*=consent],[id*=gdpr],[class*=gdpr],[class*=privacy-banner]');
            if (hasOverlay) {
              const acc = btns.find(b => acceptFallback.test(b.textContent.trim()));
              if (acc) { acc.click(); return 'Akzeptiert: ' + acc.textContent.trim().slice(0,40); }
            }
            return null;
          }).catch(() => null);
          if (cookieClicked) {
            session.steps.push(`[Cookie] ${cookieClicked}`);
            await new Promise(r => setTimeout(r, 800));
          }
        } catch(e) {}

        // Screenshot machen
        const sc = await activePage.screenshot({ encoding:'base64', type:'jpeg', quality:72 }).catch(() => null);
        if (sc) session.screenshot = sc;
        session.url = activePage.url();

        // -- DOM-only mode when VisionAI is unavailable ------------------
        if (visionFailCount >= DOM_ONLY_THRESHOLD) {
          // Check page state first
          const state = await detectPageState(activePage);
          if (state === 'done') {
            session.status = 'submitted';
            session.steps.push('Bewerbung erfolgreich abgesendet!');
            updateJob(session.jobId, { status:'applied', applied_at: new Date().toISOString() });
            break;
          }
          if (state === 'login') {
            session.status = 'waiting_manual';
            session.steps.push('[DOM] Login/CAPTCHA erkannt ï¿½ bitte manuell erledigen');
            session.steps.push('Dann "Fortsetzen" klicken');
            while (session.status === 'waiting_manual') {
              await new Promise(r => setTimeout(r, 600));
              if (!autoSessions.has(sessionId)) return;
            }
            visionFailCount = 0; // reset after manual intervention
            continue;
          }

          // Fill form fields
          const fillSteps = await autoFillForm(activePage, profile, letter, cvPath, letterPdfPath);
          session.steps.push(...fillSteps.filter(Boolean));
          await new Promise(r => setTimeout(r, 800));

          // Try to navigate forward
          const extraInstr = (session.pendingInstructions && session.pendingInstructions.length)
            ? session.pendingInstructions.splice(0).join(' | ') : null;
          if (extraInstr) session.steps.push('[Anweisung] ' + extraInstr);

          const navResult = await tryAutoNavigate(activePage);
          if (navResult) {
            session.steps.push('[DOM] Geklickt: ' + navResult);
            actionHistory.push('next');
          } else {
            // No next button found ï¿½ scroll down and look again
            await activePage.evaluate(() => window.scrollBy(0, window.innerHeight * 0.7)).catch(() => {});
            await new Promise(r => setTimeout(r, 600));
            const navResult2 = await tryAutoNavigate(activePage);
            if (navResult2) {
              session.steps.push('[DOM] Geklickt (nach Scroll): ' + navResult2);
              actionHistory.push('next');
            } else {
              session.steps.push('[DOM] Kein Weiter-Button gefunden');
              // After 3 consecutive "no button" situations, ask for manual help
              const noNavCount = actionHistory.slice(-3).filter(a => a === 'fill_form').length;
              if (noNavCount >= 3) {
                session.status = 'waiting_manual';
                session.steps.push('Bitte im Browser weiterklicken, dann "Fortsetzen"');
                actionHistory.length = 0;
                while (session.status === 'waiting_manual') {
                  await new Promise(r => setTimeout(r, 600));
                  if (!autoSessions.has(sessionId)) return;
                }
                visionFailCount = 0;
              } else {
                actionHistory.push('fill_form');
              }
            }
          }
          continue; // skip normal VisionAI path
        }

        // Claude fragt: was jetzt?
        const extraInstr = (session.pendingInstructions && session.pendingInstructions.length)
          ? session.pendingInstructions.splice(0).join(' | ') : null;
        const decision = await askVisionAI(sc, { job, profile, history: actionHistory, cvPath, letterPdfPath, extraInstruction: extraInstr, extraDocs: session.extraDocs||[], page: activePage }, (msg) => {
          session.steps.push(msg);
          if (msg.startsWith('[Vision-Raw]')) session.visionRaw = msg.slice(12).trim();
        });
        const label = decision.reason || decision.action;
        session.steps.push(`[${iter+1}] ${label}`);

        // Track VisionAI failures to switch to DOM-only mode
        const isVisionFail = decision.action === '__no_json__'
          || (decision.reason && /authentication_error|auth_error|invalid_api_key|overloaded|rate_limit/i.test(decision.reason));
        if (isVisionFail) {
          decision.action = 'fill_form'; // safe fallback
          visionFailCount++;
          if (visionFailCount >= DOM_ONLY_THRESHOLD) {
            session.steps.push('[Info] Vision wiederholt fehlgeschlagen - aktiviere DOM-Modus');
            actionHistory.push('fill_form');
            continue;
          }
        } else if (decision.action !== 'fill_form' || !decision.reason?.includes('Fehler')) {
          visionFailCount = 0; // reset on success
        }
        actionHistory.push(decision.action);

        // -- Terminal States ---------------------------------------------
        if (decision.action === 'submit') {
          // Submit-Button ID merken fï¿½r spï¿½teren Klick
          session.submitSelector = await activePage.evaluate(() => {
            const vis = [...document.querySelectorAll('button,[role=button],input[type=submit]')].filter(b => { const r = b.getBoundingClientRect(); return r.width>0&&r.height>0&&!b.disabled; });
            const btn = vis.find(b => /submit|absenden|send|apply|senden|bewerben/i.test((b.textContent||'')+(b.value||'')+(b.getAttribute('aria-label')||'')));
            if (btn) { if (!btn.id) btn.id = '__jh_submit_' + Date.now(); return '#' + btn.id; }
            return null;
          }).catch(() => null);
          session.status = 'ready';
          session.steps.push('');
          session.steps.push('? Formular ausgefï¿½llt ï¿½ bitte prï¿½fen!');
          session.steps.push('?? Im Browser alles kontrollieren');
          session.steps.push('?? Dann hier "Jetzt absenden" klicken');
          break;
        }

        if (decision.action === 'done') {
          session.status = 'submitted';
          session.steps.push('?? Bewerbung erfolgreich abgesendet!');
          updateJob(session.jobId, { status:'applied', applied_at: new Date().toISOString() });
          break;
        }

        if (decision.action === 'need_manual') {
          session.status = 'waiting_manual';
          session.steps.push('');
          session.steps.push('?? Manuelle Hilfe nï¿½tig!');
          session.steps.push('?? Im Browser erledigen (Login / CAPTCHA / Auswahl)');
          session.steps.push('?? Dann hier "?? Fortsetzen" klicken');
          // Warte bis Nutzer "continue" klickt
          while (session.status === 'waiting_manual') {
            await new Promise(r => setTimeout(r, 600));
            if (!autoSessions.has(sessionId)) return;
          }
          session.steps.push('?? Fortgesetzt nach manueller Hilfe');
          continue;
        }

        // -- Aktion ausfï¿½hren --------------------------------------------
        const actionSteps = await executeAIAction(activePage, decision, profile, letter, cvPath, letterPdfPath, session.extraDocs||[]);
        session.steps.push(...actionSteps.filter(Boolean));

        // Schleifenerkennung: URL hat sich nach N gleichen Aktionen nicht geaendert
        const _curUrl = activePage.url();
        if (_curUrl !== _lastUrl) { _stuckCount = 0; _lastUrl = _curUrl; }
        else if (decision.action === 'click' || decision.action === 'next') { _stuckCount++; }

        if (_stuckCount >= 4 && decision.action !== 'wait') {
          _stuckCount = 0;
          // Vor manual: einmal DOM-Fill + Weiter-Versuch
          session.steps.push('[Info] Seite aendert sich nicht - versuche DOM-Fallback...');
          const _fb = await autoFillForm(activePage, profile, letter, cvPath, letterPdfPath);
          session.steps.push(..._fb.filter(Boolean));
          const _nav = await tryAutoNavigate(activePage);
          if (_nav) {
            session.steps.push('[DOM-Fallback] Geklickt: ' + _nav);
            _stuckCount = 0;
          } else {
            session.status = 'waiting_manual';
            session.steps.push('');
            session.steps.push('Komme nicht weiter - bitte im Browser helfen');
            session.steps.push('Dann "Fortsetzen" klicken');
            actionHistory.length = 0;
            while (session.status === 'waiting_manual') {
              await new Promise(r => setTimeout(r, 600));
              if (!autoSessions.has(sessionId)) return;
            }
            session.steps.push('Fortgesetzt...');
          }
        }
      }

      // Wenn MAX_ITER erreicht ohne Abschluss
      if (session.status === 'filling') {
        session.status = 'ready';
        session.steps.push('');
        session.steps.push('?? Maximale Schritte erreicht ï¿½ bitte manuell prï¿½fen');
        session.steps.push('?? Dann "Jetzt absenden" klicken');
      }

      browser.on('disconnected', () => {
        if (['ready','waiting_manual','filling','navigating','launching'].includes(session.status)) {
          session.steps.push('🔴 Browser-Fenster wurde geschlossen');
          session.steps.push('👆 Klick auf "Browser öffnen" um weiterzumachen');
          session.status = 'browser_closed';
          session.browser = null;
          session.page = null;
        }
      });
      setTimeout(() => {
        if (autoSessions.has(sessionId)) {
          session.browser?.close().catch(()=>{});
          autoSessions.delete(sessionId);
          // Clean up session profile dir

        }
      }, 45*60*1000);

    } catch(e) {
      session.status = 'error';
      session.steps.push('? Fehler: ' + e.message);
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
    .filter(w=>!['Die','Der','Das','Wir','Sie','Fï¿½r','Und','Mit','Als','Bei','Ihre','Unser','Eine'].includes(w));
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
  return /vereinigte\s+staaten|vereinigtes\s+k[oï¿½]nigreich|gro[sï¿½]britannien|nordamerika|nordirland|kalifornien|vereinigte\s+arabische/i.test(loc);
}

function filterJob(job, sc) {
  const text=(job.title+' '+job.desc).toLowerCase();
  // Always pass jobs whose title/desc matches one of the user's own search keywords
  const kwHit=(sc.keywords||[]).some(kw=>kw&&text.includes(kw.toLowerCase()));
  // Otherwise require IT-related content
  if (!kwHit && !/software|entwickl|developer|dev|web|frontend|backend|fullstack|it |informatik|sap|ux|design|embedded|hardware|devops/i.test(text)) return false;
  if (/\b(senior lead|principal staff|head of)\b/i.test(job.title.toLowerCase())) return false;
  // Block non-German locations for non-remote jobs
  if (!job.remote && isNonGermanLocation(job.location)) return false;
  // Respect want_remote / want_local flags
  if (job.remote && sc.want_remote===false) return false;
  if (!job.remote && sc.want_local===false) return false;
  // Block jobs that are neither remote nor local (e.g. random German city outside user's radius)
  if (!job.remote && !job.local) return false;
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

// Fix local=1 on jobs that are not actually near the user's configured city
function cleanWrongLocalJobs() {
  try {
    const searchRow = db.prepare("SELECT value FROM config WHERE key='search'").get();
    if (!searchRow) return;
    const sc = JSON.parse(searchRow.value);
    const userCity = (sc.location||'').toLowerCase().split(',')[0].trim();
    if (!userCity) return;
    // Fix 1: non-radius sources with a non-matching city ? set local=0
    // Radius-filtering sources (AA, StepStone) are already trustworthy ? skip them
    const radiusSources = ['Arbeitsagentur', 'StepStone'];
    const rows = db.prepare('SELECT id, location, source FROM jobs WHERE remote=0 AND local=1').all();
    const bad = rows.filter(r => {
      if (radiusSources.includes(r.source)) return false; // trust AA/SS radius
      const jc = (r.location||'').toLowerCase().replace(/^\d{5}\s*/, '').split(',')[0].trim();
      if (!jc || jc === 'deutschland' || jc === 'germany' || jc === 'remote') return true; // generic location is not local
      return !jc.includes(userCity) && !userCity.includes(jc);
    });
    if (bad.length > 0) {
      const ids = bad.map(r => r.id);
      db.prepare(`UPDATE jobs SET local=0 WHERE id IN (${ids.map(()=>'?').join(',')})`).run(...ids);
      console.log(`[DB] ${bad.length} falsch-lokale Jobs korrigiert (local=0 gesetzt, Ort ? ${userCity})`);
    }
    // Fix 2: sources without radius-filtering stored userCity as fake fallback location
    // Any job from these sources with location = userCity exactly is a fake, not a real local job
    const fakeSources = ['Heise Jobs', 'LinkedIn', 'Arbeitnow', 'Remotive', 'Bing', 'Xing'];
    for (const src of fakeSources) {
      const fakeRows = db.prepare(
        'SELECT id FROM jobs WHERE source=? AND local=1 AND remote=0 AND LOWER(TRIM(location))=?'
      ).all(src, userCity);
      if (fakeRows.length > 0) {
        const ids = fakeRows.map(r => r.id);
        db.prepare(`UPDATE jobs SET local=0, location='Deutschland' WHERE id IN (${ids.map(()=>'?').join(',')})`).run(...ids);
        console.log(`[DB] ${fakeRows.length} fake-lokale ${src}-Jobs bereinigt`);
      }
    }
  } catch(e) { console.log('[DB] LocalCleanup:', e.message); }
}

function dedup(existing, incoming) {
  const idMap=new Map(existing.map(j=>[j.id,j]));
  const keyMap=new Map(existing.map(j=>[(j.title+j.company).toLowerCase().replace(/\W/g,''),j]));
  const toUpdate=[]; // existing jobs whose local/remote flags changed
  const result=incoming.filter(j=>{
    const k=(j.title+j.company).toLowerCase().replace(/\W/g,'');
    const existById=idMap.get(j.id);
    const existByKey=keyMap.get(k);
    const existingJob=existById||existByKey;
    if (existingJob) {
      // Update local/remote flags if the re-scraped result differs
      if (existingJob.local!==j.local || existingJob.remote!==j.remote) {
        toUpdate.push({id:existingJob.id, local:j.local, remote:j.remote});
      }
      return false;
    }
    keyMap.set(k,j);
    return true;
  });
  // Apply flag updates to DB for re-found jobs
  if (toUpdate.length>0) {
    const stmt=db.prepare('UPDATE jobs SET local=?,remote=? WHERE id=?');
    for (const u of toUpdate) stmt.run(u.local?1:0, u.remote?1:0, u.id);
    console.log(`  [dedup] ${toUpdate.length} bestehende Jobs aktualisiert (local/remote)`);
  }
  return result;
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
  // Apply defaults for sources not in saved config (migration for old configs)
  const srcDefaults={aa:true,stepstone:true,linkedin:true,xing:false,heise:true,google:true,remotive:true,arbeitnow:true};
  const savedSrc=sc.sources||{};
  // If config was saved before new sources existed (no remotive/arbeitnow key) ? legacy config, use all defaults
  const isLegacyConfig=savedSrc.remotive===undefined&&savedSrc.arbeitnow===undefined;
  const src=isLegacyConfig?{...srcDefaults}:{...srcDefaults,...savedSrc};
  console.log(`  Standort: ${sc.location} ï¿½ Radius lokal: ${sc.radius_km} km ï¿½ Dienstwagen: ${sc.radius_car_km} km`);
  console.log(`\n${'='.repeat(52)}\n?? Scan: ${new Date().toLocaleString('de-DE')} ï¿½ ${sc.keywords.length} Keywords\n${'='.repeat(52)}`);
  const active=[src.aa!==false&&'AA',src.indeed!==false&&'Indeed',src.stepstone!==false&&'StepStone',src.linkedin&&'LinkedIn',src.xing&&'Xing',src.heise!==false&&'Heise',src.google!==false&&'Bing',src.remotive!==false&&'Remotive',src.arbeitnow!==false&&'Arbeitnow'].filter(Boolean);
  console.log(`  Quellen: ${active.join(', ')}`);
  for (const kw of sc.keywords) {
    console.log(`\n  "${kw}"`);
    if (src.aa!==false){scanStep=`"${kw}" · AA`;const aa=await scrapeArbeitsagentur(kw,sc);console.log(`    AA: ${aa.length}`);allNew.push(...aa);await sleep(1200);}
    if (src.stepstone!==false){scanStep=`"${kw}" Â· StepStone`;const ss=await scrapeStepstone(kw,sc);console.log(`    SS: ${ss.length}`);allNew.push(...ss);await sleep(1500);}
    if (src.linkedin){scanStep=`"${kw}" Â· LinkedIn`;const li=await scrapeLinkedIn(kw,sc);console.log(`    LinkedIn: ${li.length}`);allNew.push(...li);await sleep(2000);}
    if (src.xing){scanStep=`"${kw}" Â· Xing`;const xi=await scrapeXing(kw,sc);console.log(`    Xing: ${xi.length}`);allNew.push(...xi);await sleep(1500);}
    if (src.heise!==false){scanStep=`"${kw}" Â· Heise`;const hi=await scrapeHeise(kw,sc);console.log(`    Heise: ${hi.length}`);allNew.push(...hi);await sleep(1200);}
    if (src.google!==false){scanStep=`"${kw}" Â· Bing`;const go=await scrapeBing(kw,sc);console.log(`    Bing: ${go.length}`);allNew.push(...go);await sleep(2000);}
    if (src.remotive!==false){scanStep=`"${kw}" Â· Remotive`;const rm=await scrapeRemotive(kw,sc);console.log(`    Remotive: ${rm.length}`);allNew.push(...rm);await sleep(1000);}
    if (src.arbeitnow!==false){scanStep=`"${kw}" Â· Arbeitnow`;const an=await scrapeArbeitnow(kw,sc);console.log(`    Arbeitnow: ${an.length}`);allNew.push(...an);await sleep(1000);}
  }
  // Normalize local flag: skip radius-filtering sources (AA, StepStone already correct)
  // Only check city-match for sources that return nationwide results
  const noRadiusSources = ['LinkedIn', 'Heise Jobs', 'Arbeitnow', 'Remotive', 'Bing', 'Xing', 'Google'];
  const userCityLow=(sc.location||'').toLowerCase().split(',')[0].trim();
  if (userCityLow) {
    for (const job of allNew) {
      if (!job.remote && job.local && noRadiusSources.includes(job.source)) {
        // Strip PLZ prefix e.g. "97076 Schweinfurt" ? "schweinfurt"
        const jc=(job.location||'').toLowerCase().replace(/^\d{5}\s*/,'').split(',')[0].trim();
        // Generic/empty location or no specific city ? not local
        if (!jc || jc==='deutschland' || jc==='germany' || jc==='remote') {
          job.local=false;
        } else if (!jc.includes(userCityLow) && !userCityLow.includes(jc)) {
          job.local=false;
        }
      }
    }
  }
  const filtered=allNew.filter(j=>filterJob(j,sc));
  const unique=dedup(data.jobs,filtered);
  unique.forEach(j=>{j.match=scoreJob(j,profile,sc);});
  unique.sort((a,b)=>b.match-a.match);
  // Save only new jobs to DB (saveJobs handles 600-cap internally via SQL)
  const newData={ jobs:unique, lastScan:new Date().toISOString(), scanCount:(data.scanCount||0)+1, newThisScan:unique.length };
  saveJobs(newData);
  console.log(`\n? ${unique.length} neue Stellen (${allNew.length} gesamt gefunden)`);
  // Pre-generate cover letters for new jobs in background (no await)
  if (unique.length > 0) preGenerateLetters(unique).catch(e=>console.error('[Letter]', e.message));
  return unique.length;
}

function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

async function preGenerateLetters(jobs) {
  const profile = loadProfile();
  for (const job of jobs) {
    try {
      const lang = detectLanguage((job.title||'')+' '+(job.desc||''));
      const letter = await generateCoverLetter(job, profile, lang);
      db.prepare('UPDATE jobs SET letter=? WHERE id=?').run(letter, job.id);
      console.log(`[Letter] ? ${job.title.slice(0,40)}`);
    } catch(e) {
      console.error(`[Letter] ? ${job.title?.slice(0,30)}: ${e.message}`);
    }
    await sleep(3000); // rate-limit: 3s between AI calls
  }
}

// -- AI BACKEND: ANTHROPIC or OLLAMA --------------------------------------
async function callAI(messages, maxTokens=1000) {
  if (CONFIG.AI_MODE === 'ollama') {
    return callOllama(messages, maxTokens);
  }
  return callAnthropic(messages, maxTokens);
}

async function callAnthropic(messages, maxTokens=1000, label='callAnthropic', model=null) {
  if (!CONFIG.ANTHROPIC_API_KEY) throw new Error('Kein Anthropic API Key gesetzt');
  const useModel = model || CONFIG.ANTHROPIC_MODEL || MODELS.coverLetter;
  const cleanMessages = messages.map(m => ({ ...m, content: m.content }));
  const res = await fetchUrl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    timeout: 60000,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': CONFIG.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: useModel, max_tokens: maxTokens, messages: cleanMessages }),
  });
  let d;
  try { d = JSON.parse(res.body); } catch(e) { throw new Error(`Anthropic Antwort ungï¿½ltig (HTTP ${res.status})`); }
  if (d.error) {
    const msg = d.error.message || JSON.stringify(d.error);
    console.error('[Anthropic] Fehler:', JSON.stringify(d.error));
    if (res.status === 401) throw new Error('API Key ungï¿½ltig oder abgelaufen (401)');
    if (res.status === 403) throw new Error('API Key hat keine Berechtigung (403) ï¿½ neuen Key erstellen');
    throw new Error(`Anthropic: ${msg}`);
  }
  const usage = d.usage || {};
  if (usage.input_tokens || usage.output_tokens) {
    trackCost(label, useModel, usage.input_tokens||0, usage.output_tokens||0);
  }
  return d.content?.map(b => b.text||'').join('') || '';
}

async function callOllama(messages, maxTokens=1000, modelOverride=null, noThink=false) {
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
  const model = modelOverride || CONFIG.OLLAMA_MODEL;
  const res = await fetchUrl(`${CONFIG.OLLAMA_URL}/api/chat`, {
    method: 'POST',
    timeout: 600000,  // 10 min – 70B model can be slow
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: flatMessages,
      stream: false,
      ...(noThink ? { think: false } : {}),
      options: { num_predict: maxTokens, temperature: 0.75 },
    }),
  });
  const d = JSON.parse(res.body);
  if (d.error) throw new Error('Ollama: ' + d.error);
  return d.message?.content || '';
}

// Vision call via Ollama (llava, minicpm-v, moondream, etc.)
async function callOllamaVision(imageBase64, promptText) {
  const model = CONFIG.OLLAMA_VISION_MODEL || 'llava:latest';
  try { await fetchUrl(`${CONFIG.OLLAMA_URL}/api/tags`, { timeout: 5000 }); } catch(e) {
    throw new Error(`Ollama nicht erreichbar (${CONFIG.OLLAMA_URL}). Bitte Ollama starten: ollama serve`);
  }
  // Use /api/generate (not /api/chat) — llava requires this endpoint for images
  // Override Accept-Language to avoid German responses from llava
  const res = await fetchUrl(`${CONFIG.OLLAMA_URL}/api/generate`, {
    method: 'POST',
    timeout: 180000,
    headers: {
      'Content-Type': 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    body: JSON.stringify({
      model,
      prompt: promptText,
      images: [imageBase64],
      stream: false,
      options: { num_predict: 512, temperature: 0.1 },
    }),
  });
  const d = JSON.parse(res.body);
  if (d.error) throw new Error('Ollama Vision: ' + d.error);
  const text = d.response || d.message?.content || '';
  if (!text) throw new Error('Ollama Vision: Leere Antwort (Modell konnte Bild nicht verarbeiten)');
  return text;
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

async function generateCoverLetter(job, profile, lang, feedback='') {
  if (!lang) lang = detectLanguage((job.title||'')+' '+(job.desc||''));
  const eduDE = [
    profile.bachelorFach ? `Studiengang: ${profile.bachelorFach}` : '',
    profile.hochschule   ? `Hochschule: ${profile.hochschule}` : '',
    profile.abschlussjahr? `Abschluss: ${profile.abschlussjahr}` : '',
  ].filter(Boolean).join(', ');
  const eduEN = [
    profile.bachelorFach ? `Degree: ${profile.bachelorFach}` : '',
    profile.hochschule   ? `University: ${profile.hochschule}` : '',
    profile.abschlussjahr? `Graduated: ${profile.abschlussjahr}` : '',
  ].filter(Boolean).join(', ');
  let prompt;
  if (lang === 'en') {
    prompt = `You are a professional job application writer. Write a cover letter for the following position.

RULES (follow strictly):
- Tone: direct, confident, human. NOT corporate, NOT generic.
- FORBIDDEN phrases: "I am excited to apply", "I am writing to express my interest", "I would love to", "I am passionate about", "a dynamic team", "fast-paced environment"
- NO markdown, NO asterisks (*), NO bold (**), NO bullet points, NO headings
- NO em dash (—), NO en dash (–) — use comma or period instead
- Length: exactly 3 paragraphs of body text, ~220-250 words total (not counting subject line)
- Start each paragraph on a new line, between greeting, name and last paragraph 2 new lines

POSITION:
Title: ${job.title}
Company: ${job.company}
Location: ${job.location}
Job description: ${(job.desc||'').slice(0,800)}
Keywords to include naturally: ${(job.keywords||[]).slice(0,5).join(', ')}

APPLICANT:
Name: ${profile.name||'Applicant'}
Skills: ${profile.skills||'Software Development'}
Experience: ${profile.experience||''}
${eduEN ? 'Education: '+eduEN : ''}
${profile.languages ? 'Languages: '+profile.languages : ''}
${profile.bio ? 'Background: '+profile.bio : ''}
${(profile.cvProjects||[]).length ? 'Relevant projects (mention 1–2 if they fit the role, briefly and naturally): '+(profile.cvProjects||[]).join(' | ') : ''}

OUTPUT FORMAT (output only this, nothing before, nothing after):
Line 1: Subject line like "Application – ${job.title}"
Line 2: blank
Line 3: Salutation like "Hello," or "Dear Hiring Team,"
Line 4: blank
Lines 5+: Three paragraphs separated by blank lines
Last line: "Best regards," then next line the applicant name${feedback ? `\n\nSPECIAL INSTRUCTION FOR THIS VERSION: ${feedback}` : ''}`;

  } else {
    prompt = `Du bist ein professioneller Bewerbungsschreiber. Schreibe ein Anschreiben für folgende Stelle.

REGELN (strikt einhalten):
- Ton: direkt, selbstbewusst, authentisch. NICHT formelhaft, NICHT generisch, KEINE Übersetzung aus dem Englischen.
- Sprache: natürliches, fehlerfreies Hochdeutsch. Korrekte Grammatik und Zeitformen (z.B. "Ich habe entwickelt" nicht "ich entwickeln").
- VERBOTENE Formulierungen: "Zu Ihrer Stelle bin ich sehr interessiert", "bin ich sehr interessiert", "Mit großem Interesse", "hiermit bewerbe ich mich", "ich bewerbe mich hiermit", "hochmotiviert", "dynamisches Team", "spannende Herausforderung", "ich freue mich darauf", "mit freundlichen Grüßen möchte ich", "bin ich qualifiziert", "zu qualifizieren"
- GUTE Einstiegssätze: direkt mit einer konkreten Aussage beginnen, z.B. "React, TypeScript und NestJS – genau das bringe ich mit für die Stelle als...", oder "Als Fullstack-Entwickler mit Erfahrung in ... passe ich gut zur Stelle bei ..."
- KEIN Markdown, KEINE Sternchen (*), KEIN Fettdruck (**), KEINE Aufzählungspunkte, KEINE Überschriften
- KEIN Em-Dash (—), KEIN En-Dash (–), stattdessen Komma oder Punkt
- Länge: genau 3 Absätze Brieftext, ca. 200-230 Wörter gesamt (Betreff nicht mitgezählt)
- Absätze durch Leerzeile trennen, zwischen gruß, name und letztem Absatz immer zwei Leerzeilen
- Schreibe aus der Ich-Perspektive des Bewerbers

STELLE:
Titel: ${job.title}
Unternehmen: ${job.company}
Ort: ${job.location}
Stellenbeschreibung: ${(job.desc||'').slice(0,800)}
Keywords natürlich einbauen: ${(job.keywords||[]).slice(0,5).join(', ')}

BEWERBER:
Name: ${profile.name||'Bewerber'}
Skills: ${profile.skills||'Softwareentwicklung'}
Erfahrung: ${profile.experience||''}
${eduDE ? 'Ausbildung: '+eduDE : ''}
${profile.languages ? 'Sprachen: '+profile.languages : ''}
${profile.bio ? 'Über mich: '+profile.bio : ''}
${(profile.cvProjects||[]).length ? 'Eigene Projekte (1–2 erwähnen falls zur Stelle passend, kurz und natürlich eingebaut): '+(profile.cvProjects||[]).join(' | ') : ''}

AUSGABEFORMAT (nur das ausgeben, nichts davor, nichts danach):
Zeile 1: Betreff wie "Bewerbung als ${job.title}"
Zeile 2: leer
Zeile 3: Anrede wie "Hallo," oder "Sehr geehrte Damen und Herren,"
Zeile 4: leer
Zeilen 5+: Drei Absätze, durch Leerzeile getrennt
Letzte Zeile: "Mit freundlichen Grüßen," dann nächste Zeile der Name des Bewerbers${feedback ? `

BESONDERE ANWEISUNG FÜR DIESE VERSION: ${feedback}` : ''}`;
  }
  const sysLang = lang === 'en'
    ? 'You are a professional cover letter writer. You write only in English. Output plain text only, no markdown.'
    : 'Du bist ein professioneller Bewerbungsschreiber. Du schreibst ausschließlich auf natürlichem, fehlerfreiem Hochdeutsch. Niemals auf Englisch, niemals übersetzte Phrasen. Nur Klartext, kein Markdown.';
  const raw = CONFIG.AI_MODE === 'ollama'
    ? (await callOllama([{ role: 'system', content: sysLang }, { role: 'user', content: prompt }], 1500, CONFIG.OLLAMA_LETTER_MODEL || CONFIG.OLLAMA_MODEL, true)).replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
    : await callAnthropic([{ role: 'user', content: prompt }], 1500, 'Anschreiben', MODELS.coverLetter);
  // Strip any markdown bold/italic markers and dashes the AI added despite instructions
  return raw.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1').replace(/\u2014/g, ',').replace(/\u2013/g, ',').trim();
}

// Detect language from job text (simple word-frequency approach)
function detectLanguage(text) {
  const lo = ' ' + text.toLowerCase() + ' ';
  const en = [' the ',' and ',' with ',' our ',' your ',' for ',' are ',' have ',' will ',' from ',' team ',' work ',' join ',' role ',' company ',' skills ',' experience ',' looking ',' strong ',' based ',' position ',' requirements '].filter(w=>lo.includes(w)).length;
  const de = [' die ',' der ',' das ',' und ',' mit ',' fï¿½r ',' wir ',' sie ',' bei ',' als ',' eine ',' nicht ',' auch ',' ihre ',' werden ',' haben ',' kï¿½nnen ',' suchen ',' bieten ',' uns '].filter(w=>lo.includes(w)).length;
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

// Minimal SMTP client using STARTTLS (port 587) ï¿½ no npm deps
async function sendSMTP({ to, subject, body }) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = CONFIG;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) throw new Error('SMTP nicht konfiguriert ï¿½ bitte in Einstellungen ? E-Mail eintragen');
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
        const confSubject = lang==='en' ? `? Application sent: ${job.title}` : `? Bewerbung gesendet: ${job.title}`;
        const confBody = (lang==='en'
          ? `Your application was sent!\n\nJob: ${job.title}\nCompany: ${job.company}\nSent to: ${contactEmail}\nDate: ${new Date().toLocaleString('de-DE')}`
          : `Deine Bewerbung wurde gesendet!\n\nStelle: ${job.title}\nFirma: ${job.company}\nGesendet an: ${contactEmail}\nDatum: ${new Date().toLocaleString('de-DE')}`)
          + `\n\n${'-'.repeat(40)}\n\n${letter}`;
        await sendSMTP({ to: CONFIG.USER_EMAIL, subject: confSubject, body: confBody });
      } catch(e) { console.log('[SMTP] Bestï¿½tigung fehlgeschlagen:', e.message); }
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
function ascii85Decode(buf) {
  // ASCII85 (base85) decoder. Input ends with ~>
  let str = buf.toString('ascii').replace(/\s/g, '');
  if (str.endsWith('~>')) str = str.slice(0, -2);
  const out = [];
  let i = 0;
  while (i < str.length) {
    if (str[i] === 'z') { out.push(0,0,0,0); i++; continue; }
    const chunk = str.slice(i, i+5);
    i += 5;
    let val = 0;
    for (let j = 0; j < 5; j++) {
      val = val * 85 + ((chunk.charCodeAt(j) || 117) - 33);
    }
    const len = Math.min(4, chunk.length - 1);
    for (let b = 3; b >= 4 - len; b--) out.push((val >>> (b * 8)) & 0xff);
  }
  return Buffer.from(out);
}

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
    const isA85 = /ASCII85Decode|A85/.test(dict);
    let data = Buffer.from(sm[1], 'binary');
    // Apply filters in order (PDF spec: filters applied in array order, decode in reverse)
    if (isA85) {
      try { data = ascii85Decode(data); } catch(e) {}
    }
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
    const prompt = `Analysiere den folgenden Lebenslauf-Text und extrahiere ALLE Skills sowie Projekte.\n\nLebenslauf:\n${pdfText.slice(0, 6000)}\n\nAntworte NUR mit JSON, kein Markdown:\n{"technical":[],"languages":[],"tools":[],"soft":[],"domains":[],"projects":[],"experience_summary":""}\n\nFür "projects": Liste jedes relevante Projekt als kurzen String, z.B. "JobHunter AI – Node.js, Puppeteer, SQLite" oder "E-Learning Portal – React, TypeScript, REST API". Max 6 Projekte.`;
    // Use letter model (smaller/faster) for JSON extraction, fall back to main model
    const model = CONFIG.OLLAMA_LETTER_MODEL || CONFIG.OLLAMA_MODEL;
    const timeoutPromise = new Promise((_,rej)=>setTimeout(()=>rej(new Error('Zeitüberschreitung nach 5 Minuten. Ollama läuft möglicherweise noch (Modell wird geladen) – bitte erneut versuchen.')),300000));
    const cvRaw = await Promise.race([callOllama([{ role: 'user', content: prompt }], 1500, model, true), timeoutPromise]);
    return cvRaw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  }
  return callAnthropic([{role:'user',content:[
    {type:'document',source:{type:'base64',media_type:'application/pdf',data:base64}},
    {type:'text',text:'Analysiere diesen Lebenslauf. Extrahiere ALLE Skills sowie Projekte (auch implizite).\n\nAntworte NUR mit JSON, kein Markdown:\n{"technical":[],"languages":[],"tools":[],"soft":[],"domains":[],"projects":[],"experience_summary":""}\n\nFür "projects": je ein kurzer String pro Projekt, z.B. "JobHunter AI – Node.js, SQLite". Max 6 Projekte.'}
  ]}],1200,'CV-Analyse',MODELS.cvAnalysis);
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
  const parsed=url.parse(req.url,true);
  const pathname=parsed.pathname;
  if (req.method==='OPTIONS'){res.writeHead(204,CORS);return res.end();}
  if (pathname==='/'||pathname==='/index.html') return sendFile(res,path.join(__dirname,'app.html'),'text/html;charset=utf-8');

  // -- AUTH ENDPOINTS (always public) -----------------------------------
  if (pathname==='/api/auth/status'&&req.method==='GET') {
    return sendJSON(res,{authRequired:!!(CONFIG.ACCESS_PIN||'').trim()});
  }
  if (pathname==='/api/auth/login'&&req.method==='POST') {
    const body=await readBody(req);
    const pin=(CONFIG.ACCESS_PIN||'').trim();
    if (!pin) return sendJSON(res,{ok:true,token:''});
    if ((body.pin||'').toString().trim()!==pin) return sendJSON(res,{error:'Falscher PIN'},401);
    const token=genToken();
    activeSessions.set(token,{created:Date.now()});
    return sendJSON(res,{ok:true,token});
  }
  if (pathname==='/api/auth/logout'&&req.method==='POST') {
    const q=parsed.query;
    const hToken=(req.headers['authorization']||'').replace(/^Bearer\s+/i,'');
    const token=(q.token||hToken||'').trim();
    if (token) activeSessions.delete(token);
    return sendJSON(res,{ok:true});
  }

  // -- AUTH CHECK for all other /api/* and /uploads/* --------------------
  if ((pathname.startsWith('/api/')||pathname.startsWith('/uploads/'))&&!checkAuth(req)) {
    return sendJSON(res,{error:'Nicht autorisiert. Bitte PIN eingeben.'},401);
  }

  if (pathname==='/api/jobs'&&req.method==='GET') return sendJSON(res,loadJobs());
  if (pathname.startsWith('/api/jobs/')&&req.method==='PUT') {
    const id=pathname.replace('/api/jobs/',''); const body=await readBody(req);
    updateJob(id, body); return sendJSON(res,{ok:true});
  }
  if (pathname==='/api/ai-costs'&&req.method==='GET') {
    const recentCalls = aiCostTracker.calls.slice(-50).reverse();
    return sendJSON(res, {
      session_start:       aiCostTracker.session_start,
      total_input_tokens:  aiCostTracker.total_input_tokens,
      total_output_tokens: aiCostTracker.total_output_tokens,
      total_cost_usd:      +aiCostTracker.total_cost_usd.toFixed(5),
      total_cost_eur:      +(aiCostTracker.total_cost_usd * 0.93).toFixed(5),
      call_count:          aiCostTracker.calls.length,
      recent_calls:        recentCalls,
    });
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
      const reply = await callAnthropic([{role:'user',content:'Antworte nur mit: OK'}], 10, 'Test-Ping', MODELS.testPing);
      return sendJSON(res,{ok:true,reply,models,activeModel:CONFIG.ANTHROPIC_MODEL});
    } catch(e) { return sendJSON(res,{ok:false,error:e.message,models,activeModel:CONFIG.ANTHROPIC_MODEL},400); }
  }
  if (pathname==='/api/chat'&&req.method==='POST') {
    const {message, history=[]} = await readBody(req);
    if (!message) return sendJSON(res,{error:'Keine Nachricht'},400);
    try {
      const systemPrompt = 'Du bist ein hilfreicher Assistent fuer Bewerbungen, Karriere und allgemeine Fragen. Antworte auf Deutsch, kurz und direkt.';
      const historyMsgs = history.slice(-10).map(h => ({ role: h.role, content: h.content }));
      const userMsg = { role:'user', content: message };
      let reply;
      if (CONFIG.AI_MODE === 'ollama') {
        // Inject system as first user message for Ollama compatibility
        const msgs = [{ role:'user', content: systemPrompt }, { role:'assistant', content:'Verstanden.' }, ...historyMsgs, userMsg];
        reply = await callOllama(msgs, 800);
      } else {
        reply = await callAnthropic([...historyMsgs, userMsg], 800, 'Chat', MODELS.coverLetter);
      }
      return sendJSON(res,{reply});
    } catch(e) { return sendJSON(res,{error:e.message},500); }
  }
  if (pathname==='/api/coverletter'&&req.method==='POST') {
    const {job, force, feedback}=await readBody(req);
    try{
      const lang=detectLanguage((job.title||'')+' '+(job.desc||''));
      // Return cached letter if available (skip if force=true)
      if (!force && job.id) {
        const cached = db.prepare('SELECT letter FROM jobs WHERE id=?').get(job.id);
        if (cached?.letter) return sendJSON(res,{letter:cached.letter,lang,cached:true});
      }
      const letter = await generateCoverLetter(job,loadProfile(),lang,feedback||'');
      // Cache for next time
      if (job.id) { try { db.prepare('UPDATE jobs SET letter=? WHERE id=?').run(letter, job.id); } catch(e) {} }
      return sendJSON(res,{letter,lang});
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
    if (!Array.isArray(jobIds)||jobIds.length===0) return sendJSON(res,{error:'Keine Jobs ausgewï¿½hlt'},400);
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

  // -- CV ANALYSE STREAMING (SSE) ----------------------------------------
  if (pathname==='/api/analyze-cv-stream'&&req.method==='POST') {
    const {base64}=await readBody(req);
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive','Access-Control-Allow-Origin':'*'});
    const sse = (data) => { try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch(e){} };

    if (CONFIG.AI_MODE !== 'ollama') {
      // For Anthropic just run normally
      sse({step:'model', msg:'Claude API – analysiere...'});
      try {
        const raw = await analyzeCV(base64);
        sse({step:'done', raw});
      } catch(e) { sse({step:'error', msg:e.message}); }
      return res.end();
    }

    // --- Ollama streaming path ---
    sse({step:'extract', msg:'Lese PDF-Text...'});
    let pdfText;
    try {
      pdfText = extractPdfText(base64);
    } catch(e) { sse({step:'error', msg:'PDF-Fehler: '+e.message}); return res.end(); }
    if (!pdfText || pdfText.trim().length < 60) {
      sse({step:'error', msg:'PDF-Text konnte nicht extrahiert werden (ggf. gescanntes PDF). Bitte Skills manuell eintragen.'});
      return res.end();
    }
    sse({step:'extract', msg:`PDF gelesen · ${pdfText.trim().split(/\s+/).length} Wörter erkannt`});

    const model = CONFIG.OLLAMA_LETTER_MODEL || CONFIG.OLLAMA_MODEL;
    sse({step:'model', msg:`Modell: ${model} – warte auf Ollama...`});

    // Check Ollama reachable
    try { await fetchUrl(`${CONFIG.OLLAMA_URL}/api/tags`, {timeout:4000}); }
    catch(e) { sse({step:'error', msg:`Ollama nicht erreichbar (${CONFIG.OLLAMA_URL}). Bitte starten.`}); return res.end(); }

    const prompt = `Analysiere den folgenden Lebenslauf-Text und extrahiere ALLE Skills sowie Projekte.\n\nLebenslauf:\n${pdfText.slice(0,6000)}\n\nAntworte NUR mit JSON, kein Markdown:\n{"technical":[],"languages":[],"tools":[],"soft":[],"domains":[],"projects":[],"experience_summary":""}\n\nFür "projects": Liste jedes relevante Projekt als kurzen String, z.B. "JobHunter AI – Node.js, SQLite". Max 6 Projekte.`;

    // Stream Ollama response token by token
    const ollamaUrl = new URL(`${CONFIG.OLLAMA_URL}/api/chat`);
    const flatMsg = [{role:'user',content:prompt}];
    let fullContent = '';
    let tokenCount = 0;
    let lastStatusAt = 0;
    const startTs = Date.now();

    await new Promise((resolve) => {
      const ollamaReq = http.request({
        hostname: ollamaUrl.hostname,
        port: parseInt(ollamaUrl.port)||11434,
        path: '/api/chat',
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        timeout: 300000,
      }, (ollamaRes) => {
        let buf = '';
        ollamaRes.on('data', chunk => {
          buf += chunk.toString();
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const d = JSON.parse(trimmed);
              const token = d.message?.content || '';
              fullContent += token;
              tokenCount++;
              const now = Date.now();
              // Send update every 15 tokens or every 2 seconds
              if (tokenCount - lastStatusAt >= 15 || now - startTs > (Math.floor((now-startTs)/2000)*2000)) {
                lastStatusAt = tokenCount;
                const elapsed = Math.round((now-startTs)/1000);
                // Count how many JSON fields look filled in
                const skillsFound = (fullContent.match(/"[^"]{2,30}"/g)||[]).length;
                sse({step:'generating', msg:`Analysiere... (${tokenCount} Tokens, ${elapsed}s) · ~${Math.max(0,skillsFound-10)} Skills erkannt`, tokens:tokenCount, elapsed});
              }
              if (d.done) {
                fullContent = fullContent.replace(/<think>[\s\S]*?<\/think>/gi,'').trim();
                sse({step:'done', raw:fullContent});
                resolve();
              }
            } catch(e) {}
          }
        });
        ollamaRes.on('end', () => resolve());
        ollamaRes.on('error', (e) => { sse({step:'error', msg:'Stream-Fehler: '+e.message}); resolve(); });
      });
      ollamaReq.on('error', (e) => { sse({step:'error', msg:'Ollama-Fehler: '+e.message}); resolve(); });
      ollamaReq.on('timeout', () => { ollamaReq.destroy(); sse({step:'error', msg:'Zeitüberschreitung – Ollama antwortet nicht'}); resolve(); });
      ollamaReq.write(JSON.stringify({
        model,
        messages: flatMsg,
        stream: true,
        think: false,
        options: {num_predict:1500, temperature:0.3},
      }));
      ollamaReq.end();
    });
    return res.end();
  }
  if (pathname==='/api/profile') {
    if (req.method==='GET') return sendJSON(res,loadProfile());
    if (req.method==='POST'){const body=await readBody(req);saveProfileData(body);return sendJSON(res,{ok:true});}
  }
  if (pathname==='/api/search') {
    if (req.method==='GET') return sendJSON(res,loadSearch());
    if (req.method==='POST'){const body=await readBody(req);saveSearch({...loadSearch(),...body});return sendJSON(res,{ok:true});}
  }
  if (pathname==='/api/scan'&&req.method==='POST'){
    if (scanRunning){sendJSON(res,{ok:true,message:'Scan lï¿½uft bereits'});return;}
    sendJSON(res,{ok:true});
    scanRunning=true; scanStarted=new Date().toISOString();
    runScan().catch(console.error).finally(()=>{scanRunning=false; scanStarted=null; scanStep='';});
    return;
  }
  if (pathname==='/api/status') {
    const data=loadJobs();
    return sendJSON(res,{running:true,scanRunning,scanStarted,scanStep,lastScan:data.lastScan,scanCount:data.scanCount||0,jobCount:data.jobs?.length||0,newThisScan:data.newThisScan||0,nextScanIn:CONFIG.SCAN_INTERVAL_MINUTES,apiKeySet:!!CONFIG.ANTHROPIC_API_KEY,aiMode:CONFIG.AI_MODE,ollamaModel:CONFIG.OLLAMA_MODEL,ollamaVisionModel:CONFIG.OLLAMA_VISION_MODEL,ollamaLetterModel:CONFIG.OLLAMA_LETTER_MODEL||'',anthropicModel:'claude-opus-4-7',smtpConfigured:!!(CONFIG.SMTP_HOST&&CONFIG.SMTP_USER&&CONFIG.SMTP_PASS),userEmail:CONFIG.USER_EMAIL||''});;
  }
  if (pathname==='/api/config'&&req.method==='POST') {
    const body=await readBody(req);
    if (body.apiKey) {
      CONFIG.ANTHROPIC_API_KEY=body.apiKey;
      saveEnvKey('ANTHROPIC_API_KEY', body.apiKey);
    }
    if (body.scanInterval) { CONFIG.SCAN_INTERVAL_MINUTES=parseInt(body.scanInterval); restartScheduler(); }
    if (body.aiMode) { CONFIG.AI_MODE=body.aiMode; saveEnvKey('AI_MODE', body.aiMode); }
    if (body.ollamaModel) { CONFIG.OLLAMA_MODEL=body.ollamaModel; saveEnvKey('OLLAMA_MODEL', body.ollamaModel); }
    if (body.ollamaVisionModel !== undefined) { CONFIG.OLLAMA_VISION_MODEL=body.ollamaVisionModel; saveEnvKey('OLLAMA_VISION_MODEL', body.ollamaVisionModel); }
    if (body.ollamaLetterModel !== undefined) { CONFIG.OLLAMA_LETTER_MODEL=body.ollamaLetterModel; saveEnvKey('OLLAMA_LETTER_MODEL', body.ollamaLetterModel); }
    if (body.ollamaUrl) { CONFIG.OLLAMA_URL=body.ollamaUrl; saveEnvKey('OLLAMA_URL', body.ollamaUrl); }
    if (body.anthropicModel) CONFIG.ANTHROPIC_MODEL=body.anthropicModel;
    if (body.smtpHost    !== undefined) { CONFIG.SMTP_HOST=body.smtpHost;   saveEnvKey('SMTP_HOST',   body.smtpHost); }
    if (body.smtpPort    !== undefined) { CONFIG.SMTP_PORT=parseInt(body.smtpPort)||587; saveEnvKey('SMTP_PORT', String(CONFIG.SMTP_PORT)); }
    if (body.smtpUser    !== undefined) { CONFIG.SMTP_USER=body.smtpUser;   saveEnvKey('SMTP_USER',   body.smtpUser); }
    if (body.smtpPass    !== undefined) { CONFIG.SMTP_PASS=body.smtpPass;   saveEnvKey('SMTP_PASS',   body.smtpPass); }
    if (body.userEmail   !== undefined) { CONFIG.USER_EMAIL=body.userEmail; saveEnvKey('USER_EMAIL',  body.userEmail); }
    if (body.accessPin   !== undefined) { CONFIG.ACCESS_PIN=(body.accessPin||'').toString().trim(); saveEnvKey('ACCESS_PIN', CONFIG.ACCESS_PIN); }
    return sendJSON(res,{ok:true});
  }
  if (pathname==='/api/ollama-status'&&req.method==='GET') {
    const status=await checkOllamaStatus();
    return sendJSON(res,{...status, currentModel:CONFIG.OLLAMA_MODEL, aiMode:CONFIG.AI_MODE});
  }

  // -- OLLAMA PULL (SSE stream) ------------------------------------------
  if (pathname==='/api/ollama-pull'&&req.method==='POST') {
    const { model } = await readBody(req);
    if (!model || typeof model !== 'string' || !/^[\w.\-:\/]+$/.test(model)) {
      return sendJSON(res, { error: 'Ungültiger Modellname' }, 400);
    }
    // Set up SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    const send = (data) => { try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch(e){} };
    send({ status: 'starting', message: `Lade ${model} herunter...` });
    // Stream the pull from Ollama
    const ollamaUrl = new URL(`${CONFIG.OLLAMA_URL}/api/pull`);
    const pullReq = http.request({
      hostname: ollamaUrl.hostname,
      port: parseInt(ollamaUrl.port) || 11434,
      path: '/api/pull',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, (pullRes) => {
      let buf = '';
      pullRes.on('data', chunk => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop(); // keep incomplete line
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const d = JSON.parse(trimmed);
            if (d.total && d.completed) {
              const pct = Math.round((d.completed / d.total) * 100);
              send({ status: 'downloading', message: d.status || 'Downloade...', pct, total: d.total, completed: d.completed });
            } else if (d.status) {
              send({ status: d.status === 'success' ? 'success' : 'progress', message: d.status });
            }
          } catch(e) {}
        }
      });
      pullRes.on('end', () => {
        send({ status: 'success', message: `${model} erfolgreich heruntergeladen!` });
        try { res.end(); } catch(e) {}
      });
    });
    pullReq.on('error', (e) => {
      send({ status: 'error', message: 'Ollama nicht erreichbar: ' + e.message });
      try { res.end(); } catch(e2) {}
    });
    pullReq.write(JSON.stringify({ name: model, stream: true }));
    pullReq.end();
    return; // keep connection open
  }

  if (pathname==='/api/test-ollama'&&req.method==='GET') {
    const status=await checkOllamaStatus();
    if (!status.running) return sendJSON(res,{ok:false,error:`Ollama nicht erreichbar (${CONFIG.OLLAMA_URL}). Bitte starten: ollama serve`});
    if (!status.models.includes(CONFIG.OLLAMA_MODEL) && !status.models.some(m=>m.startsWith(CONFIG.OLLAMA_MODEL.split(':')[0]))) {
      return sendJSON(res,{ok:false,error:`Modell '${CONFIG.OLLAMA_MODEL}' nicht gefunden. Installiert: ${status.models.join(', ')||'keine'}`});
    }
    try {
      const reply = await callOllama([{role:'user',content:'Antworte nur mit OK.'}], 10);
      // Check vision model availability
      const visionModel = CONFIG.OLLAMA_VISION_MODEL || 'llava:latest';
      const visionAvailable = status.models.includes(visionModel) || status.models.some(m=>m.startsWith(visionModel.split(':')[0]));
      return sendJSON(res,{ok:true,model:CONFIG.OLLAMA_MODEL,reply:reply.slice(0,80).trim(),models:status.models,visionModel,visionAvailable});
    } catch(e) {
      return sendJSON(res,{ok:false,error:e.message});
    }
  }

  // -- PDF AUS BEARBEITETEM TEXT -----------------------------------------
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

  // -- ANSCHREIBEN AUS URL -----------------------------------------------
  if (pathname==='/api/letter-from-url' && req.method==='POST') {
    const { url: jobUrl } = await readBody(req);
    if (!jobUrl || !/^https?:\/\//i.test(jobUrl)) return sendJSON(res, { error: 'Ungï¿½ltige URL' }, 400);
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
        title = tm ? tm[1].replace(/\s*[-|ï¿½]\s*.*$/,'').trim().slice(0,120) : new URL(jobUrl).hostname;
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
      return sendJSON(res, { ok: true, msg: 'Browser geï¿½ffnet ï¿½ bitte auf LinkedIn, Xing, StepStone usw. einloggen und dann Browser schlieï¿½en.' });
    } catch(e) { return sendJSON(res, { error: e.message }, 500); }
  }

  // -- FILE UPLOAD / MANAGEMENT ------------------------------------------
  if (pathname==='/api/files' && req.method==='GET') {
    // Return only non-letter files (user documents)
    const files = listUploads().filter(f => !f.name.startsWith('_anschreiben_'));
    return sendJSON(res, { files });
  }
  if (pathname==='/api/letters' && req.method==='GET') {
    // Return generated cover letter PDFs
    try {
      const letters = fs.readdirSync(UPLOADS_DIR)
        .filter(f => f.startsWith('_anschreiben_') && /\.pdf$/i.test(f))
        .map(f => { const st=fs.statSync(path.join(UPLOADS_DIR,f)); return {name:f,size:st.size,created:(st.birthtime||st.mtime).toISOString()}; })
        .sort((a,b)=>new Date(b.created)-new Date(a.created));
      return sendJSON(res, { letters });
    } catch(e) { return sendJSON(res, { letters: [] }); }
  }
  if (pathname==='/api/upload' && req.method==='POST') {
    const { filename, data } = await readBody(req);
    if (!filename || !data) return sendJSON(res, { error: 'filename und data erforderlich' }, 400);
    const safe = path.basename(String(filename)).replace(/[^\w.\-ï¿½ï¿½ï¿½ï¿½ï¿½ï¿½ï¿½ ]/g,'_').slice(0,100);
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
  // -- FILE DOWNLOAD (uploads) -------------------------------------------
  if (pathname.startsWith('/uploads/') && req.method==='GET') {
    const fn = path.basename(decodeURIComponent(pathname.slice('/uploads/'.length)));
    const fp = path.join(UPLOADS_DIR, fn);
    const resolved = path.resolve(fp);
    if (!resolved.startsWith(path.resolve(UPLOADS_DIR)) || !fs.existsSync(resolved)) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(fn).toLowerCase();
    const ct = ext==='.pdf'?'application/pdf':ext==='.png'?'image/png':/\.(jpe?g)$/.test(ext)?'image/jpeg':'application/octet-stream';
    res.writeHead(200,{'Content-Type':ct,'Content-Disposition':`attachment; filename="${encodeURIComponent(fn)}"`,'Content-Length':fs.statSync(resolved).size});
    fs.createReadStream(resolved).pipe(res);
    return;
  }

  // -- BROWSER AUTOMATION ------------------------------------------------
  if (pathname==='/api/auto-apply' && req.method==='POST') {
    const { jobId } = await readBody(req);
    try { return sendJSON(res, await autoBrowserApply(jobId)); }
    catch(e) { return sendJSON(res, { error: e.message }, 500); }
  }
  if (pathname.startsWith('/api/auto-apply/') && req.method==='GET') {
    const sid = pathname.slice('/api/auto-apply/'.length).split('/')[0];
    const s = autoSessions.get(sid);
    if (!s) return sendJSON(res, { status:'gone', steps:['Session abgelaufen oder nicht gefunden'], screenshot:null });
    return sendJSON(res, { status:s.status, steps:s.steps, screenshot:s.screenshot, url:s.url, letter:s.letter||'', visionRaw:s.visionRaw||null });
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
        s.steps.push('?? Bewerbung abgesendet!');
        const sc = await s.page.screenshot({ encoding:'base64', type:'jpeg', quality:80 }).catch(()=>null);
        s.screenshot = sc;
        s.url = s.page.url();
        updateJob(s.jobId, { status:'applied', applied_at: new Date().toISOString() });
        return sendJSON(res, { ok:true, screenshot:sc, url:s.url });
      } catch(e) { return sendJSON(res, { error: e.message }, 500); }
    }
    if (action === 'reopen') {
      try {
        // If status is 'error' (e.g. browser failed to launch), do a full restart
        if (s.status === 'error' || !s.browser) {
          s.status = 'starting';
          s.steps = s.steps.filter(l => !l.includes('Fehler') || s.steps.indexOf(l) < s.steps.length - 3);
          s.steps.push('Browser wird neu gestartet...');
          // Detached restart — re-run autoBrowserApply logic via reopen
        }
        const pp = getPuppeteer();
        // Close old browser if still alive
        if (s.browser) { try { await s.browser.close(); } catch(e) {} s.browser = null; s.page = null; }
        const browser = await pp.launch({
          headless: false, defaultViewport: null,
          userDataDir: path.join(__dirname, 'browser-profile'),
          args: ['--start-maximized','--no-sandbox','--disable-blink-features=AutomationControlled'],
          ignoreDefaultArgs: ['--enable-automation'],
        });
        const pages = await browser.pages();
        const page = pages[0] || await browser.newPage();
        await page.evaluateOnNewDocument(() => {
          try { delete navigator.__proto__.webdriver; } catch(e) {}
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        });
        s.browser = browser; s.page = page;
        s.status = 'waiting_manual';
        s.steps.push('🌐 Browser neu geöffnet');
        const targetUrl = s.url || (s.jobId ? (getJob(s.jobId)||{}).url : null);
        if (targetUrl) {
          try { await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }); s.steps.push(`↗ Navigiert zu: ${new URL(targetUrl).hostname}`); }
          catch(ne) { s.steps.push('⚠ Navigation fehlgeschlagen: ' + ne.message.slice(0,60)); }
        }
        browser.on('disconnected', () => {
          if (['ready','waiting_manual','filling','navigating'].includes(s.status)) {
            s.steps.push('🔴 Browser-Fenster wurde geschlossen');
            s.steps.push('👆 Klick auf "Browser öffnen" um weiterzumachen');
            s.status = 'browser_closed';
            s.browser = null; s.page = null;
          }
        });
        return sendJSON(res, { ok: true });
      } catch(e) { return sendJSON(res, { ok: false, error: e.message }, 500); }
    }
    if (action === 'applied') {
      // Mark job as applied manually (user confirmed via dialog)
      if (s.jobId) updateJob(s.jobId, { status: 'applied', applied_at: new Date().toISOString() });
      return sendJSON(res, { ok: true });
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
    if (action === 'instruct') {
      const body = await readBody(req);
      const text = (body.text||'').trim().slice(0, 800);
      if (text) {
        if (!s.pendingInstructions) s.pendingInstructions = [];
        s.pendingInstructions.push(text);
        s.steps.push(`?? Anweisung: ${text}`);
        if (s.status === 'waiting_manual') s.status = 'filling';
      }
      return sendJSON(res, { ok: true });
    }
    return sendJSON(res, { error: 'Unbekannte Aktion' }, 400);
  }

  res.writeHead(404);res.end('Not found');
});

let schedulerTimer=null;
function restartScheduler(){if(schedulerTimer)clearInterval(schedulerTimer);schedulerTimer=setInterval(()=>runScan().catch(console.error),CONFIG.SCAN_INTERVAL_MINUTES*60*1000);}
function startScheduler(){console.log(`? Scan alle ${CONFIG.SCAN_INTERVAL_MINUTES} Min`);setTimeout(()=>runScan().catch(console.error),6000);restartScheduler();}

function loadEnv(){
  try{
    if(!fs.existsSync(FILES.env))return;
    fs.readFileSync(FILES.env,'utf8').split('\n').forEach(line=>{const[k,...v]=line.split('=');if(k&&v.length)process.env[k.trim()]=v.join('=').trim();});
    if(process.env.ANTHROPIC_API_KEY)CONFIG.ANTHROPIC_API_KEY=process.env.ANTHROPIC_API_KEY;
    if(process.env.ACCESS_PIN)CONFIG.ACCESS_PIN=process.env.ACCESS_PIN;
    if(process.env.SMTP_HOST)CONFIG.SMTP_HOST=process.env.SMTP_HOST;
    if(process.env.SMTP_PORT)CONFIG.SMTP_PORT=parseInt(process.env.SMTP_PORT)||587;
    if(process.env.SMTP_USER)CONFIG.SMTP_USER=process.env.SMTP_USER;
    if(process.env.SMTP_PASS)CONFIG.SMTP_PASS=process.env.SMTP_PASS;
    if(process.env.USER_EMAIL)CONFIG.USER_EMAIL=process.env.USER_EMAIL;
    if(process.env.AI_MODE)CONFIG.AI_MODE=process.env.AI_MODE;
    if(process.env.OLLAMA_MODEL)CONFIG.OLLAMA_MODEL=process.env.OLLAMA_MODEL;
    if(process.env.OLLAMA_VISION_MODEL)CONFIG.OLLAMA_VISION_MODEL=process.env.OLLAMA_VISION_MODEL;
    if(process.env.OLLAMA_LETTER_MODEL)CONFIG.OLLAMA_LETTER_MODEL=process.env.OLLAMA_LETTER_MODEL;
    if(process.env.OLLAMA_URL)CONFIG.OLLAMA_URL=process.env.OLLAMA_URL;
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
cleanWrongLocalJobs();
const nets=require('os').networkInterfaces();
let localIP='localhost';
for(const iface of Object.values(nets).flat()){if(iface.family==='IPv4'&&!iface.internal){localIP=iface.address;break;}}

server.listen(CONFIG.PORT,'0.0.0.0',()=>{
  const line = '='.repeat(54);
  console.log(`\n${line}`);
  console.log(`  JobHunter AI  --  Server laeuft!`);
  console.log(line);
  console.log(`\n  PC:      http://localhost:${CONFIG.PORT}`);
  console.log(`  iPhone:  http://${localIP}:${CONFIG.PORT}  <-- diese Adresse!`);
  console.log('  Tipp: In Safari oeffnen > Teilen > Zum Home-Bildschirm');
  console.log(`${'-'.repeat(54)}`);
  console.log(`  ${CONFIG.ANTHROPIC_API_KEY ? '[OK] API Key geladen' : '[!]  Kein API Key --> in App unter Einstellungen'}`);
  console.log(`${'-'.repeat(54)}\n`);
  startScheduler();
});
server.on('error',e=>{if(e.code==='EADDRINUSE')console.error(`\n? Port ${CONFIG.PORT} belegt.`);else console.error('Fehler:',e.message);process.exit(1);});

// Prevent server crash from unhandled promise rejections / exceptions in scan/scraper code
process.on('uncaughtException', (err) => {
  console.error('[!] Uncaught Exception (Server läuft weiter):', err.message);
  console.error(err.stack ? err.stack.split('\n').slice(0,5).join('\n') : '');
});
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error('[!] Unhandled Rejection (Server läuft weiter):', msg);
});

