-- يفكّ قفل الوصول (GRANT) بدون تعطيل RLS — يبقي كل مستأجر يشوف بياناته هو بس.
-- شغّل هذا بـ Supabase Dashboard → SQL Editor → New Query → Run.

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO anon, authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;

-- ملاحظة: هذا يفتح الباب أمام أي استعلام يحاول يوصل للجداول، لكن سياسات RLS
-- الموجودة (أو الافتراضية "منع الكل" لو ما فيه سياسات بعد) تبقى هي اللي تقرر
-- فعلياً مين يشوف/يعدّل أي صف. لو جدول معيّن رجع لسا "0 صفوف" بعد هذا الأمر
-- رغم إنه فيه بيانات، السبب غالباً غياب سياسة RLS تسمح بالقراءة، مو GRANT.
