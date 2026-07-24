# مخطط بيانات Firestore — تطبيق رغوة (Laundry POS)

مستخرج **حصراً من الكود المصدري** (`src/App.jsx`) — من كل استدعاء `setDoc`/`addDoc`/`updateDoc`/`onSnapshot`/`getDocs`/`getDoc`. لم يُنظر لأي مستند حقيقي بـ Firestore Console. هذا الملف هو مرجع أساسي لأي عملية ترحيل (migration) لقاعدة بيانات ثانية (مثلاً Supabase/Postgres).

**نطاق الملف بعد التوسعة:** الأقسام 1–12 توثّق **بنية البيانات فقط**. الأقسام 13 فما فوق (بعد خط الفصل الثاني) تغطي بقية ما يلزم لترحيل كامل من Firebase إلى Supabase — قواعد الصلاحيات (RLS)، المصادقة، المنطق التطبيقي غير المخزَّن، الملفات، وأخطاء موجودة بالنظام الحالي يجب عدم تكرارها بالنظام الجديد.

**ملاحظة منهجية مهمة عن حقل `id`:** في أغلب المجموعات (collections)، القيمة `id` المتاحة داخل التطبيق تأتي من معرّف المستند نفسه بـ Firestore (`doc.id`) عبر نمط القراءة `{ id: d.id, ...d.data() }` — وهي **غير مخزّنة فعلياً كحقل داخل المستند**. الاستثناءات الصريحة اللي فيها `id` مكتوب فعلياً كحقل داخل المستند: `invoices`، `customerTransactions`، و`customers` (لأن `id` بالعميل رقم يختاره الموظف يدوياً، مو معرّف Firestore عشوائي). سأوضح هذا لكل مجموعة أدناه.

---

## 1) `tenants/{tenantId}` — المحل نفسه

معرّف المستند (`tenantId`) = نفس UID حساب Firebase Authentication لصاحب المحل.

يُكتب من مكانين فقط بنفس البنية بالضبط: `approveRequest` (موافقة الأدمن) و`handleSignup` (تسجيل تلقائي إذا `autoApprove` مفعّل).

| الحقل | النوع | إلزامي؟ | ملاحظات |
|---|---|---|---|
| `shopName` | نص | إلزامي | افتراضي `"—"` لو فاضي وقت التسجيل |
| `mobile` | نص | إلزامي | كما أدخله المستخدم بالتسجيل، بدون تحقق صيغة هنا |
| `email` | نص | إلزامي | بريد حساب الدخول (منسّق lowercase) |
| `address` | نص | إلزامي | افتراضي `"—"` لو فاضي |
| `approvedDate` | نص (ISO datetime) | إلزامي | تاريخ إنشاء/موافقة المستند |

**لا يوجد أي حقل تعديل آخر يُكتب لاحقاً على هذا المستند إلا:**
- `updateDoc` من `AdminDashboard.saveTenantEdit` يعدّل فقط `mobile` و`email` (تعديل بيانات عرض إدارية، لا يغيّر بريد الدخول الفعلي بـ Firebase Auth).

**العلاقات:** هذا المستند هو الأب لكل الـ subcollections أدناه (2 إلى 9). `tenants/{tenantId}` مرتبط أيضاً بمستند `registrationRequests` عبر حقل `uid == tenantId` — **علاقة غير آلية** (حذف أحدهما لا يحذف الآخر تلقائياً).

---

## 2) `tenants/{tenantId}/products` و `tenants/{tenantId}/categories`

### `categories/{id}`
بنية بسيطة جداً — حقل واحد فقط:

| الحقل | النوع | إلزامي؟ |
|---|---|---|
| `name` | نص | إلزامي |

### `products/{id}`

| الحقل | النوع | إلزامي؟ | ملاحظات |
|---|---|---|---|
| `name` | نص | إلزامي | |
| `categoryId` | نص (مرجع) | إلزامي | يشير إلى `categories/{id}` بنفس المحل |
| `image` | نص (Base64 data URL) | اختياري (`""` افتراضي) | **الصورة مخزّنة كاملة داخل المستند نفسه** — لا يوجد Firebase Storage مستخدم بالتطبيق إطلاقاً رغم توفره بالإعدادات |
| `price` | رقم | إلزامي | **محسوب تلقائياً** = أقل قيمة بين كل أسعار `services` — ليس حقل يُدخله المستخدم مباشرة |
| `cost` | رقم | إلزامي (حالياً ثابت `0`) | حقل محجوز — غير مستخدم فعلياً بأي حساب أو شاشة |
| `noCost` | Boolean | إلزامي (حالياً ثابت `true`) | حقل محجوز أيضاً |
| `published` | Boolean | إلزامي | يتحكم بظهور المنتج بشاشة الكاشير |
| `services` | كائن متداخل (map) | إلزامي (عنصر واحد على الأقل) | شكله: `{ [اسم نوع الخدمة]: رقم السعر }` — المفتاح هو **اسم** نوع الخدمة (نص)، مو معرّفه |
| `productAddons` | مصفوفة كائنات | اختياري (`[]` افتراضي) | كل عنصر: `{ id: نص, name: نص, price: رقم }` — إضافات خاصة بهذا المنتج فقط، منفصلة عن كتالوج `addons` العام |

**العلاقات:** `products.categoryId` → `categories.id`. مفاتيح `products.services` تطابق أسماء (مو معرّفات) مستندات `serviceTypes`.

---

## 3) `tenants/{tenantId}/invoices` — الفواتير

**استثناء مهم:** حقل `id` **مكتوب فعلياً** داخل المستند (`{ ...invoiceData, id: ref.id }`)، بعكس أغلب المجموعات الأخرى.

| الحقل | النوع | إلزامي؟ | ملاحظات |
|---|---|---|---|
| `id` | نص | إلزامي | معرّف المستند نفسه، مكرّر كحقل |
| `code` | نص | إلزامي | صيغة `INV-1001` (بيع عادي) / `DLV-1001` (توصيل) / `TOP-1001` (فاتورة شحن محفظة) |
| `customerId` | رقم | إلزامي | يشير إلى `customers.id` بنفس المحل |
| `customerName` | نص | إلزامي | **منسوخ وقت الإنشاء** — لا يتحدث تلقائياً لو تغيّر اسم العميل لاحقاً |
| `payMethod` | نص (enum) | إلزامي | إحدى: `"Cash"`, `"External Network"`, `"Wallet Balance"`, `"Credit (On Account)"`, `"Split"` |
| `splitPayments` | مصفوفة كائنات أو `null` | اختياري | فقط لو `payMethod === "Split"` — كل عنصر: `{ method: نص (من نفس القائمة عدا Split), amount: رقم }` |
| `total` | رقم | إلزامي | المبلغ الإجمالي النهائي (بعد الخصم ورسوم التوصيل) |
| `discount` | رقم | إلزامي | مبلغ الخصم المطبَّق |
| `isDelivery` | Boolean | إلزامي | يحدد ظهورها بشاشة "Active Delivery Invoices" بدل "Active Invoices" |
| `deliveryFee` | رقم | إلزامي (`0` لو مو توصيل) | |
| `createdAt` | نص (ISO datetime) | إلزامي | مصدر كل ترتيب زمني وتقارير التاريخ |
| `closed` | Boolean | إلزامي | `true` = "تم التسليم"/مغلقة، تختفي من شاشات الفواتير النشطة |
| `vatExempt` | Boolean | إلزامي | يُحسب وقت الإنشاء من `!merchant.taxNumber.trim()` — **قيمة مجمّدة وقت الإنشاء**، لا تتأثر لو أُضيف رقم ضريبي للمحل لاحقاً |
| `isTopUp` | Boolean | اختياري (موجود فقط بفواتير شحن المحفظة) | |
| `items` | مصفوفة كائنات متداخلة | إلزامي (عنصر واحد على الأقل) | انظر البنية أدناه |

### بنية عنصر `items[]` داخل الفاتورة

| الحقل | النوع | إلزامي؟ | ملاحظات |
|---|---|---|---|
| `itemId` | نص | إلزامي | معرّف عشوائي محلي (`uid("item")`), مو معرّف Firestore |
| `name` | نص | إلزامي | اسم المنتج وقت البيع |
| `service` | نص | إلزامي | اسم نوع الخدمة المختار |
| `addons` | مصفوفة كائنات | اختياري (`[]`) | كل عنصر: `{ id: نص, name: نص, price: رقم }` — منسوخة كاملة وقت البيع |
| `price` | رقم | إلزامي | سعر الخدمة + مجموع الإضافات (سعر الوحدة) |
| `qty` | رقم | إلزامي | |
| `lineTotal` | رقم | إلزامي | `price × qty` |
| `status` | نص (enum) | إلزامي | إحدى: `"Received"`, `"Washing"`, `"Pressing"`, `"Ready"`, `"Delivered"` |
| `urgent` | Boolean | إلزامي (حالياً ثابت `false` دائماً) | **حقل محجوز غير مفعّل بالواجهة** — لا يوجد زر يغيّره |
| `deliveredAt` | نص (ISO datetime) أو `null` | إلزامي | يُملأ فقط لما `status === "Delivered"` |

**العلاقات:** `invoices.customerId` → `customers.id`. حالة الفاتورة الكلية المعروضة بالواجهة = أقل `stage index` بين كل `items[].status`.

**ملاحظة QR/الضريبة:** رمز الـ QR (ZATCA) **لا يُخزَّن بأي مستند** — يُبنى فقط وقت الطباعة من `merchant.name` + `merchant.taxNumber` + `total`/`vat` المحسوبة لحظياً.

---

## 4) `tenants/{tenantId}/customers` و `tenants/{tenantId}/customerTransactions`

### `customers/{id}`
**معرّف المستند = نص القيمة الرقمية لـ `id` نفسه** (`String(data.id)`) — رقم يختاره الموظف يدوياً وقت إضافة العميل (مو معرّف Firestore عشوائي)، **مكتوب أيضاً كحقل داخل المستند**.

| الحقل | النوع | إلزامي؟ | ملاحظات |
|---|---|---|---|
| `id` | رقم | إلزامي | نفس قيمة معرّف المستند، لكن كنوع رقمي (Number) لا نص |
| `name` | نص | إلزامي | |
| `mobile` | نص | إلزامي | افتراضي `"-"` لو فاضي؛ يُستخدم كفحص تكرار (لازم يكون فريد) |
| `walletBalance` | رقم | إلزامي | رصيد محفظة العميل الحالي |
| `debt` | رقم | إلزامي | الدين المستحق على العميل حالياً |

### `customerTransactions/{id}`
**استثناء:** `id` **مكتوب فعلياً** داخل المستند، بعكس أغلب المجموعات.

| الحقل | النوع | إلزامي؟ | ملاحظات |
|---|---|---|---|
| `id` | نص | إلزامي | معرّف المستند نفسه |
| `customerId` | رقم | إلزامي | يشير إلى `customers.id` |
| `type` | نص (enum) | إلزامي | `"topup"` (شحن محفظة) أو `"debt_payment"` (سداد دين) |
| `code` | نص | إلزامي | صيغة `RCT-1001` (شحن) أو `PMT-1001` (سداد) |
| `paidAmount` | رقم | إلزامي | المبلغ الفعلي المدفوع نقداً/شبكة/آجل |
| `payMethod` | نص (enum) | إلزامي | `"Cash"`, `"External Network"`, أو `"Credit (On Account)"` (شحن)؛ `"Cash"`, `"External Network"`, أو `"Wallet Balance"` (سداد دين) |
| `notes` | نص | اختياري (`""`) | |
| `date` | نص (ISO datetime) | إلزامي | |
| `creditedAmount` | رقم | **فقط لو `type === "topup"`** | المبلغ المضاف فعلياً لرصيد المحفظة (قبل خصم أي خصم) |
| `discountAmount` | رقم | **فقط لو `type === "topup"`** | |
| `discountMode` | نص (enum) | **فقط لو `type === "topup"`** | `"flat"` (مبلغ ثابت) أو `"percent"` (نسبة) |

**العلاقات:** `customerTransactions.customerId` → `customers.id`. لا توجد أي علاقة مباشرة (foreign key) بين `customerTransactions` و`invoices` — رغم أن شحن المحفظة بمبلغ حقيقي يُنشئ فاتورة `TOP-xxxx` منفصلة بنفس اللحظة، الاثنان يُكتبان كعمليتين مستقلتين بدون أي حقل يربطهما ببعض صراحة.

---

## 5) `tenants/{tenantId}/suppliers` و `tenants/{tenantId}/purchases`

### `suppliers/{id}`

| الحقل | النوع | إلزامي؟ | ملاحظات |
|---|---|---|---|
| `company` | نص | إلزامي | اسم الشركة |
| `agent` | نص | إلزامي | افتراضي `"-"` |
| `contact` | نص | إلزامي | افتراضي `"-"` |
| `taxNumber` | نص | اختياري (`""` مسموح) | **لو فاضٍ**، مشترياته تُستبعد من حساب ضريبة المدخلات بتقرير Tax Return |
| `balance` | رقم | إلزامي | يبدأ `0` عند الإنشاء، يزيد فقط بمشتريات آجلة، ينقص بالسداد |

### `purchases/{id}`

| الحقل | النوع | إلزامي؟ | ملاحظات |
|---|---|---|---|
| `code` | نص | إلزامي | صيغة `PO-1001` |
| `supplierId` | نص (مرجع) | إلزامي | يشير إلى `suppliers.id` |
| `amount` | رقم | إلزامي | |
| `method` | نص (enum) | إلزامي | `"Cash"` أو `"Credit / On Account"` — **⚠️ ملاحظة اتساق:** هذي السلسلة النصية مختلفة شكلياً عن `"Credit (On Account)"` المستخدمة بجانب العملاء/الفواتير (مسافات حول الشرطة المائلة بدل الأقواس) — نفس المعنى منطقياً لكن قيمة نصية مختلفة تماماً، يلزم تطبيع عند الترحيل |
| `date` | نص (ISO datetime) | إلزامي | |
| `attachment` | نص (Base64 data URL) أو `""` | اختياري | صورة/ملف فاتورة المورد الأصلية، مخزّنة كاملة داخل المستند (بدون Firebase Storage) |
| `attachmentName` | نص | اختياري (`""`) | اسم الملف الأصلي، لعرضه بزر التحميل |

**العلاقات:** `purchases.supplierId` → `suppliers.id`.

---

## 6) `tenants/{tenantId}/expenseCategories` و `tenants/{tenantId}/expenses`

### `expenseCategories/{id}`

| الحقل | النوع | إلزامي؟ |
|---|---|---|
| `name` | نص | إلزامي |

### `expenses/{id}`

| الحقل | النوع | إلزامي؟ | ملاحظات |
|---|---|---|---|
| `categoryId` | نص (مرجع) | إلزامي | يشير إلى `expenseCategories.id` |
| `amount` | رقم | إلزامي | |
| `taxFlag` | نص (enum) | إلزامي | `"Inclusive"` (شامل الضريبة، يُحتسب منه VAT) أو `"Exempt"` (معفى) |
| `date` | نص (تاريخ فقط، صيغة `YYYY-MM-DD`) | إلزامي | **ليس timestamp كامل** بعكس أغلب حقول التاريخ الثانية بالتطبيق |
| `receipt` | نص | اختياري (`""`) | **مجرد اسم الملف فقط** — بعكس مرفقات المشتريات، لا يُخزَّن محتوى الملف نفسه إطلاقاً هنا |

**العلاقات:** `expenses.categoryId` → `expenseCategories.id`.

---

## 7) `tenants/{tenantId}/promotions` — الخصومات

| الحقل | النوع | إلزامي؟ | ملاحظات |
|---|---|---|---|
| `name` | نص | إلزامي | |
| `couponOn` | Boolean | إلزامي | `true` = يتطلب كوبون؛ `false` = يُطبَّق تلقائياً على كل عملية بيع |
| `coupon` | نص | إلزامي (فاضي لو `couponOn=false`) | يُخزَّن بحروف كبيرة (uppercase) |
| `isPercent` | Boolean | إلزامي | `true` = `value` نسبة مئوية؛ `false` = `value` مبلغ ثابت بالريال |
| `value` | رقم | إلزامي | قيمة الخصم (% أو مبلغ حسب `isPercent`) |
| `start` | نص (ISO datetime) أو `""` | اختياري | فاضي = بلا حد بداية (مفتوح من الأزل) |
| `end` | نص (ISO datetime) أو `""` | اختياري | فاضي = بلا حد نهاية (مفتوح للأبد) |
| `active` | Boolean | إلزامي | `true` عند الإنشاء دائماً؛ يصير `false` عند "إلغاء" الخصم (تعطيل بدون حذف) |

**شرط منع التداخل (منطق تطبيقي، مو قيد بقاعدة البيانات):** خصمان يُعتبران متداخلين لو `active !== false` لكليهما وفترتاهما (`start`–`end`، بمعالجة الفراغ كطرف مفتوح) تتقاطعان زمنياً — يُمنع الحفظ حينها من كود الواجهة فقط (لا يوجد قيد Firestore Rules يفرض هذا).

**حالة "نشط" المعروضة بالواجهة** = `active !== false` **و** الوقت الحالي داخل `[start, end]` (لو محددين) — يعني `active` وحده لا يكفي لمعرفة هل الخصم "شغّال الآن"، لازم فحص الفترة أيضاً.

---

## 8) `tenants/{tenantId}/addons` و `tenants/{tenantId}/serviceTypes`

### `addons/{id}` — كتالوج الإضافات العام

| الحقل | النوع | إلزامي؟ |
|---|---|---|
| `name` | نص | إلزامي |
| `price` | رقم | إلزامي |

### `serviceTypes/{id}` — أنواع الخدمة (غسيل فقط، كي فقط، إلخ)

| الحقل | النوع | إلزامي؟ |
|---|---|---|
| `name` | نص | إلزامي |

**العلاقة:** أسماء `serviceTypes` (مو معرّفاتها) هي المفاتيح المستخدمة داخل `products.services`. `addons` كتالوج مستقل، يُنسخ كاملاً (بالقيمة) داخل `products.productAddons` أو `invoice.items[].addons` وقت الاستخدام — التعديل على `addons` لاحقاً **لا يؤثر** على نسخ سابقة محفوظة بمنتجات أو فواتير.

---

## 9) `tenants/{tenantId}/settings/shop` — إعدادات المحل

مستند واحد فقط (معرّف ثابت `"shop"`)، يُحفظ تلقائياً (auto-save) بمجرد أي تغيير على أي حقل منه بواجهة الإعدادات.

| الحقل | النوع | إلزامي؟ | ملاحظات |
|---|---|---|---|
| `merchant` | كائن متداخل | إلزامي | `{ name: نص, phone: نص, address: نص, taxNumber: نص }` — **ملف تعريف منفصل تماماً** عن `tenants/{tenantId}.shopName/mobile/address` (يُدار من صاحب المحل بنفسه، يُستخدم لطباعة الفواتير الضريبية فقط) |
| `ownerPassword` | نص (4 أرقام) أو `null` | إلزامي (يبدأ `null`) | PIN حماية الأقسام الحساسة |
| `sectionLocks` | كائن متداخل | إلزامي | `{ customers: نص PIN أو null, inventory: ..., purchases: ..., promotions: ..., reports: ... }` — كل قسم يقدر يكون له PIN مستقل أو بلا قفل |
| `enabledPayMethods` | كائن متداخل (map) | إلزامي | `{ Cash: Boolean, "External Network": Boolean, "Wallet Balance": Boolean, "Credit (On Account)": Boolean, Split: Boolean }` — يتحكم بأي طرق دفع تظهر بشاشة الكاشير |
| `lang` | نص (enum) | إلزامي | `"en"`, `"ar"`, أو `"ur"` — لغة واجهة هذا المحل |

---

## 10) `registrationRequests/{id}` — طلبات التسجيل (مجموعة عامة، خارج `tenants`)

| الحقل | النوع | إلزامي؟ | ملاحظات |
|---|---|---|---|
| `uid` | نص | إلزامي | يشير إلى Firebase Auth UID لصاحب الطلب — **نفسه سيصير `tenantId` لو تمت الموافقة** |
| `shopName` | نص | إلزامي | |
| `mobile` | نص | إلزامي | |
| `email` | نص | إلزامي | |
| `address` | نص | إلزامي | |
| `date` | نص (ISO datetime) | إلزامي | |
| `status` | نص (enum) | إلزامي | `"pending"`, `"approved"`, أو `"rejected"` |
| `rejectReason` | نص | إلزامي (`""` افتراضي) | يُملأ فقط لو `status === "rejected"` |

**العلاقة:** `registrationRequests.uid` ↔ `tenants.{tenantId}` — علاقة **منطقية غير مفروضة بقاعدة بيانات**؛ حذف مستند من `tenants` لا يحذف طلب التسجيل المرتبط تلقائياً (ولا العكس).

---

## 11) `salesInquiries/{id}` — رسائل "تواصل مع المبيعات" (مجموعة عامة)

غير مرتبطة بأي محل — نموذج تواصل مفتوح لأي زائر (حتى غير مسجّل دخول).

| الحقل | النوع | إلزامي؟ | ملاحظات |
|---|---|---|---|
| `name` | نص | إلزامي | افتراضي `"—"` |
| `mobile` | نص | إلزامي | افتراضي `"—"` |
| `email` | نص | إلزامي | افتراضي `"—"` |
| `type` | نص (enum) | إلزامي | إحدى: `"شراء نظام"`, `"سؤال تقني"`, `"عرض خاص"` (أو مكافئاتها الإنجليزية حسب لغة الصفحة وقت الإرسال) |
| `message` | نص | إلزامي | |
| `date` | نص (ISO datetime) | إلزامي | |
| `status` | نص (enum) | إلزامي (`"new"` افتراضي) | `"new"`, `"read"`, أو `"replied"` |
| `note` | نص | إلزامي (`""` افتراضي) | ملاحظة داخلية يضيفها الأدمن، غير مرئية للعميل |

---

## 12) `config/platform` — إعدادات المنصة (مستند واحد فقط)

معرّف ثابت: `config/platform`.

| الحقل | النوع | إلزامي؟ | ملاحظات |
|---|---|---|---|
| `adminEmails` | مصفوفة نصوص | إلزامي (عنصر واحد على الأقل دائماً) | كل بريد بالمصفوفة يحصل دخول مباشر للوحة الأدمن؛ لا يُسمح بإفراغها بالكامل من الواجهة |
| `autoApprove` | Boolean | إلزامي | `true` = أي تسجيل جديد يُعتمد فوراً كمحل نشط بدون مراجعة أدمن |

**تهيئة أولى (bootstrap):** يُنشأ هذا المستند أول مرة فقط ببريد ثابت مكتوب بالكود (`ragwapos@gmail.com`) — بعدها إدارة القائمة بالكامل تتم من لوحة الأدمن نفسها.

---

## ملخص العلاقات بين الكيانات (Entity Relationships)

```
tenants/{tenantId}                          ←── registrationRequests.uid (علاقة غير مفروضة)
  ├── categories/{id}
  ├── products/{id}.categoryId ────────────→ categories.id
  ├── serviceTypes/{id}          (الاسم فقط، لا معرّف) ──→ مفتاح داخل products.services
  ├── addons/{id}                (تُنسخ بالقيمة، لا رابط لاحق)
  ├── customers/{id}
  ├── customerTransactions/{id}.customerId ─→ customers.id
  ├── invoices/{id}.customerId ────────────→ customers.id
  ├── suppliers/{id}
  ├── purchases/{id}.supplierId ───────────→ suppliers.id
  ├── expenseCategories/{id}
  ├── expenses/{id}.categoryId ────────────→ expenseCategories.id
  ├── promotions/{id}            (بلا علاقة خارجية، تُقرأ كاملة وقت البيع بالكاشير)
  └── settings/shop              (مستند إعدادات واحد)

registrationRequests/{id}.uid  ──────(بلا فرض)──→  tenants/{tenantId}  (نفس القيمة)
salesInquiries/{id}             (مستقلة تماماً، بلا أي علاقة)
config/platform                 (مستند مشترك عام، مستقل)
```

## ملاحظات عامة تهم أي عملية ترحيل

1. **لا يوجد تحقق صحة (validation) على مستوى قاعدة البيانات** — كل التحقق (إلزامية الحقول، صيغة الأرقام، إلخ) يتم بكود الواجهة فقط (JavaScript يدوي، بدون Zod أو أي مكتبة تحقق). أي ترحيل لـ Postgres يحتاج فرض هذي القيود من جديد على مستوى الـ schema (NOT NULL, CHECK constraints, إلخ) لأنها غير مضمونة من البيانات الحالية نفسها.
2. **كل التواريخ نصوص ISO 8601** (`toISOString()`) عدا `expenses.date` اللي هو تاريخ فقط بصيغة `YYYY-MM-DD` — يلزم تطبيع لنوع `timestamp` موحّد بـ Postgres.
3. **الصور والمرفقات (`products.image`, `purchases.attachment`) مخزّنة كـ Base64 كاملة داخل المستند نفسه** — عند الترحيل لـ Postgres/Supabase، الأفضل نقلها لـ Supabase Storage كملفات فعلية بدل أعمدة نصية ضخمة.
4. **قيم enum غير متسقة بين مكانين مختلفين لنفس المعنى:** طريقة الدفع الآجل تُكتب `"Credit (On Account)"` بجانب العملاء/الفواتير لكن `"Credit / On Account"` بجانب المشتريات — يلزم تطبيع لقيمة enum واحدة موحّدة.
5. **حقل `id` كعمود متكرر:** `invoices`, `customerTransactions`, و`customers` تكتب `id` كحقل فعلي داخل المستند (مطابق لمعرّف المستند نفسه) — بينما بقية المجموعات لا تفعل. عند الترحيل لجدول Postgres عادي، هذا يصير زائداً عن الحاجة (الـ primary key الفعلي يكفي).

---
---

# الجزء الثاني: خطة الترحيل الكاملة إلى Supabase

الأقسام التالية تغطي كل ما هو **خارج بنية البيانات نفسها** لكنه ضروري لأي ترحيل حقيقي من Firebase إلى Supabase — مستخرجة من `firestore.rules` والكود المصدري بنفس منهجية الجزء الأول (بدون النظر لأي بيئة حقيقية).

---

## 13) قواعد الصلاحيات الحالية (`firestore.rules`) — ملخص دقيق

النموذج الحالي يقوم على مفهومين فقط:

- **`isOwner(tenantId)`** = المستخدم مسجّل دخول **و** `request.auth.uid == tenantId`.
- **`isAdmin()`** = المستخدم مسجّل دخول **و** بريده موجود بمصفوفة `config/platform.adminEmails`.

| المسار | قراءة | إنشاء | تعديل | حذف |
|---|---|---|---|---|
| `config/platform` | عام (بدون تسجيل دخول حتى) | أدمن، أو أول بريد تمهيدي (`ragwapos@gmail.com`) لو المستند غير موجود بعد | أدمن فقط | أدمن فقط |
| `tenants/{tenantId}` | المالك أو أدمن | المالك أو أدمن | المالك أو أدمن | **أدمن فقط** |
| `tenants/{tenantId}/invoices/{id}` | المالك أو أدمن | — | المالك أو أدمن (كتابة كاملة) | — |
| `tenants/{tenantId}/settings/{id}` | المالك أو أدمن | — | المالك أو أدمن (كتابة كاملة) | — |
| `tenants/{tenantId}/{أي مجموعة فرعية أخرى}` (products, categories, customers, customerTransactions, addons, serviceTypes, suppliers, purchases, expenseCategories, expenses, promotions) | المالك أو أدمن | **المالك فقط** | **المالك فقط** | المالك أو أدمن |
| `registrationRequests/{id}` | أدمن، أو صاحب الطلب نفسه (`resource.data.uid == request.auth.uid`) | أي مستخدم مسجّل دخول، بشرط `uid` بالمستند = uid حسابه | أدمن فقط | أدمن فقط |
| `salesInquiries/{id}` | أدمن فقط | **عام بالكامل** (حتى بدون تسجيل دخول) | أدمن فقط | أدمن فقط |
| أي مسار آخر غير مذكور | ممنوع بالكامل (`allow read, write: if false`) | | | |

**ملاحظتان مهمتان بالتصميم الحالي:**
- صلاحية حذف المجموعات الفرعية للأدمن (`purchases`, `customers`, إلخ) أُضيفت لاحقاً **خصيصاً** عشان تسمح لميزة "حذف محل" بلوحة الأدمن تشتغل (حذف متكرر recursive) — قبلها كانت هذي المجموعات محمية من أي حذف من طرف الأدمن.
- **لا يوجد أي تحقق صحة بيانات (data validation) بالقواعد نفسها** — القواعد تتحقق فقط "مين" يقدر يكتب، مو "شنو" يكتب (ما فيه `request.resource.data.keys().hasAll([...])` ولا فحص أنواع أو حدود قيم). كل التحقق حالياً بجافاسكربت بالواجهة فقط.

---

## 14) خطة الترجمة إلى Supabase Row Level Security (RLS)

Postgres/Supabase ما فيه مفهوم "قاعدة متكررة تغطي كل شيء تحت مسار" زي `match /{document=**}` — كل جدول يحتاج **سياسات RLS مستقلة صراحة**. هذا يفرض ميزة إيجابية: تصريح صريح لكل جدول بدل قاعدة عامة قد تُنسى تحديثها.

### أ) البنية الأساسية المقترحة

```sql
-- 1) دالة "هل أنا أدمن؟" — تعادل isAdmin() بالضبط
create table platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);

create function is_admin() returns boolean
language sql stable security definer as $$
  select exists (select 1 from platform_admins where user_id = auth.uid());
$$;

-- 2) إعدادات المنصة (يعادل config/platform.autoApprove)
create table platform_config (
  id boolean primary key default true check (id),  -- صف واحد فقط مضمون
  auto_approve boolean not null default true
);

-- 3) tenants — نفس مبدأ Firebase بالضبط: معرّف المستأجر = معرّف حساب المالك
create table tenants (
  id uuid primary key references auth.users(id) on delete cascade,
  shop_name text not null default '—',
  mobile text not null,
  email text not null,
  address text not null default '—',
  approved_date timestamptz not null default now()
);
alter table tenants enable row level security;

create policy tenants_select on tenants for select
  using (id = auth.uid() or is_admin());
create policy tenants_insert on tenants for insert
  with check (id = auth.uid() or is_admin());
create policy tenants_update on tenants for update
  using (id = auth.uid() or is_admin());
create policy tenants_delete on tenants for delete
  using (is_admin());  -- يعادل allow delete: if isAdmin()
```

### ب) القالب الموحّد لبقية الجداول (products, categories, customers, customerTransactions, addons, serviceTypes, suppliers, purchases, expenseCategories, expenses, promotions)

كل هذي الجداول تحتاج عمود `tenant_id uuid not null references tenants(id) on delete cascade`، وتُطبَّق عليها **بالضبط** نفس أربع سياسات (تعادل `allow read: if isOwner || isAdmin(); allow create, update: if isOwner; allow delete: if isOwner || isAdmin();`):

```sql
-- مثال بجدول واحد (products) — كرّر نفس النمط حرفياً لكل جدول بالقائمة أعلاه
alter table products enable row level security;

create policy products_select on products for select
  using (tenant_id = auth.uid() or is_admin());
create policy products_insert on products for insert
  with check (tenant_id = auth.uid());          -- المالك فقط، بدون أدمن
create policy products_update on products for update
  using (tenant_id = auth.uid());                -- المالك فقط، بدون أدمن
create policy products_delete on products for delete
  using (tenant_id = auth.uid() or is_admin());   -- الأدمن يقدر يحذف (لميزة حذف المحل)
```

### ج) جداول لها استثناء (كتابة كاملة للأدمن): `invoices` و`settings`

```sql
alter table invoices enable row level security;

create policy invoices_select on invoices for select
  using (tenant_id = auth.uid() or is_admin());
create policy invoices_insert on invoices for insert
  with check (tenant_id = auth.uid() or is_admin());
create policy invoices_update on invoices for update
  using (tenant_id = auth.uid() or is_admin());   -- ⚠️ الأدمن يقدر يعدّل، بعكس بقية الجداول
-- لا توجد سياسة delete للفواتير أصلاً بالنظام الحالي — لا تُحذف الفواتير أبداً، فقط تُعدَّل (closed=true)
```
(نفس النمط بالضبط لجدول `settings` — عمود واحد لكل tenant، أو `unique(tenant_id)` بدل مفتاح مركّب.)

### د) `registration_requests`

```sql
create table registration_requests (
  id uuid primary key default gen_random_uuid(),
  uid uuid not null references auth.users(id),
  shop_name text not null, mobile text not null, email text not null, address text not null default '—',
  date timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  reject_reason text not null default ''
);
alter table registration_requests enable row level security;

create policy reg_req_select on registration_requests for select
  using (is_admin() or uid = auth.uid());
create policy reg_req_insert on registration_requests for insert
  with check (uid = auth.uid());
create policy reg_req_update on registration_requests for update
  using (is_admin());
create policy reg_req_delete on registration_requests for delete
  using (is_admin());
```

### هـ) `sales_inquiries` — الجدول الوحيد المفتوح لغير المسجّلين

```sql
alter table sales_inquiries enable row level security;

-- يجب تفعيلها صراحة لدور anon، مو بس authenticated — هذا الفرق الأهم عن كل الجداول الثانية
create policy inquiries_insert_public on sales_inquiries for insert
  to anon, authenticated
  with check (true);
create policy inquiries_admin_only on sales_inquiries for select using (is_admin());
create policy inquiries_admin_update on sales_inquiries for update using (is_admin());
create policy inquiries_admin_delete on sales_inquiries for delete using (is_admin());
```

**⚠️ فخ شائع بالترحيل:** لو نسيت `to anon, authenticated` بسياسة `INSERT`، Supabase تفرض RLS افتراضياً على دور `authenticated` فقط — فورم "تواصل مع المبيعات" (اللي يشتغل بدون تسجيل دخول بالتصميم الأصلي) ينكسر بصمت لأي زائر غير مسجّل.

---

## 15) اعتبارات ترحيل Firebase Authentication إلى Supabase Auth

1. **معرّف المستخدم يتغيّر شكلاً:** Firebase Auth UID نص عشوائي (28 حرف تقريباً)، بينما Supabase يستخدم `uuid` قياسي. بما إن `tenants.id` و`registrationRequests.uid` **كلاهما** يساويان حرفياً الـ UID الحالي، الترحيل يحتاج:
   - إنشاء المستخدمين بـ Supabase Auth أولاً (عبر Admin API، بالحفاظ على نفس البريد الإلكتروني)
   - بناء جدول مؤقت `uid_mapping (old_firebase_uid text, new_supabase_uid uuid)` لإعادة كتابة كل حقل `tenant_id`/`uid` بالبيانات المنقولة
   - **هذا لا يمس أي حقل ثاني** — لا `customers.id` (رقم يختاره الموظف يدوياً، مو UID) ولا أي معرّف مجموعة فرعية آخر يتأثر.

2. **تأكيد البريد الإلكتروني مختلف الآلية:** Firebase يعتمد `user.reload()` + فحص `user.emailVerified` (استقصاء يدوي من زر "تحققت، تابع" بالتطبيق). Supabase له تدفقه الخاص (`emailRedirectTo` + `email_confirmed_at` بجدول `auth.users`) — يحتاج إعادة كتابة شاشة `EmailVerificationPage` بالكامل، مو نقل بيانات بسيط.

3. **لا يوجد حالياً "نسيت كلمة المرور" بالتطبيق أصلاً** — فرصة جيدة لإضافتها مباشرة بـ Supabase (`resetPasswordForEmail`) بدل إعادة بناء غياب هذي الميزة بالنظام الجديد.

4. **⚠️ آلية دخول الأدمن الحالية بها نمط لا يُنصح بنقله كما هو:** كلمة مرور تجريبية ثابتة مكتوبة بالكود (`ADMIN_DEMO_PASSWORD`) تُنشئ حساب Firebase Auth حقيقي تلقائياً لأول بريد أدمن يسجّل دخول فيها. هذا مقبول كـ bootstrap لمرة وحدة بمشروع صغير، لكن **يُستحسن استبداله بتدفق دعوة أدمن حقيقي** (Supabase Admin API `inviteUserByEmail`) بالنظام الجديد بدل نقل نفس النمط.

---

## 16) منطق تطبيقي يحتاج إعادة بناء بعد الترحيل (مو مجرد نقل بيانات)

هذي كلها **محسوبة لحظياً بجافاسكربت بالواجهة حالياً، وغير مخزَّنة بأي مستند** — نقل البيانات وحده لن ينقلها:

| المنطق | أين حالياً | التوصية بـ Postgres |
|---|---|---|
| حساب ضريبة القيمة المضافة (الفصل بين صافي/ضريبة من مبلغ شامل) | دالة `invoiceRevenue()` بالواجهة | عمود `generated always as` أو Postgres view، بدل تكراره بكل مكان |
| حالة الفاتورة الكلية (أقل مرحلة بين كل القطع) | دالة `invoiceOverallStatus()` بالواجهة | يمكن تبقى بمنطق التطبيق (حساب رخيص)، أو دالة SQL لو احتجتها بالتقارير مباشرة |
| فحص تداخل فترات الخصومات | دالة `promosOverlap()` **بالواجهة فقط، بدون أي قيد بقاعدة البيانات** | **يُستحسن تحويلها لقيد فعلي بقاعدة البيانات** — انظر التحذير بالقسم 19 |
| الحد الأقصى لدفعات الموردين/ديون العملاء (منع رصيد سالب) | فحص `if (amt > balance)` بالواجهة فقط قبل الكتابة | **يُستحسن `CHECK (balance >= 0)` فعلي بقاعدة البيانات** — انظر القسم 19 |
| فلترة "الفواتير النشطة" وترتيبها بالتاريخ | `.filter()`/`.sort()` بالواجهة على كل السجلات المحمّلة | ترحيله لاستعلام SQL (`WHERE closed = false ORDER BY created_at DESC`) أفضل بكثير من ناحية الأداء مع نمو البيانات |
| تجميع تقارير المنصة (أفضل المحلات، نمو التسجيلات، إلخ) بلوحة الأدمن | تُحسب بجافاسكربت من كل الفواتير المحمّلة لحظياً بالمتصفح لكل المحلات | **أولوية عالية لإعادة بنائها كـ SQL aggregate queries** — النمط الحالي (تحميل فواتير كل المحلات لجهاز الأدمن ثم الجمع بالمتصفح) لن يتوسّع أصلاً مع نمو عدد المحلات |

---

## 17) اعتبارات ترحيل الملفات (Base64 → Supabase Storage)

حقلان فقط فيهما ملفات، وكلاهما Base64 كامل داخل المستند (`products.image`, `purchases.attachment`):

1. أنشئ Buckets بـ Supabase Storage (مثلاً `product-images`, `purchase-attachments`) بصلاحيات تطابق نفس منطق `isOwner`/`isAdmin` أعلاه (Storage بـ Supabase له سياسات RLS منفصلة خاصة فيه).
2. لكل مستند فيه هذي الحقول: فك ترميز الـ Base64 → رفعه كملف حقيقي بالـ Bucket المناسب بمسار يتضمن `tenant_id` → استبدال قيمة الحقل بمسار/رابط الملف الجديد بدل النص الطويل.
3. **لا تحتفظ بالنمط الحالي بالنظام الجديد** — تخزين صور كـ Base64 داخل صفوف Postgres يضخّم حجم الجدول ويبطئ كل استعلام `SELECT *` عليه، حتى لو ما احتجت الصورة نفسها.
4. ملاحظة: `expenses.receipt` **ليس ملف فعلي** — مجرد اسم نصي بدون محتوى حقيقي، فما يحتاج أي ترحيل ملفات، فقط نقل النص كما هو (أو تحسينه لاحقاً ليصير رفع فعلي، بما إنه أضعف من نمط `purchases.attachment` المجاور له بنفس الشاشة).

---

## 18) خريطة تحويل الأنواع (Firestore → Postgres) — قاعدة عامة لكل حقل بالجزء الأول

| نوع Firestore | التحويل المقترح بـ Postgres | ملاحظة |
|---|---|---|
| نص عادي | `text` | |
| رقم | `numeric` للمبالغ المالية (تجنّب `float`/`real` لأخطاء التقريب)، `integer` للعدّادات/الكميات | |
| Boolean | `boolean` | |
| نص ISO datetime (`toISOString()`) | `timestamptz` | يشمل كل حقول `date`/`createdAt`/إلخ **ما عدا** `expenses.date` |
| `expenses.date` (نص `YYYY-MM-DD` فقط) | `date` (بدون وقت) | الحقل الوحيد المستثنى من القاعدة أعلاه |
| كائن متداخل (map) بسيط، مثل `products.services`, `settings.enabledPayMethods` | `jsonb` | تطبيعه لجدول منفصل ممكن لاحقاً كتحسين، مو ضروري بالترحيل الأول |
| مصفوفة كائنات، مثل `invoice.items[]`, `productAddons[]`, `splitPayments[]` | `jsonb` بالمرحلة الأولى، مع خيار تطبيعه لجدول ابن (`invoice_items` مثلاً) بمرحلة ثانية لو احتجت استعلامات SQL مباشرة عليها (تقارير حسب المنتج، إلخ) | `invoice.items[]` هو أقوى مرشّح للتطبيع لجدول مستقل، لأنه الأكثر استخداماً بالتقارير |
| معرّف Firestore عشوائي (`ref.id`) | `uuid default gen_random_uuid()` | لكل الجداول عدا `customers` (رقم يختاره المستخدم يدوياً → `integer`) و`tenants`/`registration_requests.uid` (يساوي معرّف Auth → `uuid references auth.users`) |

---

## 19) أخطاء وثغرات موجودة بالنظام الحالي — لا تُنقل كما هي للنظام الجديد

هذي القائمة ليست عن بنية البيانات، بل عن **سلوكيات حالية يجب تصحيحها أثناء إعادة البناء فوق Postgres**، مو مجرد نسخها:

1. **فحص "لا يتجاوز الرصيد" غير ذرّي (race condition):** سداد دفعات الموردين وديون العملاء يتحقق حالياً بجافاسكربت (`if (amt > balance) reject`) **ثم** يكتب — لو فتح نفس المستخدم تبويبين وسدّد بنفس اللحظة من الاثنين، ممكن نظرياً يمر المبلغ مرتين قبل ما يتحدث الرصيد المعروض. **بـ Postgres، أضف قيد فعلي:** `alter table suppliers add constraint balance_non_negative check (balance >= 0);` (ونفس الشي لـ `customers.debt`) — هذا يضمن الحماية على مستوى قاعدة البيانات نفسها، بغض النظر عن أي سباق بالواجهة.

2. **فحص تداخل فترات الخصومات غير ذرّي بنفس الطريقة:** يتحقق بجافاسكربت فقط قبل الكتابة، بدون أي قيد فعلي بقاعدة البيانات. **بـ Postgres، استخدم قيد استبعاد (Exclusion Constraint) حقيقي:**
   ```sql
   alter table promotions add column period tstzrange
     generated always as (tstzrange(start_date, end_date, '[]')) stored;
   create extension if not exists btree_gist;
   alter table promotions add constraint no_overlapping_active_promos
     exclude using gist (tenant_id with =, period with &&) where (active);
   ```
   هذا يمنع التداخل **فعلياً** حتى لو صارت الكتابة من مصدرين بنفس اللحظة تماماً — عكس الفحص الحالي اللي يعتمد بالكامل على الترتيب الزمني للطلبات بالمتصفح.

3. **قيمة enum غير متسقة لنفس المعنى:** `"Credit (On Account)"` (عملاء/فواتير) مقابل `"Credit / On Account"` (مشتريات) — طبّعها لقيمة واحدة (`'credit'` مثلاً) قبل الترحيل، وأضف `CHECK (method in (...))` بدل الاعتماد على الانضباط بكود الواجهة فقط.

4. **لا يوجد تحقق صحة بمستوى قاعدة البيانات إطلاقاً حالياً** (لا بـ Firestore Rules ولا بأي مكان آخر غير جافاسكربت الواجهة) — أي بيانات فاسدة (رقم سالب، بريد بصيغة خاطئة، تاريخ نهاية قبل تاريخ بداية) ممكنة تقنياً لو تم تجاوز الواجهة (مثلاً عبر استدعاء مباشر لـ API). أضف قيود `CHECK`/`NOT NULL`/`UNIQUE` صريحة بـ Postgres لكل الحالات المذكورة بالجزء الأول كـ"إلزامي" أو له نطاق قيم محدد (enum)، بدل الاعتماد على انضباط كود التطبيق فقط.

5. **تحميل بيانات ضخم بالمتصفح لتقارير لوحة الأدمن:** فواتير **كل المحلات** تُحمَّل لحظياً لجهاز متصفح الأدمن (`onSnapshot` لكل تينانت + دمج بالمتصفح) لحساب أي تقرير مجمّع — هذا نمط لن يتوسّع، ويصير أبطأ وأثقل مع كل محل جديد ينضم. بمجرد الترحيل لـ Postgres، **استبدله فوراً** باستعلامات SQL مجمّعة (`GROUP BY`, `SUM`, إلخ) تُنفَّذ بالخادم، مو بالمتصفح.

6. **الصور والمرفقات داخل المستند نفسه (Base64):** يضخّم كل قراءة/كتابة حتى لو ما احتجت الصورة، ويستهلك حصة تخزين Firestore بسرعة غير ضرورية. مذكور بالتفصيل بالقسم 17 أعلاه — لا تُبقيه كنمط بالنظام الجديد.
