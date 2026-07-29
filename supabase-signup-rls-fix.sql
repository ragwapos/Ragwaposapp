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
-- sales_inquiries لنموذج "تواصل مع المبيعات" العام)، مع تقييد بسيط على
-- registration_requests: يمنع أي حالة غير pending/approved وقت الإدخال
-- (الرفض "rejected" يصير بس من لوحة الأدمن بعدين، مو وقت التسجيل).
--
-- ملاحظة: أول نسخة من هذا الملف حطت شرط WITH CHECK على tenants يتطلب وجود
-- صف registration_requests بنفس الـ uid وحالته 'approved' قبل لا يسمح
-- بالإدخال. تبين إنه ما يشتغل: ذاك الشرط EXISTS(...) يستعلم عن جدول محمي
-- بـ RLS هو نفسه، وبما إنه ما فيه سياسة SELECT تسمح لـ anon يشوف صف
-- registration_requests (ولا لازم تكون فيه — نفتحها بس كشف بيانات كل طلبات
-- التسجيل المعلّقة لأي زائر)، الاستعلام يرجع فاضي دايماً من منظور anon
-- ويفشل الإدخال بنفس خطأ RLS من جديد. والشرط أصلاً ما يضيف حماية حقيقية:
-- نفس الزائر المجهول قادر يحقن صف registration_requests بحالة 'approved'
-- بنفسه قبلها مباشرة (لأن سياسة الإدخال عليه مفتوحة). فبقينا بس بفتح
-- الإدخال على tenants مباشرة، بدون شرط وهمي.
-- =========================================================================

alter table registration_requests enable row level security;
alter table tenants enable row level security;

drop policy if exists registration_requests_insert_public on registration_requests;
create policy registration_requests_insert_public on registration_requests
  for insert
  to anon, authenticated
  with check (status in ('pending', 'approved'));

drop policy if exists tenants_insert_from_approved_request on tenants;
drop policy if exists tenants_insert_public on tenants;
create policy tenants_insert_public on tenants
  for insert
  to anon, authenticated
  with check (true);
