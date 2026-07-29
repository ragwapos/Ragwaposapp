-- =========================================================================
-- Ragwa POS — يصلح تسجيل حساب جديد (يفشل حالياً بعد إنشاء المستخدم في Auth)
-- شغّل هذا مرة وحدة بـ Supabase Dashboard → SQL Editor → New Query → Run.
-- =========================================================================
-- المشكلة: SignupPage (src/App.jsx handleSignup) تنشئ حساب Auth الجديد عن
-- طريق /api/send-verification-email (admin.generateLink من السيرفر)، فمتصفح
-- العميل يبقى "anon" — ما يسجّل دخول أبداً بنفسه قبل أول عملية insert. بعدها
-- مباشرة يسوي:
--   1) db.from('registration_requests').insert(...)   ← كـ anon
--   2) db.from('tenants').upsert(...)                  ← كـ anon (لو auto-approve مفعّل)
-- بدون سياسة RLS تسمح بـ INSERT للـ anon على هذين الجدولين، Postgres يرفض
-- الصفين بخطأ 42501 "new row violates row-level security policy" — نفس
-- الخطأ اللي تأكد بالاختبار المباشر ضد REST API. النتيجة: حساب Auth يتكوّن
-- (وممكن يوصل إيميل التحقق)، لكن التسجيل يفشل بشاشة خطأ وما يوصل أبداً لصفحة
-- "تأكيد البريد الإلكتروني" — بالضبط نفس السلوك اللي يشتكي منه العميل.
--
-- الحل: سياسة INSERT مفتوحة لـ anon (نفس النمط المستخدم فعلاً بجدول
-- sales_inquiries لنموذج "تواصل مع المبيعات" العام)، مع تقييد بسيط:
--   - registration_requests: يمنع أي حالة غير pending/approved وقت الإدخال
--     (الرفض "rejected" يصير بس من لوحة الأدمن بعدين، مو وقت التسجيل).
--   - tenants: ما تنشئ صف تينانت جديد إلا لو فيه طلب تسجيل بنفس الـ uid
--     صار "approved" فعلاً — يمنع أي حد يحقن صف تينانت وهمي من فراغ.
-- =========================================================================

alter table registration_requests enable row level security;
alter table tenants enable row level security;

drop policy if exists registration_requests_insert_public on registration_requests;
create policy registration_requests_insert_public on registration_requests
  for insert
  to anon, authenticated
  with check (status in ('pending', 'approved'));

drop policy if exists tenants_insert_from_approved_request on tenants;
create policy tenants_insert_from_approved_request on tenants
  for insert
  to anon, authenticated
  with check (
    exists (
      select 1 from registration_requests r
      where r.uid = tenants.id and r.status = 'approved'
    )
  );
