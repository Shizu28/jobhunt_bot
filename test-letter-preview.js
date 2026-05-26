/**
 * Playwright test: Anschreiben-Preview im Bot-Overlay
 *
 * Prüft: Sobald im Auto-Apply-Log "Anschreiben (Deutsch)" oder
 * "Anschreiben (Englisch)" geloggt wird, muss #autoLetterText
 * tatsächlich den generierten Brief enthalten – NICHT mehr
 * "⏳ Anschreiben wird generiert..."
 *
 * Voraussetzung: Server läuft auf http://localhost:3000
 * Starten: node test-letter-preview.js
 */

const { chromium } = require('playwright');
const http = require('http');

const BASE = 'http://localhost:3000';
const PIN  = '2810';
const LETTER_TIMEOUT_MS = 180_000; // 3 min – Ollama kann langsam sein

function apiCall(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: '127.0.0.1', port: 3000, path, method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (token) opts.headers['Authorization'] = 'Bearer ' + token;
    if (data)  opts.headers['Content-Length'] = Buffer.byteLength(data);
    const req = http.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error('Bad JSON: ' + d.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  let browser;
  let exitCode = 0;

  try {
    // ── 0. Login via API to get token and a valid job ID ──────────────────
    console.log('[test] 1/7  API-Login...');
    const loginRes = await apiCall('POST', '/api/auth/login', { pin: PIN });
    const token = loginRes.token;
    if (!token) throw new Error('Login fehlgeschlagen: ' + JSON.stringify(loginRes));

    console.log('[test] 2/7  Test-Modelle setzen...');
    await apiCall('POST', '/api/config', {
      aiMode: 'ollama',
      ollamaModel: 'qwen3.5:4b',
      ollamaLetterModel: 'qwen3.5:4b',
    }, token);

    console.log('[test] 3/7  Jobs laden...');
    const jobsRes = await apiCall('GET', '/api/jobs', null, token);
    const jobs = Array.isArray(jobsRes) ? jobsRes : (jobsRes.jobs || []);
    if (jobs.length === 0) throw new Error('Keine Jobs in der Datenbank');

    // Prefer a job with a URL (needed for browser automation) and status=new
    const job = jobs.find(j => j.url && j.status === 'new')
              || jobs.find(j => j.url)
              || jobs[0];
    if (!job) throw new Error('Kein geeigneter Job gefunden');
    console.log(`[test]       Job: ${job.title} · ${job.company} (id=${job.id})`);

    // ── 1. Browser starten ────────────────────────────────────────────────
    console.log('[test] 4/7  Browser starten...');
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    // ── 2. Login via UI ───────────────────────────────────────────────────
    console.log('[test] 5/7  UI-Login...');
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#authPinInput', { state: 'visible', timeout: 10_000 });
    await page.fill('#authPinInput', PIN);
    await page.press('#authPinInput', 'Enter');

    // Wait until jobs are actually loaded (jobList has something other than "Lade Jobs...")
    await page.waitForFunction(
      () => {
        const el = document.getElementById('jobList');
        return el && !el.textContent.includes('Lade Jobs');
      },
      { timeout: 15_000 }
    );
    console.log('[test]       Eingeloggt, Jobs sichtbar');

    // ── 3. Direkt zu /?auto=<jobId> navigieren ────────────────────────────
    console.log('[test] 6/7  Auto-Apply starten...');
    const autoUrl = `${BASE}/?auto=${encodeURIComponent(job.id)}`;
    await page.goto(autoUrl, { waitUntil: 'domcontentloaded' });

    // Overlay muss erscheinen
    await page.waitForSelector('#autoOverlay', { state: 'visible', timeout: 10_000 });
    console.log('[test]       Overlay erschienen');

    // ── 4. Warten bis "Anschreiben (" im Log steht ────────────────────────
    console.log(`[test]       Warte auf Anschreiben-Schritt (max ${LETTER_TIMEOUT_MS / 1000}s)...`);
    await page.waitForFunction(
      () => {
        const el = document.getElementById('autoSteps');
        return el && el.textContent.includes('Anschreiben (');
      },
      { timeout: LETTER_TIMEOUT_MS }
    );
    console.log('[test]       ✓ Log zeigt: Anschreiben generiert');

    // Poll-Intervall abwarten (pollAutoSession feuert alle 1800 ms)
    await page.waitForTimeout(4_000);

    // ── 5. Preview prüfen ─────────────────────────────────────────────────
    console.log('[test] 7/7  Preview prüfen...');
    const letterText = await page.$eval('#autoLetterText', el => el.textContent.trim());

    const isLoading  = letterText.includes('Anschreiben wird generiert');
    const isEmpty    = letterText.length < 30;

    console.log(`[test]       #autoLetterText Länge: ${letterText.length} Zeichen`);
    console.log(`[test]       Erste 120 Zeichen: ${letterText.substring(0, 120).replace(/\n/g, '↵')}`);

    if (isLoading) {
      console.error('\n[FAIL] ❌  Preview zeigt noch immer den Lade-Platzhalter!');
      console.error('           → r.letter ist wahrscheinlich leer (Ollama think-Bug)');
      exitCode = 1;
    } else if (isEmpty) {
      console.error('\n[FAIL] ❌  Preview ist leer oder zu kurz!');
      exitCode = 1;
    } else {
      console.log('\n[PASS] ✅  Anschreiben korrekt in der Preview sichtbar!');
    }

  } catch (e) {
    console.error('\n[ERROR]', e.message);
    exitCode = 1;
  } finally {
    if (browser) await browser.close();
  }

  process.exit(exitCode);
})();
