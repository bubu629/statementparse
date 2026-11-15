// src/parser.ts
export interface ParsedTransaction {
  tx_index: number;
  post_date: string;
  description: string;
  payee_normalized: string;
  category_account: string;
  amount_cents: number; // positive = credit/deposit, negative = debit/withdrawal
  amount_formatted: string;
  running_balance_cents: number | null;
  anomaly_flag: string;
}

export interface ReconciliationAudit {
  institution: string;
  opening_balance_cents: number;
  closing_balance_cents: number;
  computed_closing_cents: number;
  discrepancy_cents: number;
  is_balanced: boolean;
  total_credits_cents: number;
  total_debits_cents: number;
  duplicate_suspects: number;
  ocr_sign_flips_fixed: number;
  rows: ParsedTransaction[];
}

const CATEGORY_RULES: Array<{ pattern: RegExp; payee: string; account: string }> = [
  { pattern: /STRIPE|SHOPIFY PAYOUT/i, payee: 'Stripe / Shopify Payout', account: '4000 - Sales Revenue' },
  { pattern: /AWS|AMAZON WEB SERVICES|DIGITALOCEAN|CLOUDFLARE/i, payee: 'Cloud Infrastructure', account: '6120 - Hosting & Cloud Services' },
  { pattern: /GOOGLE \*ADS|FACEBK|META ADS|TIKTOK/i, payee: 'Digital Advertising', account: '6200 - Advertising & Marketing' },
  { pattern: /CANADA POST|UPS|FEDEX|DHL/i, payee: 'Logistics & Freight', account: '5200 - Shipping & Delivery' },
  { pattern: /CRA|IRS|TAX|RECEIVER GENERAL/i, payee: 'Tax Authority', account: '2200 - Taxes Payable' },
  { pattern: /SERVICE CHARGE|MONTHLY FEE|WIRE FEE|FX FEE/i, payee: 'Bank Service Fee', account: '6040 - Bank Charges & Fees' }
];

export const SAMPLE_RAW_STATEMENT = `INSTITUTION: RBC ROYAL BANK BUSINESS OPERATING ACCOUNT
OPENING_BALANCE: 14500.00
CLOSING_BALANCE: 17124.45
---TRANSACTIONS---
2026-10-02 | STRIPE TRANSFER CA-99281 | +3420.50 | BAL: 17920.50
2026-10-04 | AWS CLOUD SERVICES USD 210.00 @ 1.3600 | -285.60 | BAL: 17634.90
2026-10-05 | AWS CLOUD SERVICES USD 210.00 @ 1.3600 | -285.60 | BAL: 17349.30
2026-10-09 | CANADA POST COMMERCIAL #441 | -142.85 | BAL: 17206.45
2026-10-12 | GOOGLE *ADS CC-8821 | 450.00 CR-OCR-FLIP-DEBIT | BAL: 16756.45
2026-10-18 | SHOPIFY PAYOUT #88412 | +1920.00 | BAL: 18676.45
2026-10-22 | META ADS IRELAND | -612.00 | BAL: 18064.45
2026-10-25 | CRA RECEIVER GENERAL GST/HST | -915.00 | BAL: 17149.45
2026-10-31 | MONTHLY ACCOUNT SERVICE CHARGE | -25.00 | BAL: 17124.45`;

function parseDollarsToCents(raw: string): number {
  const cleaned = raw.replace(/[^0-9.-]/g, '');
  const val = parseFloat(cleaned || '0');
  return Math.round(val * 100);
}

export function scrubAndReconcileStatement(rawText: string, institutionOverride?: string): ReconciliationAudit {
  const lines = rawText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let institution = institutionOverride || 'RBC';
  let openingCents = 0;
  let closingCents = 0;

  const rows: ParsedTransaction[] = [];
  let duplicateSuspects = 0;
  let ocrFlipsFixed = 0;
  const seenFingerprints = new Set<string>();

  let runningTracker = 0;
  let txIndex = 1;

  for (const line of lines) {
    if (line.startsWith('INSTITUTION:')) {
      institution = line.replace('INSTITUTION:', '').trim();
      continue;
    }
    if (line.startsWith('OPENING_BALANCE:')) {
      openingCents = parseDollarsToCents(line.replace('OPENING_BALANCE:', ''));
      runningTracker = openingCents;
      continue;
    }
    if (line.startsWith('CLOSING_BALANCE:')) {
      closingCents = parseDollarsToCents(line.replace('CLOSING_BALANCE:', ''));
      continue;
    }
    if (line.startsWith('---')) continue;

    // Parse transaction line: YYYY-MM-DD | DESC | AMT | BAL: XXX
    const parts = line.split('|').map((p) => p.trim());
    if (parts.length < 3) continue;

    const [dateStr, desc, amtPart, balPart] = parts;
    let amountCents = parseDollarsToCents(amtPart);
    const statedBalCents = balPart ? parseDollarsToCents(balPart.replace(/BAL:/i, '')) : null;

    const anomalies: string[] = [];

    // 1. Detect & auto-heal OCR sign flip (e.g., OCR read a debit as positive, but running balance decreased!)
    if (statedBalCents !== null) {
      if (runningTracker + amountCents !== statedBalCents && runningTracker - amountCents === statedBalCents) {
        amountCents = -amountCents;
        ocrFlipsFixed++;
        anomalies.push('AUTO_HEALED_OCR_SIGN_FLIP');
      }
      runningTracker = statedBalCents;
    } else {
      runningTracker += amountCents;
    }

    // 2. Detect duplicate same-amount vendor charges within statement
    const fp = `${desc}:${amountCents}`;
    if (seenFingerprints.has(fp)) {
      duplicateSuspects++;
      anomalies.push('SUSPECTED_DUPLICATE_CHARGE');
    }
    seenFingerprints.add(fp);

    // 3. Categorize for QuickBooks / Xero Chart of Accounts
    let payee = desc.slice(0, 28);
    let account = amountCents >= 0 ? '4000 - Uncategorized Income' : '6900 - Uncategorized Expense';
    for (const rule of CATEGORY_RULES) {
      if (rule.pattern.test(desc)) {
        payee = rule.payee;
        account = rule.account;
        break;
      }
    }

    rows.push({
      tx_index: txIndex++,
      post_date: dateStr,
      description: desc,
      payee_normalized: payee,
      category_account: account,
      amount_cents: amountCents,
      amount_formatted: (amountCents / 100).toFixed(2),
      running_balance_cents: statedBalCents,
      anomaly_flag: anomalies.length > 0 ? anomalies.join('; ') : 'CLEAN'
    });
  }

  const totalCredits = rows.filter((r) => r.amount_cents > 0).reduce((s, r) => s + r.amount_cents, 0);
  const totalDebits = rows.filter((r) => r.amount_cents < 0).reduce((s, r) => s + r.amount_cents, 0);
  const computedClosing = openingCents + totalCredits + totalDebits;
  const discrepancy = closingCents - computedClosing;

  return {
    institution,
    opening_balance_cents: openingCents,
    closing_balance_cents: closingCents,
    computed_closing_cents: computedClosing,
    discrepancy_cents: discrepancy,
    is_balanced: discrepancy === 0,
    total_credits_cents: totalCredits,
    total_debits_cents: totalDebits,
    duplicate_suspects: duplicateSuspects,
    ocr_sign_flips_fixed: ocrFlipsFixed,
    rows
  };
}
