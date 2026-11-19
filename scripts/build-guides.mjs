// يبني صفحات HTML ثابتة (بدون React/جافاسكربت) تحت public/guides/ من
// content/guides.mjs — يشتغل تلقائيًا كخطوة "prebuild" قبل "vite build"
// (راجع package.json). صفر تبعيات npm جديدة: fs/path القياسية فقط.
//
// السبب: أغلب زواحف الذكاء الاصطناعي (GPTBot, ClaudeBot, PerplexityBot,
// CCBot) لا تُشغّل جافاسكربت، فأي محتوى نبيه يظهر بإجاباتها لازم يوصل
// كاملاً بأول استجابة HTML خام — بعكس بقية هذا التطبيق (SPA تُرندر
// بالكامل عبر React). راجع قسم 19 بـPROJECT_REFERENCE.md للتفاصيل الكاملة.

import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { guides, SITE_URL } from '../content/guides.mjs';
import { LANDING_TEXT } from '../content/landing.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'public', 'guides');
const PRICING_DIR = path.join(__dirname, '..', 'public', 'pricing');
const WHATSAPP_URL = 'https://wa.me/966592299405';

// تعقيم نصوص وقت التوليد (دفاع إضافي حتى لو تلوثت content/guides.mjs
// مستقبلاً — كل بيانات المقالات نصوص عادية أصلاً، بدون HTML خام).
function esc(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const SHARED_STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: #f6faf9; color: #0b2331;
    font-family: 'Cairo', 'Segoe UI', Tahoma, sans-serif;
    line-height: 1.85;
  }
  a { color: inherit; }
  header.site-header {
    background: #ffffff; border-bottom: 1px solid #e6eaed;
  }
  .site-header .inner {
    max-width: 880px; margin: 0 auto; padding: 18px 24px;
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
  }
  .brand { display: flex; align-items: center; gap: 10px; text-decoration: none; }
  .brand img { width: 32px; height: 32px; border-radius: 8px; }
  .brand span { font-weight: 800; color: #0b2331; font-size: 1.05rem; }
  .cta-btn {
    display: inline-block; padding: 9px 20px; border-radius: 10px;
    background: linear-gradient(to left, #f0611f, #ff9d5c);
    color: #ffffff !important; font-weight: 700; text-decoration: none; font-size: .92rem;
  }
  main { max-width: 780px; margin: 0 auto; padding: 40px 24px 64px; }
  .breadcrumb { font-size: .85rem; color: #5b7381; margin-bottom: 18px; }
  .breadcrumb a { text-decoration: none; color: #5b7381; }
  .breadcrumb a:hover { color: #0b2331; }
  h1.article-title { font-size: 1.9rem; font-weight: 800; color: #0b2331; margin: 0 0 10px; line-height: 1.5; }
  .meta { color: #5b7381; font-size: .85rem; margin-bottom: 32px; }
  section.block { margin-bottom: 30px; }
  h2 { font-size: 1.25rem; font-weight: 800; color: #0b2331; margin: 0 0 12px; }
  p { margin: 0 0 14px; color: #253744; font-size: 1rem; }
  ul.points { margin: 0 0 14px; padding-inline-start: 22px; color: #253744; }
  ul.points li { margin-bottom: 8px; }
  .guide-card {
    display: block; text-decoration: none; background: #ffffff; border: 1px solid #e6eaed;
    border-radius: 16px; padding: 22px; margin-bottom: 16px; transition: box-shadow .15s;
  }
  .guide-card:hover { box-shadow: 0 12px 24px -8px rgba(11,35,49,.12); }
  .guide-card h2 { margin: 0 0 8px; font-size: 1.1rem; }
  .guide-card p { margin: 0; color: #5b7381; font-size: .92rem; }
  .related { margin-top: 44px; }
  .related h2 { margin-bottom: 16px; }
  .end-cta {
    margin-top: 36px; padding: 24px; border-radius: 16px; background: #ffffff;
    border: 1px solid #e6eaed; text-align: center;
  }
  .end-cta p { margin: 0 0 14px; font-weight: 700; color: #0b2331; }
  .index-hero { margin-bottom: 32px; }
  .index-hero h1 { font-size: 1.7rem; font-weight: 800; margin: 0 0 10px; }
  .index-hero p { color: #5b7381; margin: 0; }
  .plans { display: grid; gap: 16px; margin: 24px 0 32px; }
  .plan { background: #ffffff; border: 1px solid #e6eaed; border-radius: 16px; padding: 22px; }
  .plan.featured { border: 2px solid #f0611f; }
  .plan h2 { margin: 0 0 4px; }
  .plan .tag { color: #5b7381; font-size: .9rem; margin: 0 0 12px; }
  .plan .price { font-size: 2rem; font-weight: 800; margin: 0; line-height: 1.4; }
  .plan .was { margin: 0 0 2px; color: #5b7381; font-size: 1.1rem; font-weight: 700; }
  .plan .badge { display: inline-block; margin-inline-start: 8px; padding: 2px 10px; border-radius: 999px; background: #d7f5e3; color: #11643a; font-size: .8rem; font-weight: 800; }
  .plan .price span { font-size: 1rem; font-weight: 600; color: #5b7381; }
  .plan .note { color: #5b7381; font-size: .85rem; margin: 0 0 14px; }
  footer.site-footer { background: #0d172a; color: #b8c2d0; margin-top: 40px; }
  footer.site-footer .inner { max-width: 780px; margin: 0 auto; padding: 36px 24px; text-align: center; }
  footer.site-footer a { color: #b8c2d0; text-decoration: none; font-size: .85rem; margin: 0 10px; }
  footer.site-footer a:hover { color: #ffffff; }
  footer.site-footer .rights { color: #7b8ca0; font-size: .75rem; margin-top: 14px; }
`;

function pageShell({ title, description, canonicalPath, jsonLd, bodyHtml, ogType = 'article' }) {
  const canonicalUrl = `${SITE_URL}${canonicalPath}`;
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}" />
<link rel="canonical" href="${esc(canonicalUrl)}" />
<meta property="og:type" content="${ogType}" />
<meta property="og:site_name" content="رغوة" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(description)}" />
<meta property="og:url" content="${esc(canonicalUrl)}" />
<meta property="og:image" content="${esc(SITE_URL)}/og-image.png" />
<meta property="og:locale" content="ar_SA" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;500;600;700;800;900&display=swap" rel="stylesheet" />
<link rel="icon" type="image/png" href="/favicon.png" />
<script type="application/ld+json">${JSON.stringify(jsonLd).replaceAll('<', '\\u003c')}</script>
<style>${SHARED_STYLE}</style>
</head>
<body>
<header class="site-header">
  <div class="inner">
    <a class="brand" href="/">
      <img src="/favicon.png" alt="رغوة" />
      <span>رغوة</span>
    </a>
    <a class="cta-btn" href="/signup">جرّب رغوة مجاناً</a>
  </div>
</header>
<main>
${bodyHtml}
</main>
<footer class="site-footer">
  <div class="inner">
    <div>
      <a href="/">الرئيسية</a>
      <a href="/pricing">الأسعار</a>
      <a href="/guides">كل الأدلة</a>
      <a href="/terms">الشروط والأحكام</a>
      <a href="/privacy">سياسة الخصوصية</a>
    </div>
    <p class="rights">© ${new Date().getFullYear()} رغوة | جميع الحقوق محفوظة</p>
  </div>
</footer>
</body>
</html>
`;
}

// Up to 3 other guides, taken in list order after the current one (wrapping
// around), so every article links to others and every article gets linked to.
function relatedGuides(guide) {
  const i = guides.findIndex((g) => g.slug === guide.slug);
  const others = [...guides.slice(i + 1), ...guides.slice(0, i)];
  return others.slice(0, 3);
}

function renderArticleBody(guide) {
  const sections = guide.sections
    .map((s) => {
      const paras = s.paragraphs.map((p) => `<p>${esc(p)}</p>`).join('\n');
      const list = s.list
        ? `<ul class="points">${s.list.map((li) => `<li>${esc(li)}</li>`).join('')}</ul>`
        : '';
      return `<section class="block"><h2>${esc(s.heading)}</h2>${paras}${list}</section>`;
    })
    .join('\n');

  return `<div class="breadcrumb"><a href="/guides">كل الأدلة</a> ← ${esc(guide.title)}</div>
<h1 class="article-title">${esc(guide.title)}</h1>
<p class="meta">تاريخ النشر: ${esc(guide.datePublished)}</p>
${sections}
<section class="related">
  <h2>اقرأ أيضًا</h2>
${relatedGuides(guide)
  .map(
    (g) => `  <a class="guide-card" href="/guides/${esc(g.slug)}">
    <h2>${esc(g.title)}</h2>
    <p>${esc(g.description)}</p>
  </a>`
  )
  .join('\n')}
</section>
<div class="end-cta">
  <p>جاهز تجرّب رغوة في مغسلتك؟</p>
  <a class="cta-btn" href="/signup">جرّب رغوة مجاناً</a>
</div>`;
}

function breadcrumbJsonLd(guide) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'رغوة', item: `${SITE_URL}/` },
      { '@type': 'ListItem', position: 2, name: 'أدلة رغوة', item: `${SITE_URL}/guides` },
      { '@type': 'ListItem', position: 3, name: guide.title, item: `${SITE_URL}/guides/${guide.slug}` },
    ],
  };
}

function articleJsonLd(guide) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: guide.title,
    description: guide.description,
    datePublished: guide.datePublished,
    inLanguage: 'ar',
    author: { '@type': 'Organization', name: 'رغوة', url: SITE_URL },
    publisher: {
      '@type': 'Organization',
      name: 'رغوة',
      logo: { '@type': 'ImageObject', url: `${SITE_URL}/favicon.png` },
    },
    mainEntityOfPage: { '@type': 'WebPage', '@id': `${SITE_URL}/guides/${guide.slug}` },
  };
}

function renderIndexBody(guides) {
  const cards = guides
    .map(
      (g) => `<a class="guide-card" href="/guides/${esc(g.slug)}">
  <h2>${esc(g.title)}</h2>
  <p>${esc(g.description)}</p>
</a>`
    )
    .join('\n');

  return `<div class="index-hero">
  <h1>أدلة رغوة لمغاسل الملابس</h1>
  <p>مقالات عملية عن إدارة مغاسل الملابس، الفوترة الإلكترونية، وتنظيم الطلبات والعملاء.</p>
</div>
${cards}`;
}

function indexJsonLd(guides) {
  return {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: 'أدلة رغوة لمغاسل الملابس',
    url: `${SITE_URL}/guides`,
    hasPart: guides.map((g) => ({
      '@type': 'Article',
      headline: g.title,
      url: `${SITE_URL}/guides/${g.slug}`,
    })),
  };
}

// صفحة /pricing: الأسعار والباقات والمميزات تُقرأ من content/landing.mjs (نفس
// مصدر قسم الأسعار في الرئيسية) فلا يحصل اختلاف بين الصفحتين.
const PRICING = LANDING_TEXT.ar.pricing;
const PRICING_TITLE = 'سعر برنامج مغسلة ملابس: أسعار رغوة';
const PRICING_DESC = `سعر برنامج رغوة لمغاسل الملابس ${PRICING.annual.price} ريال في السنة بدل ${PRICING.annual.originalPrice} (${PRICING.annual.discountBadge}) شامل ضريبة القيمة المضافة، مع تجربة مجانية 14 يومًا بكل المميزات وبدون بطاقة بنكية.`;

function pricingFaq() {
  const branchItem = LANDING_TEXT.ar.faq.find((f) => f.q.includes('أكثر من فرع'));
  if (!branchItem) throw new Error('[build-guides] branch FAQ not found in content/landing.mjs');
  return [
    {
      q: 'كم سعر برنامج رغوة؟',
      a: `${PRICING.annual.price} ريال في السنة بدل ${PRICING.annual.originalPrice} (${PRICING.annual.discountBadge})، ${PRICING.annual.note}. وقبلها تجربة مجانية ${PRICING.trial.unit} بكل المميزات وبدون بطاقة بنكية.`,
    },
    {
      q: 'هل المميزات تختلف بين التجربة والباقة السنوية؟',
      a: 'لا. التجربة المجانية والباقة السنوية تشملان كل مميزات النظام بدون استثناء.',
    },
    branchItem,
    {
      q: 'كيف أدفع؟',
      a: PRICING.annual.bullets[2],
    },
  ];
}

function renderPricingBody() {
  const card = (plan, { featured = false, href, cta, external = false }) => `<div class="plan${featured ? ' featured' : ''}">
  <h2>${esc(plan.name)}</h2>
  <p class="tag">${esc(plan.tagline)}</p>
  ${plan.originalPrice ? `<p class="was"><s>${esc(plan.originalPrice)}</s><span class="badge">${esc(plan.discountBadge)}</span></p>\n  ` : ''}<p class="price">${esc(plan.price)}${plan.unit ? ` <span>${esc(plan.unit)}</span>` : ''}</p>
  <p class="note">${esc(plan.note)}</p>
  <ul class="points">${plan.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>
  <a class="cta-btn" href="${esc(href)}"${external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${esc(cta)}</a>
</div>`;

  const faq = pricingFaq()
    .map((f) => `<section class="block"><h2>${esc(f.q)}</h2><p>${esc(f.a)}</p></section>`)
    .join('\n');

  return `<div class="breadcrumb"><a href="/">رغوة</a> ← الأسعار</div>
<h1 class="article-title">${esc(PRICING_TITLE)}</h1>
<p>${esc(PRICING.annual.name)} في رغوة بـ <strong>${esc(PRICING.annual.price)} ${esc(PRICING.annual.unit)}</strong> بدل <s>${esc(PRICING.annual.originalPrice)}</s> (${esc(PRICING.annual.discountBadge)}، ${esc(PRICING.annual.note)})، وتشمل كل مميزات النظام. تقدر تجرّب أولًا ${esc(PRICING.trial.unit)} مجانًا بدون بطاقة بنكية.</p>
<div class="plans">
${card(PRICING.trial, { href: '/signup', cta: PRICING.trial.cta })}
${card(PRICING.annual, { featured: true, href: '/signup?plan=annual', cta: PRICING.annual.cta })}
${card(PRICING.enterprise, { href: WHATSAPP_URL, cta: PRICING.enterprise.cta, external: true })}
</div>
<section class="block">
  <h2>${esc(PRICING.includesTitle)}</h2>
  <ul class="points">${PRICING.features.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
</section>
${faq}
<div class="end-cta">
  <p>جاهز تجرّب رغوة في مغسلتك؟</p>
  <a class="cta-btn" href="/signup">${esc(PRICING.trial.cta)}</a>
</div>`;
}

function pricingJsonLd() {
  return [
    {
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: 'رغوة',
      applicationCategory: 'BusinessApplication',
      operatingSystem: 'Web',
      inLanguage: 'ar',
      url: `${SITE_URL}/pricing`,
      offers: {
        '@type': 'Offer',
        price: PRICING.annual.price,
        priceCurrency: 'SAR',
        url: `${SITE_URL}/pricing`,
      },
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'رغوة', item: `${SITE_URL}/` },
        { '@type': 'ListItem', position: 2, name: 'الأسعار', item: `${SITE_URL}/pricing` },
      ],
    },
  ];
}

function main() {
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  for (const guide of guides) {
    const html = pageShell({
      title: `${guide.title} | رغوة`,
      description: guide.description,
      canonicalPath: `/guides/${guide.slug}`,
      jsonLd: [articleJsonLd(guide), breadcrumbJsonLd(guide)],
      bodyHtml: renderArticleBody(guide),
    });
    writeFileSync(path.join(OUT_DIR, `${guide.slug}.html`), html, 'utf8');
  }

  const indexHtml = pageShell({
    title: 'أدلة رغوة لمغاسل الملابس',
    description: 'مقالات عملية عن إدارة مغاسل الملابس، الفوترة الإلكترونية، وتنظيم الطلبات والعملاء — من فريق رغوة.',
    canonicalPath: '/guides',
    jsonLd: indexJsonLd(guides),
    bodyHtml: renderIndexBody(guides),
  });
  writeFileSync(path.join(OUT_DIR, 'index.html'), indexHtml, 'utf8');

  if (existsSync(PRICING_DIR)) rmSync(PRICING_DIR, { recursive: true, force: true });
  mkdirSync(PRICING_DIR, { recursive: true });
  writeFileSync(
    path.join(PRICING_DIR, 'index.html'),
    pageShell({
      title: `${PRICING_TITLE} | رغوة`,
      description: PRICING_DESC,
      canonicalPath: '/pricing',
      jsonLd: pricingJsonLd(),
      bodyHtml: renderPricingBody(),
      ogType: 'website',
    }),
    'utf8'
  );

  console.log(`[build-guides] generated ${guides.length} guide pages + index into public/guides/ and public/pricing/`);
}

main();
