// tests/parser.test.ts
import { describe, it, expect } from 'vitest';
import { scrubAndReconcileStatement, SAMPLE_RAW_STATEMENT } from '../src/parser.js';

describe('StatementParse Desktop Engine', () => {
  it('auto-heals OCR sign flips, flags duplicates, and reconciles opening/closing balances to the penny', () => {
    const audit = scrubAndReconcileStatement(SAMPLE_RAW_STATEMENT, 'RBC');
    expect(audit.is_balanced).toBe(true);
    expect(audit.discrepancy_cents).toBe(0);
    expect(audit.ocr_sign_flips_fixed).toBe(1);
    expect(audit.duplicate_suspects).toBe(1);
    expect(audit.rows.length).toBe(9);
  });
});
