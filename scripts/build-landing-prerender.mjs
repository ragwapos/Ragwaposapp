// يولّد HTML خام حقيقي وقت الـpostbuild لصفحة الهبوط العامة (/ و/en) —
// بديل عن اعتمادها بالكامل على React لعرض أي محتوى (كانت تصل فارغة تمامًا
// لأي زاحف لا يُشغّل جافاسكربت: GPTBot, ClaudeBot, PerplexityBot, Bing،
// Yandex). المحتوى داخل #root هو ناتج renderToString لنفس مكوّن React
// الحقيقي (src/landing/LandingPage.jsx) — يعني الزائر يشوف التصميم الفعلي
// أول ما يوصل HTML + CSS، بدون انتظار حزمة الجافاسكربت، والزواحف تقرأ نفس
// النص. هذا السكربت "postbuild" مو "prebuild" — لازم يشتغل بعد "vite build"
// لأنه يحتاج مخرجاتها الفعلية (dist/index.html بأسماء الأصول المُلغّمة
// بالهاش) عشان يبني dist/en/index.html بنفس حزمة التطبيق التفاعلي الكامل.
//
// src/main.jsx يستخدم ReactDOM.createRoot(...).render(...) — مو
// hydrateRoot — فما فيه أي خطر "hydration mismatch": بعد ما يشتغل JS،
// React يستبدل محتوى #root بشجرة مطابقة، فالزائر ما يلاحظ أي تغيير.
//
// المحتوى النصي مصدره الوحيد content/landing.mjs (نفس المصدر اللي يستهلكه
// LandingPage وقت الرندر الفعلي) — صفر تكرار محتوى بين المسارين.

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { LANDING_TEXT, SITE_URL } from '../content/landing.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const SSR_TMP_DIR = path.join(ROOT_DIR, '.prerender-tmp');
const AR_FILE = path.join(DIST_DIR, 'index.html');
const EN_DIR = path.join(DIST_DIR, 'en');
const EN_FILE = path.join(EN_DIR, 'index.html');
// الهيكل اللي يخدم كل مسارات التطبيق غير الصفحة الرئيسية (/login، /signup،
// مسارات لوحة التحكم...) عبر الـrewrite العام بـvercel.json وهيكل الـ404
// بـmiddleware.js: فيه نموذج الدخول وهيكل اللوحة جاهزين، بدون تصميم الرئيسية.
const APP_FILE = path.join(DIST_DIR, 'app.html');

function esc(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// أي استبدال هنا يعتمد على شكل مخرجات vite build (بعكس build-guides.mjs
// اللي يملك 100% من مخرجاته). لو تغيّر index.html مستقبلاً بشكل يكسر أحد
// هذي الافتراضات، لازم الـbuild يفشل بصوت عالٍ بدل ما ينشر HTML مكسور
// بصمت.
function mustReplace(html, needle, replacement, label) {
  if (!html.includes(needle)) {
    throw new Error(`[build-landing-prerender] لم أجد "${label}" بـdist/index.html — تأكد إن index.html بجذر المشروع ما تغيّر شكله. تم إيقاف الـbuild.`);
  }
  return html.replace(needle, replacement);
}

// يبني src/landing/prerender-entry.jsx بـ"vite build --ssr" لمجلد مؤقت ويرجّع
// دالة render(lang) — نفس مكوّن LandingPage الحقيقي اللي يستخدمه التطبيق،
// فالـHTML الناتج هو التصميم الفعلي (كلاسات Tailwind نفسها)، مو نسخة نصية.
// المتصفح يرسمه أول ما يوصل HTML + CSS بدون انتظار حزمة JS، والزواحف
// تقرأ نفس المحتوى. المجلد المؤقت ينحذف دايمًا حتى لو فشل الرندر.
async function loadLandingRenderer() {
  const { build } = await import('vite');
  await build({
    root: ROOT_DIR,
    logLevel: 'warn',
    build: { ssr: 'src/landing/prerender-entry.jsx', outDir: SSR_TMP_DIR, emptyOutDir: true },
  });
  const mod = await import(pathToFileURL(path.join(SSR_TMP_DIR, 'prerender-entry.js')).href);
  return { render: mod.render, renderLogin: mod.renderLogin, renderSkeleton: mod.renderSkeleton };
}

// كل "عرض" جاهز داخل #root له data-boot-view، وpublic/boot.js يختار اللي
// يظهر قبل أول رسم (القواعد بـsrc/index.css). الافتراضي بدون جافاسكربت:
// الرئيسية ظاهرة والباقي مخفي — نفس اللي تقرأه الزواحف.
function bootView(name, html) {
  return `<div data-boot-view="${name}">${html}</div>`;
}

// وسم boot.js + اسم ملف لوحة المحل (بالهاش) عشان boot.js يبدأ تنزيله
// بالتوازي مع الحزمة الأساسية للعميل اللي عنده جلسة محفوظة. ينحط بأول
// الـhead، قبل رابط الـCSS، عشان ما ينتظر تنزيله.
function bootHead() {
  const chunks = readdirSync(path.join(DIST_DIR, 'assets')).filter((f) => /^TenantApp-[\w-]+\.js$/.test(f));
  if (chunks.length !== 1) {
    throw new Error(`[build-landing-prerender] توقعت ملف TenantApp واحد بـdist/assets ولقيت ${chunks.length} — تم إيقاف الـbuild.`);
  }
  return `<meta name="ragwa-tenant-chunk" content="/assets/${chunks[0]}" />\n    <script src="/boot.js"></script>`;
}
const BOOT_ANCHOR = '<meta name="theme-color" content="#020617" />';
const BLANK_VIEW = '<div class="min-h-screen bg-gradient-to-br from-slate-950 via-blue-950 to-slate-950"></div>';

// FAQPage هي النوع البنيوي الصحيح لعدة أسئلة بصفحة وحدة (بعكس QAPage،
// المخصصة لسؤال واحد بعدة إجابات بنمط منتدى/مجتمع) — حتى لو فقدت FAQPage
// أهليتها لنتائج جوجل الغنية (مايو 2026)، الصحة البنيوية للـschema نفسها
// هي الهدف هنا، مو الأهلية لنتائج غنية. قرار سابق كان يغلّف الأسئلة بـ
// @graph من عقد Question مستقلة بدل هذا الغلاف — صُحح لأن ذلك لا يمثل
// النوع الصحيح لهذا الشكل (عدة أسئلة تسويقية بصفحة وحدة).
function faqJsonLd(lang) {
  const t = LANDING_TEXT[lang];
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: t.faq.map((item) => ({
      '@type': 'Question',
      name: item.q,
      acceptedAnswer: { '@type': 'Answer', text: item.a },
    })),
  };
}

function hreflangTags() {
  return `<link rel="alternate" hreflang="ar" href="${SITE_URL}/" />
<link rel="alternate" hreflang="en" href="${SITE_URL}/en" />
<link rel="alternate" hreflang="x-default" href="${SITE_URL}/" />`;
}

// نصوص head بالعربي — يجب أن تطابق حرفيًا ما هو موجود بـindex.html
// بجذر المشروع (تحقق مباشر قبل الكتابة).
const AR_TITLE = 'رغوة | برنامج كاشير ونظام نقطة بيع لمغاسل الملابس في السعودية';
const AR_DESC = 'رغوة برنامج سحابي لأصحاب مغاسل الملابس: نقطة بيع سريعة، تتبع كل قطعة، فواتير برمز QR، واتساب للعميل، ومناديب التوصيل. جرّب مجاناً 14 يوم بدون بطاقة.';

// نصوص head بالإنجليزي — مطابقة حرفيًا (نفس الحروف بالضبط) لما يُرجعه
// getPageMeta() بـsrc/App.jsx لـ page === 'landing' && siteLang === 'en' —
// عمداً نفس النص الوحيد لكل من meta description/og:description/
// twitter:description (بعكس العربي اللي فيه نسختان مختلفتان أصلاً بمصدر
// index.html) عشان ما يصير أي تضارب بين اللقطة الثابتة والقيمة اللي
// يحقنها useEffect بعد تشغيل الجافاسكربت.
const EN_TITLE = 'Ragwa | Laundry Shop POS System';
const EN_DESC = 'Ragwa keeps your laundry shop organized from intake to delivery. A fast checkout, per-item tracking, e-invoices, and drivers you can always see — all in one cloud system built for Saudi laundry shops.';

async function main() {
  if (!existsSync(AR_FILE)) {
    throw new Error(`[build-landing-prerender] dist/index.html غير موجود — لازم "vite build" يشتغل قبل هذا السكربت (postbuild).`);
  }
  const built = readFileSync(AR_FILE, 'utf8');
  const pristine = mustReplace(built, BOOT_ANCHOR, `${BOOT_ANCHOR}\n    ${bootHead()}`, 'meta theme-color');
  let render, renderLogin, renderSkeleton;
  try {
    ({ render, renderLogin, renderSkeleton } = await loadLandingRenderer());
  } finally {
    rmSync(SSR_TMP_DIR, { recursive: true, force: true });
  }
  const skeletonView = bootView('skeleton', renderSkeleton());

  // ===== هيكل التطبيق (dist/app.html) =====
  const appHtml = mustReplace(pristine, '<div id="root"></div>',
    `<div id="root">${bootView('login-ar', renderLogin('ar'))}${bootView('login-en', renderLogin('en'))}${bootView('blank', BLANK_VIEW)}${skeletonView}</div>`, 'div#root الفارغ (app)');
  writeFileSync(APP_FILE, appHtml, 'utf8');

  // ===== النسخة العربية (تُكتب فوق dist/index.html) =====
  let arHtml = pristine;
  arHtml = mustReplace(arHtml, '<div id="root"></div>', `<div id="root">${bootView('landing', render('ar'))}${skeletonView}</div>`, 'div#root الفارغ');
  arHtml = mustReplace(arHtml, '</head>', `${hreflangTags()}\n<script type="application/ld+json">${JSON.stringify(faqJsonLd('ar'))}</script>\n</head>`, 'وسم إغلاق head');
  writeFileSync(AR_FILE, arHtml, 'utf8');

  // ===== النسخة الإنجليزية (نسخة مستقلة من نفس الأصل الخام، مو فوق
  // النسخة العربية المعدَّلة أعلاه — يمنع تراكم تعديلات فوق بعض) =====
  let enHtml = pristine;
  enHtml = mustReplace(enHtml, '<html lang="ar" dir="rtl">', '<html lang="en" dir="ltr">', 'وسم html lang/dir');
  enHtml = mustReplace(enHtml, `<title>${AR_TITLE}</title>`, `<title>${esc(EN_TITLE)}</title>`, 'title');
  enHtml = mustReplace(enHtml, `<meta name="description" content="${AR_DESC}" />`, `<meta name="description" content="${esc(EN_DESC)}" />`, 'meta description');
  enHtml = mustReplace(enHtml, `<meta property="og:title" content="${AR_TITLE}" />`, `<meta property="og:title" content="${esc(EN_TITLE)}" />`, 'og:title');
  enHtml = mustReplace(enHtml, `<meta property="og:description" content="${AR_DESC}" />`, `<meta property="og:description" content="${esc(EN_DESC)}" />`, 'og:description');
  // canonical/og:url: استبدال بمرساة الوسم الكامل (href="..."/content="...")
  // وليس الرابط كنص عارٍ — og:image يبدأ بنفس بادئة الرابط ويتأذى من أي
  // استبدال ساذج على الرابط المجرد.
  enHtml = mustReplace(enHtml, `<link rel="canonical" href="${SITE_URL}/" />`, `<link rel="canonical" href="${SITE_URL}/en" />`, 'canonical link');
  enHtml = mustReplace(enHtml, `<meta property="og:url" content="${SITE_URL}/" />`, `<meta property="og:url" content="${SITE_URL}/en" />`, 'og:url');
  enHtml = mustReplace(enHtml, '<meta property="og:locale" content="ar_SA" />', '<meta property="og:locale" content="en_US" />', 'og:locale');
  enHtml = mustReplace(enHtml, '<meta property="og:locale:alternate" content="en_US" />', '<meta property="og:locale:alternate" content="ar_SA" />', 'og:locale:alternate');
  enHtml = mustReplace(enHtml, `<meta name="twitter:title" content="${AR_TITLE}" />`, `<meta name="twitter:title" content="${esc(EN_TITLE)}" />`, 'twitter:title');
  enHtml = mustReplace(enHtml, `<meta name="twitter:description" content="${AR_DESC}" />`, `<meta name="twitter:description" content="${esc(EN_DESC)}" />`, 'twitter:description');
  // الـh1 بالنسخة الإنجليزية نص لاتيني — يحتاج subset لاتيني، مو العربي
  // المفترض افتراضيًا بـindex.html الأصلي (انظر التعليق فوق وسم الـpreload
  // هناك).
  enHtml = mustReplace(enHtml, '<link rel="preload" as="font" type="font/woff2" href="/fonts/cairo-arabic.woff2" crossorigin />', '<link rel="preload" as="font" type="font/woff2" href="/fonts/cairo-latin.woff2" crossorigin />', 'preload link (font subset, en)');
  enHtml = mustReplace(enHtml, '<div id="root"></div>', `<div id="root">${bootView('landing', render('en'))}${skeletonView}</div>`, 'div#root الفارغ (en)');
  enHtml = mustReplace(enHtml, '</head>', `${hreflangTags()}\n<script type="application/ld+json">${JSON.stringify(faqJsonLd('en'))}</script>\n</head>`, 'وسم إغلاق head (en)');

  mkdirSync(EN_DIR, { recursive: true });
  writeFileSync(EN_FILE, enHtml, 'utf8');

  console.log('[build-landing-prerender] حقنت HTML التصميم الحقيقي (renderToString) + hreflang + FAQ JSON-LD بـ dist/index.html و dist/en/index.html، وبنيت dist/app.html (نموذج الدخول + هيكل اللوحة)');
}

await main();
