// بيانات صفحة الهبوط العامة (نصوص عربي/إنجليزي فقط، بدون JSX) — مصدر
// وحيد يُستهلك من مسارين: src/App.jsx (LandingPage، وقت الرندر الفعلي
// بالمتصفح) و scripts/build-landing-prerender.mjs (وقت الـpostbuild، لبناء
// لقطة HTML ثابتة تُحقن داخل dist/index.html و dist/en/index.html). الهدف:
// زواحف لا تُشغّل جافاسكربت (GPTBot, ClaudeBot, PerplexityBot, ...) تشوف
// نفس المحتوى بالضبط اللي يشوفه أي زائر حقيقي بعد ما يشتغل React — صفر
// تكرار محتوى بين المسارين. راجع قسم "Prerendering لصفحة الهبوط" بخطة
// الجلسة، ونمط content/guides.mjs المطابق لنفس الفكرة بـ/guides.

export const SITE_URL = 'https://www.ragwapos.com';

export const LANDING_TEXT = {
  ar: {
    brand: 'رغوة',
    navFeatures: 'المميزات', navPricing: 'الأسعار', navHow: 'كيف يعمل', navWhy: 'لماذا رغوة؟', navFaq: 'الأسئلة الشائعة',
    navGuides: 'أدلة ومقالات',
    navContact: 'تواصل مع فريقنا',
    navLogin: 'الدخول',
    heroTitlePlain: 'خلّ المغسلة تمشي… ',
    heroTitleAccent: 'وأنت ارتاح',
    heroDesc: 'رغوة يرتّب مغسلتك من الاستلام إلى التسليم. كاشير سريع، تتبع لكل قطعة، فواتير إلكترونية، ومناديب تحت عينك — كل هذا بنظام سحابي مصمم للمغاسل السعودية.',
    heroSupport: 'زحمة الجمعة؟ موسم العيد؟ رغوة معك، عشان شغلك يستمر.. وعميلك ينبهر.',
    ctaStart: 'جرّب رغوة مجاناً',
    ctaDemo: 'احجز عرض توضيحي',
    trustRow: ['سحابي بالكامل', 'متوافق مع الفوترة الإلكترونية', 'يعمل من الجوال والتابلت'],
    heroMockCaption: 'نموذج توضيحي',
    heroMockSales: 'مبيعات اليوم', heroMockOrders: 'عدد الطلبات', heroMockRecent: 'أحدث الطلبات',
    heroMockStages: ['استلام', 'غسيل', 'كوي', 'جاهز', 'تم التسليم'],

    problemsEyebrow: 'نعرف وش تواجه كل يوم',
    problemsTitle: 'مغسلتك ما تحتاج شغل أكثر… تحتاج شغل أرتب.',
    problemsSubtitle: 'لأننا نعرف أن المشكلة مو في الغسيل، المشكلة في التفاصيل اللي تتراكم مع الزحمة.',
    problems: [
      { q: 'وين الثوب؟', pain: 'العميل يتصل: «يا طويل العمر، الثوب اللي سلمته أمس وينه؟» وتبدأ الرحلة المعتادة: دور عند الكاونتر… شوف المستودع… اسأل العامل… يمكن مع طلب التوصيل.', solution: 'مع رغوة، كل قطعة مرتبطة بالطلب من لحظة الاستلام إلى التسليم. تعرف الطلب وين وصل، وش المطلوب له، ومتى جاهز.', highlight: 'ثوبك ما عاد يضيع وسط الزحمة.' },
      { q: 'الفاتورة وين؟ والحسبة كم؟', pain: 'دفتر هنا، فاتورة هناك، وحسبة آخر اليوم تعتمد على «أظن إنها كذا».', solution: 'فاتورة إلكترونية تطلع للعميل عبر الواتساب وQR، مع تسجيل المبيعات والطلبات بشكل مرتب ومتوافق مع متطلبات الفوترة الإلكترونية في السعودية.', highlight: 'الحسبة واضحة… وما عاد فيه «وين الفاتورة؟».' },
      { q: 'المندوب وين وصل؟', pain: 'طلبات توصيل كثيرة، ومندوب يقول «أنا بالطريق»، وعميل يسأل «متى توصل؟»… وأنت بين الكاشير والتلفون تحاول تجمع الصورة.', solution: 'إدارة للمناديب وحسابات السائقين والطلبات، عشان تعرف وش مع المندوب، وش تسلّم، وش باقي.', highlight: 'التوصيل يصير شغل مرتب، مو مطاردة اتصالات.' },
      { q: 'تقفّل الكاشير… بس لا تبدأ الحسبة من جديد', pain: 'آخر اليوم: كاش، تحويلات، ورديات، فواتير… ثم تبدأ عملية الجرد والتقفيل وكأنك تحل لغز.', solution: 'تقارير ومؤشرات أداء تساعدك تعرف مبيعاتك، وردياتك وتقفيلك اليومي بوضوح.', highlight: 'بدل ما تقفل يومك بالحيرة… قفّله بالأرقام.' },
    ],

    midCtaTitle: 'حسّيت إننا نتكلم عن مغسلتك؟',
    midCtaDesc: 'خلّنا نوريك كيف رغوة يرتّب الشغل من أول استلام إلى آخر تقفيل.',

    compareTitleOld: 'مغسلة على البركة 🧾', compareTitleNew: 'مغسلة برغوة 🚀',
    compareClosing: 'الطريقة القديمة تعتمد على الذاكرة… رغوة يعتمد على النظام.',
    compareRows: [
      { before: 'اكتبها بالدفتر لا تنساها', after: 'الطلب يتسجل من أول لحظة' },
      { before: 'الثوب كان هنا… أحد شافه؟', after: 'كل قطعة لها تتبع' },
      { before: 'أرسل الفاتورة للعميل… لحظة وينها؟', after: 'الفاتورة على الواتساب وQR' },
      { before: 'المندوب أخذ كم طلب؟', after: 'تعرف الطلبات وحسابات السائقين' },
      { before: 'كم بعنا اليوم؟ — خلني أحسب', after: 'التقرير قدامك' },
      { before: 'زحمة العيد = الله يعين 😅', after: 'زحمة العيد = هات الطلب اللي بعده 💪' },
      { before: 'التقفيل يحتاج ورقة وقلم وحسبة', after: 'التقفيل أوضح وأسهل' },
      { before: 'المدير لازم يكون بالمغسلة', after: 'الإدارة من الجوال' },
    ],

    featuresTitle: 'المميزات',
    features: [
      { title: 'فاتورتك على الواتساب', desc: 'خلصت الخدمة؟ الفاتورة تروح للعميل إلكترونياً. واتساب + QR + متطلبات الفوترة الإلكترونية، بدون وجع رأس الفواتير الورقية.', highlight: 'الفاتورة جاهزة… والعميل مرتاح.' },
      { title: 'كل قطعة لها سالفة… ورغوة حافظها', desc: 'ثوب، شماغ، مفرش، كوي على البخار أو طلب مستعجل — سجّل وتتبع كل قطعة من الاستلام لين ترجع لصاحبها.', highlight: 'ودّع تدوير القطع بالذاكرة.' },
      { title: 'مغسلتك بجيبك', desc: 'مو لازم تكون واقف عند الكاشير عشان تعرف وش صاير. افتح جوالك وشوف المبيعات، الورديات، التقفيل ومؤشرات الأداء.', highlight: 'المدير يعرف… حتى وهو بعيد.' },
      { title: 'المناديب تحت السيطرة', desc: 'مين أخذ الطلب؟ وش سلّم؟ وكم عليه؟ رغوة يساعدك ترتب طلبات التوصيل وحسابات السائقين من مكان واحد.', highlight: 'بدل «وين المندوب؟»… تعرف وش عنده.' },
    ],

    howTitle: 'من الاستلام… إلى التسليم',
    howSteps: [
      { step: 1, title: 'استلم', desc: 'سجّل طلب العميل وقطع الملابس.' },
      { step: 2, title: 'عالج', desc: 'حدد الغسيل، الكوي، المستعجل والخدمات.' },
      { step: 3, title: 'تابع', desc: 'تابع حالة القطع والطلبات والمناديب.' },
      { step: 4, title: 'سلّم', desc: 'سلّم الطلب، أرسل الفاتورة، وسجّل العملية.' },
    ],

    cloudTitle: 'مغسلتك معك… وين ما كنت',
    cloudDesc: 'ما تحتاج سيرفرات معقدة ولا جهاز معين. رغوة سحابي بالكامل ويعمل من الكمبيوتر، التابلت أو الجوال.',
    cloudHighlight: 'من المغسلة… من المكتب… وحتى وأنت بعيد.',

    trustTitle: 'مصمم للمغاسل السعودية',
    trustChecklist: ['فواتير إلكترونية', 'نظام سحابي', 'تتبع للقطع', 'إدارة المناديب', 'تقارير لحظية'],

    pricing: {
      title: 'باقات بسيطة وأسعار واضحة',
      subtitle: 'ابدأ مجانًا وجرّب كل مميزات رغوة، وحين تقتنع اشترك سنة كاملة بسعر واحد.',
      popularBadge: 'الأكثر اختياراً',
      trial: {
        name: 'التجربة المجانية', tagline: 'جرّب كل مميزات رغوة بنفسك قبل ما تشترك',
        price: 'مجانًا', unit: 'لمدة 14 يوم', note: 'بدون بطاقة بنكية',
        bullets: ['كل مميزات النظام بدون استثناء', '14 يوم كاملة', 'تدخل النظام مباشرة بعد تأكيد بريدك'],
        cta: 'ابدأ التجربة المجانية',
      },
      annual: {
        name: 'الباقة السنوية', tagline: 'لمغسلة تشتغل بكل مميزات رغوة طول السنة',
        price: '350', unit: 'ريال / السنة', note: 'شامل ضريبة القيمة المضافة',
        bullets: ['كل مميزات النظام بدون استثناء', 'سنة كاملة من تاريخ التفعيل', 'الدفع حاليًا بالتحويل البنكي، والدفع الإلكتروني قريبًا'],
        cta: 'اشترك الآن',
      },
      enterprise: {
        name: 'الإنتربرايز', tagline: 'لسلاسل المغاسل والفروع الكثيرة والاحتياجات الخاصة',
        price: 'تواصل معنا', unit: '', note: 'عرض سعر حسب حجم نشاطك',
        bullets: ['كل مميزات الباقة السنوية', 'حلول مخصصة للسلاسل والفروع الكثيرة', 'تواصل مباشر مع فريقنا'],
        cta: 'تواصل معنا عبر واتساب',
      },
      includesTitle: 'التجربة المجانية والباقة السنوية تشملان كل المميزات',
      features: [
        'نقطة بيع سريعة (كاشير) مع مفاتيح وصول سريعة',
        'تتبع كل قطعة من الاستلام إلى التسليم',
        'فواتير إلكترونية برمز QR وإرسالها عبر واتساب',
        'رسائل واتساب جاهزة للعميل عند جاهزية الطلب',
        'إدارة التوصيل والمناديب',
        'محفظة العميل وشحن الرصيد مع مكافأة على الشحن',
        'الدفع الآجل وتتبع مديونيات العملاء',
        'الدفع المختلط (نقد، شبكة، محفظة، آجل)',
        'خصومات وكوبونات بفترات زمنية',
        'المنتجات والخدمات والإضافات',
        'المشتريات والموردين والمصروفات',
        'تقارير المبيعات والضريبة والأرباح',
        'إدارة عدة فروع: مبيعات ومصروفات وخصومات لكل فرع وحسابات دخول مستقلة',
        'حماية الأقسام الحساسة برمز سري',
        'واجهة بثلاث لغات: العربية والإنجليزية والأردية',
        'يعمل من الجوال والتابلت والكمبيوتر',
      ],
    },
    walletDebtTitle: 'وش نقصد بـ"الاشتراكات" و"الدفع الآجل"؟',
    walletDebtDesc: 'هذي المصطلحات توصف ميزتين حقيقيتين داخل رغوة نفسه، يستخدمهم أصحاب المغاسل مع عملائهم — مو رسوم اشتراك رغوة على صاحب المحل. رصيد المحفظة يخلي عميلك يشحن مبلغ مقدمًا ويصرفه على دفعات، والدفع الآجل يخلي عميلك ياخذ الخدمة اليوم ويسدد لاحقًا — والنظام يتابع الرصيدين بدقة ويمنع أي خطأ بالحسبة.',
    walletDebtLinkText: 'اقرأ الدليل الكامل: إدارة رصيد العملاء والدفع الآجل',

    featureMock: {
      invoiceLine1: 'فاتورة إلكترونية', invoiceLine2: 'تم الإرسال للعميل عبر واتساب',
      pieceLabels: ['ثوب — جاهز', 'شماغ — غسيل', 'مفرش — كوي'],
      statLabel: 'تقفيل الوردية اليوم', statValue: '2,450 SAR',
      driverLabel: 'مندوب أحمد — 5 طلبات',
    },

    faqTitle: 'الأسئلة الشائعة',
    faq: [
      { q: 'هل رغوة يحتاج جهاز أو سيرفر خاص؟', a: 'لا، يشتغل من أي متصفح على كمبيوتر أو جوال أو تابلت، بدون تركيب أي برنامج أو سيرفر خاص.' },
      { q: 'هل يدعم الفوترة الإلكترونية؟', a: 'نعم، رغوة مبني على التوافق مع متطلبات الفوترة الإلكترونية بالمملكة.' },
      { q: 'أقدر أدير أكثر من فرع؟', a: 'نعم. تقدر تضيف فروع غير محدودة داخل حساب واحد: لكل فرع مبيعاته وفواتيره ومصروفاته وخصوماته المنفصلة، وحساب دخول مستقل لموظفيه، مع عملاء ومنتجات مشتركة وتقارير تجمع كل الفروع للمالك. كل فرع إضافي بـ 200 ريال في السنة (يُحسب بالتناسب مع المتبقي من اشتراكك ويتجدد معه)، ويُضاف بعد تأكيد الدفع.' },
      { q: 'لازم أغيّر طريقة شغلي بالكامل عشان أبدأ؟', a: 'لا، تصميم رغوة بسيط ومباشر — تقدر تبدأ البيع بنفس اليوم بدون ما تغيّر طريقة شغلك من جذورها.' },
      { q: 'كيف أبدأ التجربة المجانية؟', a: 'اضغط «ابدأ التجربة المجانية»، سجّل بيانات محلك، وابدأ البيع مباشرة لمدة 14 يومًا بكل المميزات.' },
    ],

    finalCtaTitle: 'خل شغلك أرتب… ومغسلتك أهدى.',
    finalCtaDesc: 'جرّب رغوة وشوف بنفسك كيف يتحول شغل المغسلة من دفاتر وحسبة وتوتر… إلى نظام واضح تمسكه من جوالك.',
    finalCtaSupport: 'بدون تعقيد. بدون سيرفرات. وبدون ما تغيّر طريقة شغلك من يوم وليلة.',

    footerCta: 'جاهز ترتب مغسلتك؟',
    footerRights: 'جميع الحقوق محفوظة',
    contactModalTitle: 'تواصل مع فريقنا',
    contactSentMsg: 'تم إرسال طلبك، بيتواصل معك فريقنا قريبًا.',
    contactName: 'الاسم', contactMobile: 'رقم الجوال', contactEmail: 'البريد الإلكتروني',
    contactType: 'نوع الاستفسار', contactMessage: 'الرسالة', contactSend: 'إرسال',
    contactTypes: ['شراء نظام', 'سؤال تقني', 'عرض خاص'],
  },
  en: {
    brand: 'Ragwa',
    navFeatures: 'Features', navPricing: 'Pricing', navHow: 'How It Works', navWhy: 'Why Ragwa?', navFaq: 'FAQ',
    navGuides: 'Guides',
    navContact: 'Contact Sales',
    navLogin: 'Log In',
    heroTitlePlain: 'Let the shop run… ',
    heroTitleAccent: 'while you relax',
    heroDesc: 'Ragwa keeps your laundry shop organized from intake to delivery. A fast checkout, per-item tracking, e-invoices, and drivers you can always see — all in one cloud system built for Saudi laundry shops.',
    heroSupport: "Busy Friday? Eid season rush? Ragwa's got you, so your work keeps moving and your reputation stays spotless.",
    ctaStart: 'Try Ragwa Free',
    ctaDemo: 'Book a Demo',
    trustRow: ['Fully cloud-based', 'E-invoicing compliant', 'Works on mobile & tablet'],
    heroMockCaption: 'Illustrative example',
    heroMockSales: "Today's Sales", heroMockOrders: 'Order Count', heroMockRecent: 'Recent Orders',
    heroMockStages: ['Received', 'Washing', 'Pressing', 'Ready', 'Delivered'],

    problemsEyebrow: 'We know what you deal with every day',
    problemsTitle: "Your shop doesn't need more work… it needs tidier work.",
    problemsSubtitle: "Because we know the problem isn't the washing — it's the details that pile up when things get busy.",
    problems: [
      { q: "Where's the shirt?", pain: 'A customer calls: "Hey, where\'s the thobe I dropped off yesterday?" And the usual chase begins — check the counter, check the back room, ask the staff, maybe it went out for delivery.', solution: 'With Ragwa, every piece is linked to its order from intake to delivery. You know exactly where the order is, what it needs, and when it\'s ready.', highlight: "Your customer's clothes never get lost in the shuffle." },
      { q: "Where's the invoice? What do I owe?", pain: 'A notebook here, a receipt there, and an end-of-day total based on "I think it was around this much."', solution: 'An e-invoice goes out to the customer over WhatsApp with a QR code, while every sale and order is recorded cleanly and in line with Saudi e-invoicing requirements.', highlight: 'The math is clear — no more "where\'s the invoice?"' },
      { q: 'Where did the driver get to?', pain: 'Lots of delivery orders, a driver saying "I\'m on my way," and a customer asking "when will it arrive?" — while you\'re stuck between the register and the phone trying to piece it together.', solution: 'Driver management with delivery and order tracking, so you always know what each driver has, what\'s delivered, and what\'s left.', highlight: "Delivery becomes organized work, not a phone-chasing game." },
      { q: "You close the register… but don't start the math over", pain: "End of day: cash, transfers, shifts, invoices… then comes the count and close-out like solving a puzzle.", solution: 'Reports and performance indicators that show you your sales, shifts, and daily close-out clearly.', highlight: "Close your day with numbers, not guesswork." },
    ],

    midCtaTitle: 'Sound like your shop?',
    midCtaDesc: "Let's show you exactly how Ragwa organizes the work, from the first item you take in to the last close-out.",

    compareTitleOld: 'The Old-School Shop 🧾', compareTitleNew: 'The Ragwa Shop 🚀',
    compareClosing: 'The old way relies on memory… Ragwa relies on the system.',
    compareRows: [
      { before: "Write it in the notebook, don't forget it", after: 'The order is logged from the first moment' },
      { before: 'The shirt was here… did anyone see it?', after: 'Every piece is tracked' },
      { before: "Send the invoice to the customer… wait, where is it?", after: 'Invoice on WhatsApp with a QR code' },
      { before: 'How many orders did the driver take?', after: "You know the orders and the drivers' accounts" },
      { before: "How much did we sell today? — let me calculate", after: 'The report is right in front of you' },
      { before: 'Eid rush = good luck 😅', after: "Eid rush = next order, please 💪" },
      { before: 'Closing out needs paper, a pen, and a calculator', after: 'Closing out is clearer and easier' },
      { before: 'The manager has to be physically at the shop', after: 'Manage it from your phone' },
    ],

    featuresTitle: 'Features',
    features: [
      { title: 'Invoices on WhatsApp', desc: "Order done? The invoice goes to the customer electronically. WhatsApp + QR + e-invoicing compliance, no more paper-invoice headaches.", highlight: 'Invoice ready… customer happy.' },
      { title: 'Every piece has a story… and Ragwa keeps it', desc: "A thobe, a shemagh, a bedsheet, steam-press or a rush order — log and track every single piece from intake until it's back with its owner.", highlight: 'Say goodbye to tracking pieces by memory.' },
      { title: 'Your shop in your pocket', desc: "No need to be standing at the register to know what's happening. Open your phone and see sales, shifts, close-outs, and performance indicators.", highlight: 'The manager knows… even from far away.' },
      { title: 'Drivers, under control', desc: "Who took the order? What was delivered? What's owed? Ragwa helps you organize delivery orders and driver accounts from one place.", highlight: 'Instead of "where\'s the driver?" — you know what they have.' },
    ],

    howTitle: 'From Intake… to Delivery',
    howSteps: [
      { step: 1, title: 'Intake', desc: "Log the customer's order and garments." },
      { step: 2, title: 'Process', desc: 'Set the wash, iron, rush, and other services.' },
      { step: 3, title: 'Track', desc: 'Follow the status of pieces, orders, and drivers.' },
      { step: 4, title: 'Deliver', desc: "Hand over the order, send the invoice, and record it." },
    ],

    cloudTitle: 'Your shop, wherever you are',
    cloudDesc: "No complicated servers or special hardware needed. Ragwa is fully cloud-based and works from a computer, tablet, or phone.",
    cloudHighlight: 'From the shop… from the office… even while you\'re away.',

    trustTitle: 'Built for Saudi Laundry Shops',
    trustChecklist: ['E-invoicing', 'Cloud-based system', 'Item tracking', 'Driver management', 'Live reports'],

    pricing: {
      title: 'Simple plans, clear pricing',
      subtitle: 'Start free and try every Ragwa feature; when you are convinced, subscribe for a full year at one price.',
      popularBadge: 'Most popular',
      trial: {
        name: 'Free Trial', tagline: 'Try every Ragwa feature yourself before you subscribe',
        price: 'Free', unit: 'for 14 days', note: 'No credit card needed',
        bullets: ['Every feature, no exceptions', 'A full 14 days', 'Straight into the system after you confirm your email'],
        cta: 'Start the free trial',
      },
      annual: {
        name: 'Annual Plan', tagline: 'For a shop that runs on every Ragwa feature all year',
        price: '350', unit: 'SAR / year', note: 'VAT included',
        bullets: ['Every feature, no exceptions', 'A full year from activation', 'Pay by bank transfer for now; online payment is coming soon'],
        cta: 'Subscribe now',
      },
      enterprise: {
        name: 'Enterprise', tagline: 'For laundry chains, many branches and special needs',
        price: 'Contact us', unit: '', note: 'Quote based on the size of your business',
        bullets: ['Everything in the Annual Plan', 'Custom solutions for chains and many branches', 'Direct line to our team'],
        cta: 'Contact us on WhatsApp',
      },
      includesTitle: 'The free trial and the annual plan both include every feature',
      features: [
        'Fast point of sale (cashier) with quick-access keys',
        'Track every item from drop-off to delivery',
        'E-invoices with a QR code, sent over WhatsApp',
        'Ready-made WhatsApp messages when an order is ready',
        'Delivery and driver management',
        'Customer wallet and top-ups with a top-up bonus',
        'Deferred payment and customer debt tracking',
        'Split payments (cash, card, wallet, on account)',
        'Time-boxed discounts and coupons',
        'Products, services and add-ons',
        'Purchases, suppliers and expenses',
        'Sales, VAT and profit reports',
        'Multi-branch: sales, expenses and discounts per branch, with separate branch logins',
        'PIN protection for sensitive sections',
        'Three interface languages: Arabic, English and Urdu',
        'Works on phone, tablet and computer',
      ],
    },
    walletDebtTitle: 'What do we mean by "subscriptions" and "deferred payment"?',
    walletDebtDesc: "These terms describe two real features inside Ragwa itself, used by laundry shop owners with their own customers — not a subscription fee Ragwa charges the shop owner. A wallet balance lets your customer prepay and spend it over time, and deferred payment lets your customer take the service today and settle up later — with Ragwa tracking both balances precisely and blocking calculation errors.",
    walletDebtLinkText: 'Read the full guide: Managing customer wallets & deferred payments',

    featureMock: {
      invoiceLine1: 'E-invoice', invoiceLine2: 'Sent to the customer over WhatsApp',
      pieceLabels: ['Thobe — Ready', 'Shemagh — Washing', 'Bedsheet — Ironing'],
      statLabel: "Today's Shift Close-out", statValue: '2,450 SAR',
      driverLabel: 'Driver Ahmed — 5 orders',
    },

    faqTitle: 'Frequently Asked Questions',
    faq: [
      { q: 'Does Ragwa need special hardware or a server?', a: 'No — it runs in any browser on a computer, phone, or tablet, with no installation or special server needed.' },
      { q: 'Does it support e-invoicing?', a: "Yes, Ragwa is built around Saudi e-invoicing compliance requirements." },
      { q: 'Can I manage more than one branch?', a: "Yes. You can add as many branches as you need inside one account: each branch has its own sales, invoices, expenses and discounts, and its own login for its staff, while customers and products stay shared and the owner gets reports across all branches. Each extra branch is 200 SAR per year (pro-rated to the time left on your subscription and renewed with it) and is added once payment is confirmed." },
      { q: 'Do I need to change how I work completely to get started?', a: "No — Ragwa is simple and direct. You can start selling the same day, without a complete overhaul of how you work." },
      { q: 'How do I start the free trial?', a: 'Click "Start the free trial", register your shop, and start selling right away for 14 days with every feature.' },
    ],

    finalCtaTitle: 'Get your work organized… and your shop at ease.',
    finalCtaDesc: 'Try Ragwa and see for yourself how running a laundry shop turns from notebooks, math, and stress… into a clear system you carry in your phone.',
    finalCtaSupport: "No complexity. No servers. And no need to change how you work overnight.",

    footerCta: 'Ready to organize your shop?',
    footerRights: 'All Rights Reserved',
    contactModalTitle: 'Contact Sales',
    contactSentMsg: 'Your request has been sent — our sales team will reach out to you soon.',
    contactName: 'Name', contactMobile: 'Mobile Number', contactEmail: 'Email',
    contactType: 'Inquiry Type', contactMessage: 'Message', contactSend: 'Send',
    contactTypes: ['Buy the system', 'Technical question', 'Special offer'],
  },
};
