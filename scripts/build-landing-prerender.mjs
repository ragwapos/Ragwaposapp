// يولّد HTML خام حقيقي وقت الـpostbuild لصفحة الهبوط العامة (/ و/en) —
// بديل عن اعتمادها بالكامل على React لعرض أي محتوى (كانت تصل فارغة تمامًا
// لأي زاحف لا يُشغّل جافاسكربت: GPTBot, ClaudeBot, PerplexityBot, Bing،
// Yandex). نفس فلسفة scripts/build-guides.mjs بالضبط (HTML يدوي، صفر
// تبعيات npm جديدة)، بفرق جوهري واحد: هذا السكربت "postbuild" مو
// "prebuild" — لازم يشتغل بعد "vite build" لأنه يحتاج مخرجاتها الفعلية
// (dist/index.html بأسماء الأصول المُلغّمة بالهاش) عشان يبني dist/en/
// index.html بنفس حزمة الجافاسكربت الحقيقية للتطبيق التفاعلي الكامل.
//
// src/main.jsx يستخدم ReactDOM.createRoot(...).render(...) — مو
// hydrateRoot — فما فيه أي خطر "hydration mismatch": بعد ما يشتغل JS،
// React يستبدل محتوى #root بالكامل بغض النظر عن اللقطة الثابتة اللي كانت
// فيه قبل كذا. فالمطلوب فقط HTML خام صحيح للحظة ما قبل تشغيل الجافاسكربت.
//
// المحتوى النصي مصدره الوحيد content/landing.mjs (نفس المصدر اللي يستهلكه
// src/App.jsx وقت الرندر الفعلي) — صفر تكرار محتوى بين المسارين.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { LANDING_TEXT, SITE_URL } from '../content/landing.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, '..', 'dist');
const AR_FILE = path.join(DIST_DIR, 'index.html');
const EN_DIR = path.join(DIST_DIR, 'en');
const EN_FILE = path.join(EN_DIR, 'index.html');

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

const INLINE_STYLE = `
  #prerender-snapshot { font-family: 'Cairo','Segoe UI',Tahoma,sans-serif; max-width: 880px; margin: 0 auto; padding: 32px 24px; line-height: 1.85; color: #0b2331; }
  #prerender-snapshot h1 { font-size: 1.9rem; font-weight: 800; margin: 0 0 14px; }
  #prerender-snapshot h2 { font-size: 1.4rem; font-weight: 800; margin: 40px 0 14px; }
  #prerender-snapshot h3 { font-size: 1.05rem; font-weight: 700; margin: 20px 0 6px; }
  #prerender-snapshot p { margin: 0 0 10px; color: #253744; }
  #prerender-snapshot a { color: #0f766e; font-weight: 600; }
  #prerender-snapshot nav a, #prerender-snapshot footer a { display: inline-block; margin-inline-end: 14px; color: inherit; text-decoration: none; }
  #prerender-snapshot ol { padding-inline-start: 22px; }
  #prerender-snapshot details { margin-bottom: 10px; }
  #prerender-snapshot summary { font-weight: 700; cursor: pointer; }
`;

function renderSnapshotBody(lang) {
  const t = LANDING_TEXT[lang];
  const dir = lang === 'ar' ? 'rtl' : 'ltr';

  const problems = t.problems.map((p) => `
    <article>
      <h3>${esc(p.q)}</h3>
      <p>${esc(p.pain)}</p>
      <p>${esc(p.solution)}</p>
      <p><strong>${esc(p.highlight)}</strong></p>
    </article>`).join('\n');

  const features = t.features.map((f) => `
    <article>
      <h3>${esc(f.title)}</h3>
      <p>${esc(f.desc)}</p>
      <p><strong>${esc(f.highlight)}</strong></p>
    </article>`).join('\n');

  const howSteps = t.howSteps.map((s) => `<li><strong>${esc(s.title)}</strong> — ${esc(s.desc)}</li>`).join('\n');

  const faq = t.faq.map((item) => `
    <details>
      <summary>${esc(item.q)}</summary>
      <p>${esc(item.a)}</p>
    </details>`).join('\n');

  return `<div id="prerender-snapshot" dir="${dir}" lang="${lang}">
  <style>${INLINE_STYLE}</style>
  <nav>
    <a href="/">العربي</a>
    <a href="/en">English</a>
    <a href="/login">${esc(t.navLogin)}</a>
    <a href="/signup">${esc(t.ctaStart)}</a>
    <a href="/guides">${esc(t.navGuides)}</a>
  </nav>

  <h1>${esc(t.heroTitlePlain)}${esc(t.heroTitleAccent)}</h1>
  <p>${esc(t.heroDesc)}</p>
  <p>${esc(t.heroSupport)}</p>

  <h2>${esc(t.problemsTitle)}</h2>
  <p>${esc(t.problemsSubtitle)}</p>
  ${problems}

  <h2>${esc(t.featuresTitle)}</h2>
  ${features}

  <h2>${esc(t.howTitle)}</h2>
  <ol>
    ${howSteps}
  </ol>

  <h2>${esc(t.pricingTitle)}</h2>
  <p>${esc(t.pricingDesc)}</p>

  <h2>${esc(t.walletDebtTitle)}</h2>
  <p>${esc(t.walletDebtDesc)}</p>
  <p><a href="/guides/wallet-debt-management-laundry-customers">${esc(t.walletDebtLinkText)}</a></p>

  <h2>${esc(t.faqTitle)}</h2>
  ${faq}

  <footer>
    <a href="/login">${esc(t.navLogin)}</a>
    <a href="/signup">${esc(t.ctaStart)}</a>
    <a href="/guides">${esc(t.navGuides)}</a>
    <a href="/terms">${lang === 'ar' ? 'الشروط والأحكام' : 'Terms & Conditions'}</a>
    <a href="/privacy">${lang === 'ar' ? 'سياسة الخصوصية' : 'Privacy Policy'}</a>
    <p>© ${new Date().getFullYear()} ${esc(t.brand)} — ${esc(t.footerRights)}</p>
  </footer>
</div>`;
}

// كل سؤال كعقدة Question مستقلة داخل @graph، بدون غلاف FAQPage/QAPage —
// قرار متعمد: FAQPage فقدت أهليتها لنتائج جوجل الغنية (مايو 2026)، وQAPage
// بمواصفات schema.org مخصصة لسؤال واحد فقط بالصفحة (نمط منتدى)، فتغليف 5
// أسئلة تسويقية بداخلها سوء استخدام آخر لنفس المواصفة. عقد Question مستقلة
// بيانات صحيحة وواضحة لمحركات الذكاء الاصطناعي بدون تجاوز أي نوع مواصفة.
function faqJsonLd(lang) {
  const t = LANDING_TEXT[lang];
  return {
    '@context': 'https://schema.org',
    '@graph': t.faq.map((item) => ({
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
const AR_TITLE = 'رغوة | نظام نقطة بيع لمغاسل الملابس';
const AR_DESC_LONG = 'رغوة: نظام نقطة بيع لمغاسل الملابس يجمع البيع، تتبع الطلبات، الاشتراكات، والدفع الآجل في مكان واحد. جرّب رغوة مجاناً.';
const AR_DESC_SHORT = 'رغوة: نظام نقطة بيع لمغاسل الملابس يجمع البيع، تتبع الطلبات، الاشتراكات، والدفع الآجل في مكان واحد.';

// نصوص head بالإنجليزي — مطابقة حرفيًا (نفس الحروف بالضبط) لما يُرجعه
// getPageMeta() بـsrc/App.jsx لـ page === 'landing' && siteLang === 'en' —
// عمداً نفس النص الوحيد لكل من meta description/og:description/
// twitter:description (بعكس العربي اللي فيه نسختان مختلفتان أصلاً بمصدر
// index.html) عشان ما يصير أي تضارب بين اللقطة الثابتة والقيمة اللي
// يحقنها useEffect بعد تشغيل الجافاسكربت.
const EN_TITLE = 'Ragwa | Laundry Shop POS System';
const EN_DESC = 'Ragwa keeps your laundry shop organized from intake to delivery. A fast checkout, per-item tracking, e-invoices, and drivers you can always see — all in one cloud system built for Saudi laundry shops.';

function main() {
  if (!existsSync(AR_FILE)) {
    throw new Error(`[build-landing-prerender] dist/index.html غير موجود — لازم "vite build" يشتغل قبل هذا السكربت (postbuild).`);
  }
  const pristine = readFileSync(AR_FILE, 'utf8');

  // ===== النسخة العربية (تُكتب فوق dist/index.html) =====
  let arHtml = pristine;
  arHtml = mustReplace(arHtml, '<div id="root"></div>', `<div id="root">${renderSnapshotBody('ar')}</div>`, 'div#root الفارغ');
  arHtml = mustReplace(arHtml, '</head>', `${hreflangTags()}\n<script type="application/ld+json">${JSON.stringify(faqJsonLd('ar'))}</script>\n</head>`, 'وسم إغلاق head');
  writeFileSync(AR_FILE, arHtml, 'utf8');

  // ===== النسخة الإنجليزية (نسخة مستقلة من نفس الأصل الخام، مو فوق
  // النسخة العربية المعدَّلة أعلاه — يمنع تراكم تعديلات فوق بعض) =====
  let enHtml = pristine;
  enHtml = mustReplace(enHtml, '<html lang="ar" dir="rtl">', '<html lang="en" dir="ltr">', 'وسم html lang/dir');
  enHtml = mustReplace(enHtml, `<title>${AR_TITLE}</title>`, `<title>${esc(EN_TITLE)}</title>`, 'title');
  enHtml = mustReplace(enHtml, `<meta name="description" content="${AR_DESC_LONG}" />`, `<meta name="description" content="${esc(EN_DESC)}" />`, 'meta description');
  enHtml = mustReplace(enHtml, `<meta property="og:title" content="${AR_TITLE}" />`, `<meta property="og:title" content="${esc(EN_TITLE)}" />`, 'og:title');
  enHtml = mustReplace(enHtml, `<meta property="og:description" content="${AR_DESC_LONG}" />`, `<meta property="og:description" content="${esc(EN_DESC)}" />`, 'og:description');
  // canonical/og:url: استبدال بمرساة الوسم الكامل (href="..."/content="...")
  // وليس الرابط كنص عارٍ — og:image يبدأ بنفس بادئة الرابط ويتأذى من أي
  // استبدال ساذج على الرابط المجرد.
  enHtml = mustReplace(enHtml, `<link rel="canonical" href="${SITE_URL}/" />`, `<link rel="canonical" href="${SITE_URL}/en" />`, 'canonical link');
  enHtml = mustReplace(enHtml, `<meta property="og:url" content="${SITE_URL}/" />`, `<meta property="og:url" content="${SITE_URL}/en" />`, 'og:url');
  enHtml = mustReplace(enHtml, '<meta property="og:locale" content="ar_SA" />', '<meta property="og:locale" content="en_US" />', 'og:locale');
  enHtml = mustReplace(enHtml, '<meta property="og:locale:alternate" content="en_US" />', '<meta property="og:locale:alternate" content="ar_SA" />', 'og:locale:alternate');
  enHtml = mustReplace(enHtml, `<meta name="twitter:title" content="${AR_TITLE}" />`, `<meta name="twitter:title" content="${esc(EN_TITLE)}" />`, 'twitter:title');
  enHtml = mustReplace(enHtml, `<meta name="twitter:description" content="${AR_DESC_SHORT}" />`, `<meta name="twitter:description" content="${esc(EN_DESC)}" />`, 'twitter:description');
  enHtml = mustReplace(enHtml, '<div id="root"></div>', `<div id="root">${renderSnapshotBody('en')}</div>`, 'div#root الفارغ (en)');
  enHtml = mustReplace(enHtml, '</head>', `${hreflangTags()}\n<script type="application/ld+json">${JSON.stringify(faqJsonLd('en'))}</script>\n</head>`, 'وسم إغلاق head (en)');

  mkdirSync(EN_DIR, { recursive: true });
  writeFileSync(EN_FILE, enHtml, 'utf8');

  console.log('[build-landing-prerender] حقنت لقطة HTML ثابتة + hreflang + FAQ JSON-LD بـ dist/index.html و dist/en/index.html');
}

main();
