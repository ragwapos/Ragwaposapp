import { createClient } from '@supabase/supabase-js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { verifyTenantSession } from './_auth.js';

// Server-side only, same pattern as zatca-generate-keys.js — the tenant's
// decrypted private key must never leave this function.
const supabaseAdmin = createClient(
  'https://qepsmlnozznqfybavyix.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function importAesKey() {
  const raw = process.env.ZATCA_ENCRYPTION_KEY;
  if (!raw) throw new Error('ZATCA_ENCRYPTION_KEY is not configured');
  const bytes = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Uint8Array.from(raw.match(/.{2}/g).map((b) => parseInt(b, 16)))
    : Uint8Array.from(Buffer.from(raw, 'base64'));
  if (bytes.length !== 32) throw new Error('ZATCA_ENCRYPTION_KEY must decode to exactly 32 bytes');
  const { webcrypto } = await import('node:crypto');
  return webcrypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function decryptPrivateKey(encoded) {
  const { webcrypto } = await import('node:crypto');
  const key = await importAesKey();
  const [ivHex, ctHex] = encoded.split(':');
  const iv = Uint8Array.from(ivHex.match(/.{2}/g).map((b) => parseInt(b, 16)));
  const ct = Uint8Array.from(ctHex.match(/.{2}/g).map((b) => parseInt(b, 16)));
  const plaintext = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new TextDecoder().decode(plaintext);
}

// ---- ZATCA Phase 1 QR (5-tag), reused as the base for the Phase 2 QR ----
// This has to mirror src/App.jsx's buildZatcaQrBase64 exactly (kept as a
// separate copy here on purpose: this file runs in Vercel's Node runtime,
// that one runs in the browser, and neither api/ nor src/ can import
// across that boundary in this project's build setup) — if one changes,
// the other must change with it.
function tlv(tag, valueBytes) {
  const out = new Uint8Array(2 + valueBytes.length);
  out[0] = tag; out[1] = valueBytes.length; out.set(valueBytes, 2);
  return out;
}
function tlvUtf8(tag, str) { return tlv(tag, new TextEncoder().encode(String(str ?? ''))); }
function concatBytes(arrays) {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  arrays.forEach((a) => { out.set(a, offset); offset += a.length; });
  return out;
}

// Phase 2 QR: tags 1-5 identical to Phase 1, plus 6 (invoice hash), 7 (ECDSA
// signature), 8 (EC public key), 9 (certificate signature — genuinely
// impossible to produce without a real CSID from ZATCA, so it's included
// as an empty tag until real onboarding happens; ZATCA's own validator is
// what ultimately confirms whether an empty tag 9 is acceptable pre-cert
// or whether Phase 2 clearance requires it populated).
function buildPhase2QrBase64({ sellerName, vatNumber, isoDateTime, total, vatTotal, invoiceHashHex, signatureBytes, publicKeyBytes }) {
  const invoiceHashBytes = Uint8Array.from(Buffer.from(invoiceHashHex, 'hex'));
  const tags = [
    tlvUtf8(1, sellerName),
    tlvUtf8(2, vatNumber),
    tlvUtf8(3, isoDateTime),
    tlvUtf8(4, total),
    tlvUtf8(5, vatTotal),
    tlv(6, invoiceHashBytes),
    tlv(7, signatureBytes),
    tlv(8, publicKeyBytes),
    tlv(9, new Uint8Array(0)),
  ];
  return Buffer.from(concatBytes(tags)).toString('base64');
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---- UBL 2.1 Simplified Tax Invoice body ----
// Covers the core required elements (header, PIH reference, supplier
// party, tax totals, legal monetary total, invoice lines) using the
// standard UBL 2.1 + ZATCA CommonAggregateComponents structure. Built in
// two passes: buildInvoiceXml(includeExtensions:false) is what actually
// gets hashed and signed (ZATCA's own rule — the UBLExtensions signature
// block and the QR document reference are excluded from the hash since
// they don't exist yet at hashing time); the true final XML with those
// filled in is only assembled after signing, in the handler below.
//
// NOTE — like the CSR's SAN extension, the UBLExtensions/XAdES signature
// block ZATCA expects is a deep, ZATCA-specific structure (ds:Signature,
// xades:QualifyingProperties, certificate digests, etc.) reconstructed
// here from memory rather than verified against a real ZATCA response.
// The invoice body itself (parties/amounts/lines) is ordinary UBL 2.1 and
// far more likely to be exactly right; the signature block is the piece
// most likely to need correction once real sandbox testing is possible.
function buildInvoiceXml({ invoice, merchant, uuid, previousInvoiceHashB64, net, vat, total, includeExtensions, extensionsXml, qrBase64 }) {
  const issueDate = invoice.createdAt.slice(0, 10);
  const issueTime = invoice.createdAt.slice(11, 19) || '00:00:00';
  const lines = invoice.items.map((it, idx) => {
    return `
  <cac:InvoiceLine>
    <cbc:ID>${idx + 1}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="PCE">${it.qty}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="SAR">${it.lineTotal.toFixed(2)}</cbc:LineExtensionAmount>
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="SAR">${(it.lineTotal - it.lineTotal / 1.15).toFixed(2)}</cbc:TaxAmount>
      <cbc:RoundingAmount currencyID="SAR">${it.lineTotal.toFixed(2)}</cbc:RoundingAmount>
    </cac:TaxTotal>
    <cac:Item>
      <cbc:Name>${esc(it.name)} - ${esc(it.service)}</cbc:Name>
      <cac:ClassifiedTaxCategory>
        <cbc:ID>S</cbc:ID>
        <cbc:Percent>15</cbc:Percent>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:ClassifiedTaxCategory>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="SAR">${it.price.toFixed(2)}</cbc:PriceAmount>
    </cac:Price>
  </cac:InvoiceLine>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">${includeExtensions ? `
  <ext:UBLExtensions>${extensionsXml}</ext:UBLExtensions>` : ''}
  <cbc:ProfileID>reporting:1.0</cbc:ProfileID>
  <cbc:ID>${esc(invoice.code)}</cbc:ID>
  <cbc:UUID>${esc(uuid)}</cbc:UUID>
  <cbc:IssueDate>${issueDate}</cbc:IssueDate>
  <cbc:IssueTime>${issueTime}</cbc:IssueTime>
  <cbc:InvoiceTypeCode name="0200000">388</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>SAR</cbc:DocumentCurrencyCode>
  <cbc:TaxCurrencyCode>SAR</cbc:TaxCurrencyCode>
  <cac:AdditionalDocumentReference>
    <cbc:ID>ICV</cbc:ID>
    <cbc:UUID>${esc(invoice.code)}</cbc:UUID>
  </cac:AdditionalDocumentReference>
  <cac:AdditionalDocumentReference>
    <cbc:ID>PIH</cbc:ID>
    <cac:Attachment>
      <cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${previousInvoiceHashB64}</cbc:EmbeddedDocumentBinaryObject>
    </cac:Attachment>
  </cac:AdditionalDocumentReference>${qrBase64 ? `
  <cac:AdditionalDocumentReference>
    <cbc:ID>QR</cbc:ID>
    <cac:Attachment>
      <cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${qrBase64}</cbc:EmbeddedDocumentBinaryObject>
    </cac:Attachment>
  </cac:AdditionalDocumentReference>` : ''}
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PostalAddress>
        <cbc:StreetName>${esc(merchant.address || '')}</cbc:StreetName>
        <cbc:CountrySubentity>SA</cbc:CountrySubentity>
        <cac:Country><cbc:IdentificationCode>SA</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${esc(merchant.taxNumber || '')}</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${esc(merchant.name || '')}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
    <cac:Party>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${esc(invoice.customerName || '')}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingCustomerParty>
  <cac:PaymentMeans>
    <cbc:PaymentMeansCode>${invoice.payMethod === 'Credit (On Account)' ? '30' : '10'}</cbc:PaymentMeansCode>
  </cac:PaymentMeans>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="SAR">${vat.toFixed(2)}</cbc:TaxAmount>
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="SAR">${net.toFixed(2)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="SAR">${vat.toFixed(2)}</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:ID>S</cbc:ID>
        <cbc:Percent>15</cbc:Percent>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="SAR">${net.toFixed(2)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="SAR">${net.toFixed(2)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="SAR">${total.toFixed(2)}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="SAR">${total.toFixed(2)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>${lines}
</Invoice>`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });

  const { tenantId, invoice, merchant, previousInvoiceHash } = req.body || {};
  if (!tenantId || !invoice || !merchant) {
    return res.status(400).json({ success: false, error: 'tenantId, invoice, and merchant are required' });
  }

  const authResult = await verifyTenantSession(req, supabaseAdmin, tenantId);
  if (!authResult.ok) return res.status(authResult.status).json({ success: false, error: authResult.error });

  try {
    const { data: config, error: cfgErr } = await supabaseAdmin
      .from('zatca_configurations')
      .select('encrypted_private_key, public_key')
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (cfgErr) throw cfgErr;
    if (!config?.encrypted_private_key) throw new Error('no_zatca_key — generate a CSR first');

    const net = invoice.total / 1.15;
    const vat = invoice.total - net;
    const uuid = crypto.randomUUID();
    const previousHashB64 = previousInvoiceHash
      ? Buffer.from(previousInvoiceHash, 'hex').toString('base64')
      : Buffer.from('0'.repeat(64), 'hex').toString('base64'); // first invoice in the chain per ZATCA convention

    const hashableXml = buildInvoiceXml({ invoice, merchant, uuid, previousInvoiceHashB64: previousHashB64, net, vat, total: invoice.total, includeExtensions: false });
    const invoiceHashBytes = sha256(new TextEncoder().encode(hashableXml));
    const invoiceHashHex = Buffer.from(invoiceHashBytes).toString('hex');

    const privateKeyHex = await decryptPrivateKey(config.encrypted_private_key);
    const privateKeyBytes = Uint8Array.from(privateKeyHex.match(/.{2}/g).map((b) => parseInt(b, 16)));
    const publicKeyBytes = Uint8Array.from(config.public_key.match(/.{2}/g).map((b) => parseInt(b, 16)));
    const signatureDer = secp256k1.sign(invoiceHashBytes, privateKeyBytes, { format: 'der', prehash: false });

    const qrBase64 = buildPhase2QrBase64({
      sellerName: merchant.name || '',
      vatNumber: merchant.taxNumber || '',
      isoDateTime: invoice.createdAt,
      total: invoice.total.toFixed(2),
      vatTotal: vat.toFixed(2),
      invoiceHashHex,
      signatureBytes: signatureDer,
      publicKeyBytes,
    });

    // Best-effort XAdES-style signature block — see buildInvoiceXml's
    // comment: this specific structure is the least certain part of the
    // whole pipeline and needs real ZATCA validation.
    const extensionsXml = `
    <ext:UBLExtension>
      <ext:ExtensionURI>urn:oasis:names:specification:ubl:dsig:enveloped:xades</ext:ExtensionURI>
      <ext:ExtensionContent>
        <sig:UBLDocumentSignatures xmlns:sig="urn:oasis:names:specification:ubl:schema:xsd:CommonSignatureComponents-2" xmlns:sac="urn:oasis:names:specification:ubl:schema:xsd:SignatureAggregateComponents-2">
          <sac:SignatureInformation>
            <cbc:ID>urn:oasis:names:specification:ubl:signature:1</cbc:ID>
            <sbc:ReferencedSignatureID xmlns:sbc="urn:oasis:names:specification:ubl:schema:xsd:SignatureBasicComponents-2">urn:oasis:names:specification:ubl:signature:Invoice</sbc:ReferencedSignatureID>
            <ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Id="signature">
              <ds:SignedInfo>
                <ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256"/>
              </ds:SignedInfo>
              <ds:SignatureValue>${Buffer.from(signatureDer).toString('base64')}</ds:SignatureValue>
              <ds:KeyInfo>
                <ds:X509Data>
                  <ds:X509Certificate>PENDING_REAL_ZATCA_CSID</ds:X509Certificate>
                </ds:X509Data>
              </ds:KeyInfo>
            </ds:Signature>
          </sac:SignatureInformation>
        </sig:UBLDocumentSignatures>
      </ext:ExtensionContent>
    </ext:UBLExtension>`;

    const finalXml = buildInvoiceXml({ invoice, merchant, uuid, previousInvoiceHashB64: previousHashB64, net, vat, total: invoice.total, includeExtensions: true, extensionsXml, qrBase64 });

    return res.status(200).json({
      success: true,
      uuid,
      invoiceHash: invoiceHashHex,
      xml: finalXml,
      qrBase64,
    });
  } catch (e) {
    console.error('zatca-sign-invoice error', e);
    return res.status(200).json({ success: false, error: e.message || String(e) });
  }
}
