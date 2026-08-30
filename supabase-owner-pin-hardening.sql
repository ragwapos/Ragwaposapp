-- =========================================================================
-- Ragwa POS — Server-side owner/section PIN verification (audit §4.1 fix)
-- شغّل هذا مرة وحدة بـ Supabase Dashboard → SQL Editor → New Query → Run.
-- =========================================================================
-- المشكلة اللي يصلحها هذا الملف: ownerPassword وsectionLocks كانوا يُخزَّنون
-- كـ SHA-256 بدون ملح، ويُرسَلون كاملين للعميل عبر tenant_settings (أي
-- مستخدم بنفس جلسة المستأجر يقدر يقرأهم من الشبكة/React DevTools ويكسرهم
-- offline بسهولة — مساحة PIN من 4 أرقام صغيرة جداً). التحقق الجديد صار
-- بالكامل من api/verify-pin.js عبر هذا الجدول، والهاش/الملح ما يطلعون
-- للعميل أبداً.
--
-- آمن للتشغيل أكثر من مرة (IF NOT EXISTS / OR REPLACE بكل مكان).
-- =========================================================================

create table if not exists owner_pin_credentials (
  tenant_id uuid not null references tenants(id) on delete cascade,
  scope text not null,  -- 'master' | 'customers' | 'inventory' | 'purchases' | 'promotions' | 'reports'
  pin_hash text not null,       -- scrypt derived key, hex
  pin_salt text not null,       -- ملح عشوائي منفصل لكل صف، hex
  failed_attempts int not null default 0,
  locked_until timestamptz,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, scope)
);

alter table owner_pin_credentials enable row level security;
-- عمداً بدون أي policy لـ anon/authenticated — نفس نمط platform_admins
-- (راجع تعليق api/admin-sync.js). الوصول حصرياً عبر مفتاح service-role من
-- api/verify-pin.js، صفر وصول مباشر من المتصفح لأي عمود بهذا الجدول.

-- حقول خفيفة جديدة على tenant_settings -- تُقرأ من الواجهة عبر
-- subscribeToRow الموجودة أصلاً (تجيب الصف كامل)، لكنها لا تحتوي أي هاش أو
-- ملح إطلاقاً -- بس boolean/قائمة مفاتيح أقسام، معلومة غير حساسة أصلاً
-- (تعرف الواجهة أي قسم "مقفول" بدون ما تعرف قيمة القفل نفسها).
alter table tenant_settings add column if not exists owner_pin_set boolean not null default false;
alter table tenant_settings add column if not exists locked_sections jsonb not null default '[]'::jsonb;

-- ملاحظة: أعمدة owner_password/section_locks القديمة تبقى موجودة مؤقتاً
-- (تُقرأ من api/verify-pin.js فقط كمسار احتياطي أثناء الترحيل التلقائي،
-- راجع القسم 3 بخطة التنفيذ) -- حذفها نهائياً خطوة تنظيف منفصلة لاحقة، بعد
-- التأكد من ترحيل كل المستأجرين النشطين.
