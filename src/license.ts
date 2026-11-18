// src/license.ts
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface LicensePayload {
  license_id: string;
  tier: 'COMMUNITY' | 'PERSONAL' | 'PRO';
  max_rows: number;
  unlocked_banks: string[];
  batch_export: boolean;
  issued_at: string;
  expires_at: string | null;
}

export let EMBEDDED_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAjRfipO5f8zBIxFY3ts40Z7Zj8SogCoMztww+jDgZsDw=
-----END PUBLIC KEY-----`;

const LICENSE_FILE = path.join(os.homedir(), '.statementparse', 'license.key');

export function signOfflineLicense(payload: LicensePayload, privateKeyPem: string): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto.sign(null, Buffer.from(payloadB64, 'utf8'), privateKeyPem);
  return `SP1.${payloadB64}.${signature.toString('base64url')}`;
}

export function verifyOfflineLicense(licenseKey: string, pubKeyPem = EMBEDDED_PUBLIC_KEY): {
  valid: boolean;
  reason?: string;
  payload?: LicensePayload;
} {
  try {
    const parts = licenseKey.trim().split('.');
    if (parts.length !== 3 || parts[0] !== 'SP1') {
      return { valid: false, reason: 'Invalid format (Expected SP1.<payload>.<sig>)' };
    }
    const [, payloadB64, sigB64] = parts;
    const isVerified = crypto.verify(
      null,
      Buffer.from(payloadB64, 'utf8'),
      pubKeyPem,
      Buffer.from(sigB64, 'base64url')
    );
    if (!isVerified) {
      return { valid: false, reason: 'Ed25519 signature verification failed' };
    }
    const payload: LicensePayload = JSON.parse(
      Buffer.from(payloadB64, 'base64url').toString('utf8')
    );
    if (payload.expires_at && new Date(payload.expires_at).getTime() < Date.now()) {
      return { valid: false, reason: `License expired on ${payload.expires_at}` };
    }
    return { valid: true, payload };
  } catch {
    return { valid: false, reason: 'Malformed license key' };
  }
}

export function saveAndActivateLicense(licenseKey: string, pubKeyPem = EMBEDDED_PUBLIC_KEY) {
  const check = verifyOfflineLicense(licenseKey, pubKeyPem);
  if (!check.valid || !check.payload) return check;
  fs.mkdirSync(path.dirname(LICENSE_FILE), { recursive: true });
  fs.writeFileSync(LICENSE_FILE, licenseKey.trim(), 'utf8');
  return check;
}

export function loadSavedLicense(pubKeyPem = EMBEDDED_PUBLIC_KEY): LicensePayload | null {
  try {
    if (!fs.existsSync(LICENSE_FILE)) return null;
    const raw = fs.readFileSync(LICENSE_FILE, 'utf8');
    const check = verifyOfflineLicense(raw, pubKeyPem);
    return check.valid && check.payload ? check.payload : null;
  } catch {
    return null;
  }
}
