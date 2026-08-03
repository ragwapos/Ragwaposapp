// Shared by every api/zatca-*.js handler. Each of those endpoints acts on a
// tenantId taken straight from the request body — without this check, any
// authenticated user who learns/guesses another tenant's UUID could
// overwrite that tenant's real ZATCA keys or get invoices signed under that
// tenant's identity, since the handlers run with the service-role key
// (bypasses RLS) and never otherwise verify who's asking. This resolves the
// caller's actual Supabase session from the Authorization header and
// confirms it matches the tenantId being acted on — the tenantId in the
// body is never trusted by itself.
export async function verifyTenantSession(req, supabaseAdmin, tenantId) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return { ok: false, status: 401, error: 'missing_session' };

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user) return { ok: false, status: 401, error: 'invalid_session' };
  if (data.user.id !== tenantId) return { ok: false, status: 403, error: 'tenant_mismatch' };

  return { ok: true };
}
