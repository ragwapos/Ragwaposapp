# نشر إضافة رغوة على Chrome Web Store

نص جاهز للنسخ لكل خانة بلوحة المطوّر (`chrome.google.com/webstore/devconsole`). الملف اللي ينرفع يتبني بـ`npm run build:extension` ويطلع بـ`dist-extension/ragwa-whatsapp-extension-<version>.zip`. النسخة اللي فيه صلاحياتها للإنتاج بس (`web.whatsapp.com` و`ragwapos.com`)، بدون localhost وstaging.

## 1) الحزمة (Package)
- ارفع: `dist-extension/ragwa-whatsapp-extension-1.0.0.zip`
- **الظهور (Visibility):** Unlisted (غير مدرجة) — ما تطلع بالبحث، وتنزل فقط من الرابط.
- **التحديثات:** ارفع رقم `version` بـ`manifest.json`، وابنِ من جديد، وارفع الـzip الجديد. كروم يحدّثها عند العملاء تلقائياً.

## 2) بيانات المتجر (Store listing)
**الاسم:** Ragwa WhatsApp Reminders

**التصنيف:** Productivity (or Tools)

**اللغة الأساسية:** Arabic

**الوصف القصير (132 حرف بالكثير):**
> تذكير عملاء المغسلة باستلام طلباتهم عبر واتساب ويب من نظام رغوة. الموظف يراجع كل رسالة ويرسلها بنفسه.

بالإنجليزي (لو اخترت إضافة لغة ثانية):
> Remind your laundry customers to pick up ready orders via WhatsApp Web, from Ragwa. Staff review and send every message.

**الوصف المفصّل:**

> إضافة رسمية لنظام رغوة لإدارة مغاسل الملابس.
>
> من شاشة "تذكيرات اليوم" في رغوة، تفتح الإضافة محادثة كل عميل عنده طلب جاهز ما استلمه، داخل نفس تبويب واتساب ويب، ونص التذكير مكتوب مسبقاً. العميل اللي عنده أكثر من طلب يوصله تذكير واحد فيه كل طلباته.
>
> • الموظف يراجع الرسالة ويضغط Enter بنفسه. الإضافة ما ترسل أي رسالة لحالها أبداً.
> • بعد الإرسال تنتقل للمحادثة اللي بعدها تلقائياً، مع عدّاد وزر تخطي وزر إيقاف.
> • كل تذكير انرسل ينسجّل في حساب المحل برغوة، حتى لو كان تبويب رغوة مقفول وقت الإرسال.
> • ما تقرأ محادثاتك، وما تتصل بأي خادم بنفسها، وما فيها أي إعلانات.
>
> تحتاج حساب فعّال في رغوة: https://www.ragwapos.com

> Official companion extension for Ragwa, the laundry shop management system.
>
> From Ragwa's "Today's Reminders" screen, the extension opens each customer with a ready, uncollected order in the same WhatsApp Web tab, with the reminder text already typed as a draft. A customer with several orders gets one reminder listing all of them.
>
> • Staff review the message and press Enter themselves. The extension never sends a message on its own.
> • After sending, it moves to the next chat automatically, with a counter, Skip and Stop.
> • Every sent reminder is recorded in the shop's Ragwa account, even if the Ragwa tab was closed at the time.
> • It does not read your chats, does not contact any server itself, and has no ads.
>
> Requires an active Ragwa account: https://www.ragwapos.com

**الصور:**
- أيقونة المتجر 128×128: `ragwa-whatsapp-extension/icons/icon-128.png`
- لقطات الشاشة 1280×800 (موجودة بـ`ragwa-whatsapp-extension/store/`):
  1. `screenshot-1-messages.png` — بطاقات رسائل واتساب الثلاث برغوة.
  2. `screenshot-2-reminders.png` — شاشة "تذكيرات اليوم" (عملاء تجريبيين بأرقام وهمية).
- ما فيه لقطة لواتساب ويب نفسه عمداً، لأن أي لقطة حقيقية فيها محادثات خاصة. لو تبي وحدة، صوّرها بجوال تجريبي ما فيه محادثات.

## 3) الخصوصية (Privacy practices)
**الغرض الواحد (Single purpose):**
> Open Ragwa's pickup reminders one by one in WhatsApp Web as drafts for the shop's staff to review and send themselves.

**تبرير الصلاحيات:**
| الصلاحية | التبرير (بالإنجليزي، للخانة) |
|---|---|
| `storage` | Keeps the current reminder list, the position in it, and confirmations of sent reminders on the device until the Ragwa page records them, so nothing is lost if a tab is closed. |
| `https://web.whatsapp.com/*` | Opens each reminder's chat in the open WhatsApp Web tab, places the reminder text as a draft, shows the progress panel, and detects when the employee has sent it. It never sends a message itself. |
| `https://ragwapos.com/*`, `https://www.ragwapos.com/*` | Receives the reminder list from the signed-in Ragwa page and hands back confirmations of sent reminders so the page can record them in the shop's account. |

**كود عن بُعد (Remote code):** No, I am not using remote code. (كل الكود داخل الحزمة، وما فيه `eval` ولا سكربتات خارجية.)

**استخدام البيانات (Data usage)** — علّم على:
- **Personally identifiable information:** نعم. (اسم العميل ورقم جواله، يجون من حساب المحل برغوة.)
- **Personal communications:** نعم. (نص رسالة التذكير اللي ينكتب كمسودة.)
- الباقي (المعلومات الصحية والمالية والمصادقة والموقع وسجل التصفح ونشاط المستخدم ومحتوى المواقع): لا.

وعلّم على الإقرارات الثلاثة:
- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**رابط سياسة الخصوصية:** https://www.ragwapos.com/privacy (البند 6.9 يشرح الإضافة).

## 4) قبل الإرسال للمراجعة
1. لازم تكون ميزة التذكيرات منشورة على الإنتاج (`supabase-pickup-reminders.sql` على قاعدة الإنتاج، وبعده دمج الكود)، وإلا المراجع ما يلقى الشاشة اللي تتكلم عنها الإضافة.
2. بند الخصوصية 6.9 لازم يكون منشور على `www.ragwapos.com/privacy` قبل الإرسال.
3. ممكن المراجع يطلب حساب تجريبي. جهّز محل تجريبي على الإنتاج، وحط بياناته بخانة "Test instructions" (مو بهالملف).
