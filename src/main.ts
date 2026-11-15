// src/main.ts
import Fastify from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { stringify } from 'csv-stringify/sync';
import { scrubAndReconcileStatement, SAMPLE_RAW_STATEMENT } from './parser.js';
import { LicensePayload, saveAndActivateLicense, loadSavedLicense } from './license.js';

const app = Fastify({ logger: false });

const COMMUNITY_DEFAULT: LicensePayload = {
  license_id: 'community-free',
  tier: 'COMMUNITY',
  max_rows: 5,
  unlocked_banks: ['RBC'],
  batch_export: false,
  issued_at: new Date().toISOString(),
  expires_at: null
};

let activeLicense: LicensePayload = loadSavedLicense() || COMMUNITY_DEFAULT;

function openBrowser(url: string) {
  const cmd =
    process.platform === 'win32'
      ? `start "" "${url}"`
      : process.platform === 'darwin'
      ? `open "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd);
}

app.get('/api/license/status', async () => ({ ok: true, license: activeLicense, sample: SAMPLE_RAW_STATEMENT }));

app.post('/api/license/activate', async (req, reply) => {
  const { license_key } = req.body as { license_key: string };
  const res = saveAndActivateLicense(license_key);
  if (!res.valid || !res.payload) {
    return reply.status(400).send({ ok: false, error: res.reason });
  }
  activeLicense = res.payload;
  return { ok: true, license: activeLicense };
});

app.post('/api/scrub', async (req, reply) => {
  const { raw_text, institution } = req.body as { raw_text: string; institution: string };
  if (!activeLicense.unlocked_banks.includes(institution)) {
    return reply.status(403).send({
      ok: false,
      error: `[${activeLicense.tier} Limit] Institution "${institution}" parser rules require a Personal ($39) or Pro ($99) offline license.`
    });
  }

  const audit = scrubAndReconcileStatement(raw_text || SAMPLE_RAW_STATEMENT, institution);
  if (audit.rows.length > activeLicense.max_rows) {
    return reply.status(403).send({
      ok: false,
      error: `[${activeLicense.tier} Limit] Statement contains ${audit.rows.length} rows, but Community mode only exports up to ${activeLicense.max_rows} rows. Activate a license key to unlock full export.`
    });
  }

  const outDir = path.resolve(process.cwd(), 'StatementParse_Output');
  fs.mkdirSync(outDir, { recursive: true });

  // Export QuickBooks Online & Xero compatible CSVs
  const qboCsv = stringify(
    audit.rows.map((r) => ({
      Date: r.post_date,
      Description: r.description,
      Amount: r.amount_formatted,
      Payee: r.payee_normalized,
      Account: r.category_account,
      Audit_Flag: r.anomaly_flag
    })),
    { header: true }
  );

  const outFile = path.join(outDir, `QuickBooks_Xero_Ready_${Date.now()}.csv`);
  fs.writeFileSync(outFile, qboCsv, 'utf8');

  return {
    ok: true,
    output_file: outFile,
    audit
  };
});

app.get('/', async (_req, reply) => {
  reply.type('text/html; charset=utf-8').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>StatementParse Desktop — 100% Air-Gapped Bank & E-Com Scrubber</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 24px; }
    .container { max-width: 980px; margin: 0 auto; }
    .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #334155; padding-bottom: 16px; }
    .badge { background: #1e293b; border: 1px solid #38bdf8; color: #38bdf8; padding: 6px 14px; border-radius: 999px; font-size: 13px; font-weight: 600; }
    .grid { display: grid; grid-template-columns: 1.2fr 0.8fr; gap: 20px; margin-top: 20px; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 20px; }
    label { display: block; font-size: 13px; color: #94a3b8; margin-top: 12px; }
    input, select, textarea { width: 100%; padding: 8px; margin-top: 4px; background: #0f172a; border: 1px solid #475569; color: #fff; border-radius: 4px; box-sizing: border-box; font-family: monospace; }
    button { background: #2563eb; color: #fff; border: none; padding: 10px 18px; border-radius: 6px; cursor: pointer; font-weight: 600; margin-top: 16px; width: 100%; }
    pre { background: #020617; padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 12px; color: #4ade80; min-height: 180px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h2 style="margin:0;">StatementParse Desktop <span style="font-weight:normal;font-size:14px;color:#94a3b8;">AIR-GAPPED PDF/TEXT TO QUICKBOOKS & XERO</span></h2>
      <div id="tierBadge" class="badge">Loading...</div>
    </div>
    <div class="grid">
      <div class="card">
        <h3 style="margin-top:0;">1. Select Institution Rule & Paste Statement Text</h3>
        <label>Bank / Settlement Platform Profile</label>
        <select id="institution">
          <option value="RBC">RBC Royal Bank (Canada)</option>
          <option value="TD">TD Canada Trust (Pro/Personal)</option>
          <option value="BMO">BMO Bank of Montreal (Pro/Personal)</option>
          <option value="CHASE">Chase Commercial (US - Pro/Personal)</option>
          <option value="STRIPE">Stripe Multi-Currency Settlement (Pro/Personal)</option>
          <option value="AMAZON">Amazon Seller Central Settlement (Pro)</option>
        </select>
        <label>Raw Extracted Statement Lines (100% Processed Locally — Never Leaves Your PC)</label>
        <textarea id="rawText" rows="11"></textarea>
        <button onclick="runScrubber()">Auto-Heal OCR Flips, Reconcile & Export QuickBooks CSV</button>
      </div>
      <div class="card">
        <h3 style="margin-top:0;">2. Offline License Activation (SP1.xxx)</h3>
        <label>Paste SP1.xxx Key (Saved to ~/.statementparse)</label>
        <input type="text" id="licenseKey" placeholder="SP1.eyJsaWNlbnNlX2lk..." />
        <button style="background:#059669;" onclick="activateKey()">Activate Offline License</button>
        <h3 style="margin-top:20px;">3. Audit & Auto-Reconciliation Report</h3>
        <pre id="outputLog">Ready. Community limit: 5 rows max.</pre>
      </div>
    </div>
  </div>
  <script>
    async function init() {
      const res = await fetch('/api/license/status');
      const data = await res.json();
      document.getElementById('rawText').value = data.sample;
      updateBadge(data.license);
    }
    function updateBadge(lic) {
      document.getElementById('tierBadge').innerText = 'Tier: ' + lic.tier + ' (Max ' + lic.max_rows + ' Rows)';
    }
    async function activateKey() {
      const key = document.getElementById('licenseKey').value;
      const res = await fetch('/api/license/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ license_key: key })
      });
      const data = await res.json();
      if (!data.ok) return alert(data.error);
      updateBadge(data.license);
      document.getElementById('outputLog').innerText = '✅ License activated offline! Unlocked all North American bank profiles & up to ' + data.license.max_rows + ' rows.';
    }
    async function runScrubber() {
      const res = await fetch('/api/scrub', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          institution: document.getElementById('institution').value,
          raw_text: document.getElementById('rawText').value
        })
      });
      const data = await res.json();
      if (!data.ok) {
        document.getElementById('outputLog').innerText = '❌ ' + data.error;
        return;
      }
      document.getElementById('outputLog').innerText =
        '✅ Exported CSV: ' + data.output_file +
        '\nBalanced: ' + (data.audit.is_balanced ? 'YES (0 Discrepancy)' : 'NO') +
        '\nOCR Sign Flips Fixed: ' + data.audit.ocr_sign_flips_fixed +
        '\nDuplicate Charges Flagged: ' + data.audit.duplicate_suspects +
        '\n\n' + JSON.stringify(data.audit, null, 2);
    }
    init();
  </script>
</body>
</html>`);
});

app.listen({ port: 4568, host: '127.0.0.1' }).then(() => {
  const url = 'http://127.0.0.1:4568';
  console.log(`🚀 StatementParse Desktop running at ${url}`);
  openBrowser(url);
});
