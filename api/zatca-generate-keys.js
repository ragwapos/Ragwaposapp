import { createClient } from '@supabase/supabase-js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import * as asn1js from 'asn1js';
import { verifyTenantSession } from './_auth.js';
import { checkRateLimit } from './_rateLimit.js';
import { Sentry } from './_sentry.js';
import { applyCors } from './_cors.js';

// Server-side only, same pattern as send-verification-email.js: the tenant's
// ZATCA private key and the AES key that encrypts it must never reach the
// browser. SUPABASE_SERVICE_ROLE_KEY / ZATCA_ENCRYPTION_KEY are private
// Vercel env vars — ZATCA_ENCRYPTION_KEY must be a 32-byte value, base64 or
// hex encoded, generated once and stored in Vercel project settings (never
// committed). This file is the only place in the project allowed to hold
// either the encryption key or a decrypted private key.
const supabaseAdmin = createClient(
  'https://qepsmlnozznqfybavyix.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ---- AES-256-GCM encryption for the private key at rest ----
async function importAesKey() {
  const raw = process.env.ZATCA_ENCRYPTION_KEY;
  if (!raw) throw new Error('ZATCA_ENCRYPTION_KEY is not configured');
  // Accept either hex or base64 — whichever was used when the key was generated.
  const bytes = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Uint8Array.from(raw.match(/.{2}/g).map((b) => parseInt(b, 16)))
    : Uint8Array.from(Buffer.from(raw, 'base64'));
  if (bytes.length !== 32) throw new Error('ZATCA_ENCRYPTION_KEY must decode to exactly 32 bytes');
  const { webcrypto } = await import('node:crypto');
  return webcrypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function encryptPrivateKey(privateKeyHex) {
  const { webcrypto } = await import('node:crypto');
  const key = await importAesKey();
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(privateKeyHex);
  const ciphertext = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return `${Buffer.from(iv).toString('hex')}:${Buffer.from(ciphertext).toString('hex')}`;
}

// ---- Minimal PKCS#10 CSR builder (secp256k1) ----
// Web Crypto / Node's built-in crypto do not implement the secp256k1 curve
// ZATCA requires (it's the Bitcoin/Ethereum curve, not one of the NIST
// curves browsers/Node ship natively) — @noble/curves does the actual EC
// math in pure JS, and asn1js builds the DER structure by hand around it.
const OID = {
  countryName: '2.5.4.6',
  organizationName: '2.5.4.10',
  organizationalUnitName: '2.5.4.11',
  commonName: '2.5.4.3',
  idEcPublicKey: '1.2.840.10045.2.1',
  secp256k1: '1.3.132.0.10',
  ecdsaWithSha256: '1.2.840.10045.4.3.2',
  extensionRequest: '1.2.840.113549.1.9.14',
  subjectAltName: '2.5.29.17',
};

function rdn(oid, value) {
  return new asn1js.Set({
    value: [
      new asn1js.Sequence({
        value: [
          new asn1js.ObjectIdentifier({ value: oid }),
          new asn1js.Utf8String({ value }),
        ],
      }),
    ],
  });
}

// NOTE — the fields below (organization identifier, invoice type, address,
// business category) go into the CSR as a ZATCA-specific subjectAltName
// "otherName" extension whose exact OIDs are published in ZATCA's own CSR
// generation guide / SDK sample config, not in any general X.509 spec.
// This implementation encodes them as an IA5String directory-name-style
// blob in the conventional "key:value" order ZATCA's own tooling produces,
// but — unlike the standard C/O/OU/CN fields above, which are ordinary
// X.509 and certain to be correct — THIS PART HAS NEVER BEEN VALIDATED
// AGAINST ZATCA'S REAL COMPLIANCE API and must be cross-checked against
// their official csr-config-example / onboarding docs once real sandbox
// access exists, before this CSR is ever submitted for real.
function buildZatcaSanExtension({ egsSerial, vatNumber, invoiceType, address, businessCategory }) {
  const otherNameValue = new asn1js.Utf8String({
    value: [
      `1-${egsSerial}`,
      `2-${vatNumber}`,
      `3-${invoiceType}`,
      `4-${address}`,
      `5-${businessCategory}`,
    ].join('|'),
  });
  const generalName = new asn1js.Constructed({
    idBlock: { tagClass: 3, tagNumber: 0 }, // [0] otherName
    value: [otherNameValue],
  });
  const sanValue = new asn1js.Sequence({ value: [generalName] });
  return { extnID: OID.subjectAltName, extnValue: sanValue.toBER(false) };
}

function buildCsr({ privateKeyBytes, publicKeyBytes, subject, zatcaFields }) {
  const subjectSeq = new asn1js.Sequence({
    value: [
      rdn(OID.countryName, subject.country),
      rdn(OID.organizationName, subject.organization),
      rdn(OID.organizationalUnitName, subject.organizationalUnit),
      rdn(OID.commonName, subject.commonName),
    ],
  });

  const spki = new asn1js.Sequence({
    value: [
      new asn1js.Sequence({
        value: [
          new asn1js.ObjectIdentifier({ value: OID.idEcPublicKey }),
          new asn1js.ObjectIdentifier({ value: OID.secp256k1 }),
        ],
      }),
      new asn1js.BitString({ valueHex: publicKeyBytes }),
    ],
  });

  const san = buildZatcaSanExtension(zatcaFields);
  const extensionValueOctet = new asn1js.OctetString({ valueHex: san.extnValue });
  const extensions = new asn1js.Sequence({
    value: [
      new asn1js.Sequence({
        value: [
          new asn1js.ObjectIdentifier({ value: san.extnID }),
          extensionValueOctet,
        ],
      }),
    ],
  });
  const extensionRequestAttr = new asn1js.Sequence({
    value: [
      new asn1js.ObjectIdentifier({ value: OID.extensionRequest }),
      new asn1js.Set({ value: [extensions] }),
    ],
  });
  const attributes = new asn1js.Constructed({
    idBlock: { tagClass: 3, tagNumber: 0 }, // [0] attributes
    value: [extensionRequestAttr],
  });

  const certificationRequestInfo = new asn1js.Sequence({
    value: [
      new asn1js.Integer({ value: 0 }),
      subjectSeq,
      spki,
      attributes,
    ],
  });

  const tbs = certificationRequestInfo.toBER(false);
  // secp256k1.sign() defaults to prehash: true (it hashes the message
  // itself internally) — passing an already-hashed digest here without
  // { prehash: false } double-hashes it. That bug shipped once already:
  // it produced a signature that verified fine against noble's own
  // verify() (self-consistent, since sign+verify both double-hashed) but
  // failed every external verifier, including OpenSSL, which computes the
  // standard single SHA-256 ecdsa-with-SHA256 expects. Pass the raw TBS
  // bytes and let noble hash them exactly once.
  const signature = secp256k1.sign(new Uint8Array(tbs), privateKeyBytes, { format: 'der' });

  const csr = new asn1js.Sequence({
    value: [
      certificationRequestInfo,
      new asn1js.Sequence({ value: [new asn1js.ObjectIdentifier({ value: OID.ecdsaWithSha256 })] }),
      new asn1js.BitString({ valueHex: signature }),
    ],
  });

  const der = Buffer.from(csr.toBER(false));
  const b64 = der.toString('base64');
  const pem = `-----BEGIN CERTIFICATE REQUEST-----\n${b64.match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE REQUEST-----`;
  return pem;
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });

  const { tenantId, organizationName, vatNumber, address, businessCategory, egsSerial } = req.body || {};
  if (!tenantId || !organizationName || !vatNumber) {
    return res.status(400).json({ success: false, error: 'tenantId, organizationName, and vatNumber are required' });
  }

  const authResult = await verifyTenantSession(req, supabaseAdmin, tenantId);
  if (!authResult.ok) return res.status(authResult.status).json({ success: false, error: authResult.error });

  // Every call replaces the tenant's existing ZATCA keypair outright (see
  // the upsert below) — a legitimate tenant only ever needs this a handful
  // of times (initial setup, occasional re-key), so a tight limit here is
  // pure abuse/self-thrash protection, not something normal use would hit.
  if (!(await checkRateLimit(res, 'zatca-generate-keys', tenantId, 5, '1 h'))) return;

  try {
    const privateKeyBytes = secp256k1.utils.randomSecretKey();
    const publicKeyBytes = secp256k1.getPublicKey(privateKeyBytes, false); // uncompressed
    const privateKeyHex = Buffer.from(privateKeyBytes).toString('hex');
    const publicKeyHex = Buffer.from(publicKeyBytes).toString('hex');

    const csrPem = buildCsr({
      privateKeyBytes,
      publicKeyBytes,
      subject: {
        country: 'SA',
        organization: organizationName,
        organizationalUnit: organizationName,
        commonName: egsSerial || `EGS-${tenantId.slice(0, 8)}`,
      },
      zatcaFields: {
        egsSerial: egsSerial || `EGS-${tenantId.slice(0, 8)}`,
        vatNumber,
        invoiceType: '1100', // standard + simplified tax invoices
        address: address || '',
        businessCategory: businessCategory || '',
      },
    });

    const encryptedPrivateKey = await encryptPrivateKey(privateKeyHex);

    const { error } = await supabaseAdmin
      .from('zatca_configurations')
      .upsert({
        tenant_id: tenantId,
        encrypted_private_key: encryptedPrivateKey,
        public_key: publicKeyHex,
        csr: csrPem,
        certificate_status: 'PENDING',
      }, { onConflict: 'tenant_id' });
    if (error) throw error;

    return res.status(200).json({ success: true, publicKey: publicKeyHex, csr: csrPem });
  } catch (e) {
    console.error('zatca-generate-keys error', e);
    Sentry.captureException(e);
    return res.status(200).json({ success: false, error: e.message || String(e) });
  }
}
