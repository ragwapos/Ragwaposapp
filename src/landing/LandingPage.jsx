// Public marketing landing page (/ and /en). Lives in its own module so
// scripts/build-landing-prerender.mjs can render it at build time with
// renderToString and ship the real designed markup in index.html, instead
// of waiting for the JS bundle before anything styled appears.
import React, { useState, useRef, useEffect } from "react";
import { Shirt, MessageCircle, Smartphone, Car, QrCode, MapPin } from "lucide-react";
import { LANDING_TEXT } from "../../content/landing.mjs";
import { preloadTurnstile } from "../utils/turnstile.js";

export default function LandingPage(props) {
  const { navigate, showContact, setShowContact,
    contactName, setContactName, contactMobile, setContactMobile, contactEmail, setContactEmail,
    contactType, setContactType, contactMessage, setContactMessage, contactSent, submitContact,
    lang, onOpenTerms, prerender } = props;
  const goLogin = (e) => { e.preventDefault(); navigate('login', '/login'); };
  const goSignup = (e) => { e.preventDefault(); navigate('signup', '/signup'); };
  const goLang = (l) => (e) => { e.preventDefault(); navigate('landing', l === 'en' ? '/en' : '/'); };
  // Anti-bot: `website` is a honeypot a real visitor never sees or fills
  // (hidden below); `formStartedAtRef` marks when the modal actually
  // opened, so the server can reject a submit that arrives faster than any
  // human could type a message. Both go to api/submit-contact untouched.
  const [contactWebsite, setContactWebsite] = useState('');
  const formStartedAtRef = useRef(0);
  useEffect(() => { if (showContact) { formStartedAtRef.current = Date.now(); preloadTurnstile(); } }, [showContact]);
  const [openFaq, setOpenFaq] = useState(null);
  // prerender: set only by src/landing/prerender-entry.jsx at build time —
  // keeps every FAQ answer in the static HTML (hidden) so non-JS crawlers can
  // read them; the live app never passes it, so answers stay collapsed.
  const t = LANDING_TEXT[lang];
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  const scrollTo = (id) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });

  // Labeled miniature product-UI snippets for the feature cards — real
  // Lucide icons + real (translated) labels, not abstract shapes or bare
  // unlabeled numbers, so each reads as a tiny piece of real software.
  const pieceStageColor = { 'جاهز': 'bg-success-500', 'Ready': 'bg-success-500', 'غسيل': 'bg-info-500', 'Washing': 'bg-info-500', 'كوي': 'bg-warning-500', 'Ironing': 'bg-warning-500' };
  const featureVisuals = [
    <div key="wa" className="flex items-center gap-3 bg-brand-50 rounded-xl p-3">
      <div className="w-10 h-10 rounded-full bg-[#25D366] flex items-center justify-center shrink-0">
        <MessageCircle size={18} className="text-white" fill="white" strokeWidth={0} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-semibold text-landing-ink truncate">{t.featureMock.invoiceLine1}</div>
        <div className="text-[11px] text-landing-ink-muted truncate">{t.featureMock.invoiceLine2}</div>
      </div>
      <QrCode size={26} className="text-brand-600 shrink-0" />
    </div>,
    <div key="pieces" className="space-y-1.5">
      {t.featureMock.pieceLabels.map((label, i) => (
        <div key={i} className="flex items-center gap-2 bg-brand-50 rounded-lg px-2.5 py-1.5">
          <Shirt size={14} className="text-brand-600 shrink-0" />
          <span className="text-[11px] text-landing-ink flex-1">{label}</span>
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${pieceStageColor[label.split(/[—-]/).pop().trim()] || 'bg-brand-400'}`} />
        </div>
      ))}
    </div>,
    <div key="stats" className="flex items-center gap-3 bg-brand-50 rounded-xl p-3">
      <div className="w-10 h-10 rounded-full bg-brand-500 flex items-center justify-center shrink-0">
        <Smartphone size={18} className="text-white" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[11px] text-landing-ink-muted truncate">{t.featureMock.statLabel}</div>
        <div className="text-sm font-extrabold text-landing-ink">{t.featureMock.statValue}</div>
      </div>
    </div>,
    <div key="driver" className="bg-brand-50 rounded-xl p-3">
      <div className="flex items-center gap-2 mb-2">
        <MapPin size={14} className="text-brand-600 shrink-0" />
        <span className="text-[11px] font-medium text-landing-ink flex-1 truncate">{t.featureMock.driverLabel}</span>
        <Car size={14} className="text-brand-600 shrink-0" />
      </div>
      <div className="h-1.5 bg-brand-100 rounded-full overflow-hidden">
        <div className="h-full bg-brand-500 rounded-full" style={{ width: '65%' }} />
      </div>
    </div>,
  ];
  const featureIcons = [MessageCircle, Shirt, Smartphone, Car];

  return (
    <div dir={dir} className="min-h-screen bg-landing-bg text-landing-ink overflow-x-hidden" style={{ fontFamily: "'Cairo','Segoe UI',Tahoma,sans-serif" }}>
      {/* Navigation */}
      <nav className="fixed top-0 w-full bg-white/90 backdrop-blur border-b border-slate-100 z-50">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 shrink-0">
            <img src="/logo.png" alt={t.brand} className="w-11 h-11 rounded-2xl object-contain shrink-0" />
            <span className="font-bold text-xl text-landing-ink">{t.brand}</span>
          </div>

          <div className="hidden lg:flex items-center gap-7 text-sm text-landing-ink-muted">
            <button onClick={() => scrollTo('features')} className="hover:text-landing-ink transition">{t.navFeatures}</button>
            <button onClick={() => scrollTo('how-it-works')} className="hover:text-landing-ink transition">{t.navHow}</button>
            <button onClick={() => scrollTo('why')} className="hover:text-landing-ink transition">{t.navWhy}</button>
            <button onClick={() => scrollTo('faq')} className="hover:text-landing-ink transition">{t.navFaq}</button>
            {/* /guides is a separate static-HTML section outside the SPA
                (see PROJECT_REFERENCE.md §19), so a real <a href> instead
                of a scrollTo() button like the others in this row. */}
            <a href="/guides" className="hover:text-landing-ink transition">{t.navGuides}</a>
          </div>

          {/* navLogin/navContact/the language toggle are real, pre-existing
              product features (an actual login for existing shop owners, a
              real sales-inquiry channel, real bilingual support) — not
              additions invented for this page, so they stay, kept visually
              secondary to the one primary CTA per the approved nav spec. */}
          <div className="flex items-center gap-4 shrink-0">
            <div className="hidden sm:flex items-center gap-1 rounded-full border border-slate-200 p-1">
              <button onClick={goLang('ar')} className={`px-3 py-1 rounded-full text-xs font-semibold transition ${lang === 'ar' ? 'bg-brand-500 text-white' : 'text-landing-ink-muted hover:text-landing-ink'}`}>عربي</button>
              <button onClick={goLang('en')} className={`px-3 py-1 rounded-full text-xs font-semibold transition ${lang === 'en' ? 'bg-brand-500 text-white' : 'text-landing-ink-muted hover:text-landing-ink'}`}>EN</button>
            </div>
            <button onClick={() => setShowContact(true)} className="hidden md:inline text-sm text-landing-ink-muted hover:text-landing-ink font-medium transition">
              {t.navContact}
            </button>
            <a href="/login" onClick={goLogin} className="hidden md:inline text-sm text-landing-ink-muted hover:text-landing-ink font-medium transition">
              {t.navLogin}
            </a>
            <a href="/signup" onClick={goSignup} className="px-5 py-2.5 rounded-lg bg-gradient-to-r from-accent-400 to-accent-600 hover:from-accent-500 hover:to-accent-600 font-semibold text-sm transition text-white shadow-app-sm">
              {t.ctaStart}
            </a>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <div className="relative overflow-hidden pt-32 pb-24 px-6">
        <div className="absolute -top-24 -right-24 w-[26rem] h-[26rem] bg-brand-300 rounded-full opacity-35 blur-[60px] pointer-events-none" />
        <div className="absolute top-1/3 -left-24 w-96 h-96 bg-accent-400 rounded-full opacity-35 blur-[60px] pointer-events-none" />

        <div className="relative max-w-6xl mx-auto grid lg:grid-cols-2 gap-14 items-center">
          <div className="text-center lg:text-start space-y-6">
            <h1 className="text-4xl md:text-5xl lg:text-[3.4rem] font-extrabold leading-tight" style={{ textWrap: 'balance' }}>
              {t.heroTitlePlain}
              <span className="bg-gradient-to-r from-brand-600 to-brand-400 bg-clip-text text-transparent">{t.heroTitleAccent}</span>
            </h1>
            <p className="text-lg text-landing-ink-muted leading-relaxed max-w-xl mx-auto lg:mx-0">{t.heroDesc}</p>
            <p className="text-base text-brand-600 font-medium">{t.heroSupport}</p>

            <div className="flex gap-4 justify-center lg:justify-start pt-2 flex-wrap">
              <a href="/signup" onClick={goSignup} className="px-8 py-3.5 rounded-lg bg-gradient-to-r from-accent-400 to-accent-600 hover:from-accent-500 hover:to-accent-600 font-semibold transition text-white shadow-app-md inline-block">
                {t.ctaStart}
              </a>
              <button onClick={() => setShowContact(true)} className="px-8 py-3.5 rounded-lg border-2 border-brand-400 text-brand-600 hover:bg-brand-50 font-semibold transition">
                {t.ctaDemo}
              </button>
            </div>

            <div className="flex items-center justify-center lg:justify-start gap-x-6 gap-y-2 flex-wrap pt-4 text-xs text-landing-ink-muted">
              {t.trustRow.map((item, i) => (
                <span key={i} className="flex items-center gap-1.5"><span className="text-brand-500">✓</span>{item}</span>
              ))}
            </div>
          </div>

          {/* Illustrative product mockup — decorative demo UI, not a real screenshot/live data */}
          <div className="relative mx-auto max-w-sm lg:mx-0">
            <div className="bg-white rounded-2xl shadow-soft border border-slate-100 p-5">
              <div className="flex items-center justify-between mb-4">
                <span className="text-[11px] font-semibold text-landing-ink-muted">{t.heroMockCaption}</span>
                <div className="flex gap-1">
                  <span className="w-2 h-2 rounded-full bg-brand-300" /><span className="w-2 h-2 rounded-full bg-accent-400" /><span className="w-2 h-2 rounded-full bg-slate-200" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 mb-4">
                <div className="rounded-xl bg-brand-50 p-3">
                  <div className="text-[11px] text-brand-700 font-medium mb-1">{t.heroMockSales}</div>
                  <div className="text-lg font-extrabold text-brand-800">2,450 SAR</div>
                </div>
                <div className="rounded-xl p-3" style={{ backgroundColor: 'rgba(255,122,61,.1)' }}>
                  <div className="text-[11px] text-accent-600 font-medium mb-1">{t.heroMockOrders}</div>
                  <div className="text-lg font-extrabold text-landing-ink">38</div>
                </div>
              </div>
              <div className="flex items-end gap-1.5 h-14 mb-4">
                {[40, 65, 50, 80, 60, 95, 70].map((h, i) => (
                  <div key={i} className="flex-1 bg-brand-400/70 rounded-t" style={{ height: `${h}%` }} />
                ))}
              </div>
              <div className="text-[11px] font-semibold text-landing-ink-muted mb-2">{t.heroMockRecent}</div>
              <div className="space-y-2">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="flex items-center justify-between text-xs">
                    <span className="flex items-center gap-1.5 text-landing-ink"><span className="w-1.5 h-1.5 rounded-full bg-brand-500" />#{1000 + i}</span>
                    <span className="text-landing-ink-muted">120 SAR</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="hidden md:block absolute -bottom-8 -left-6 bg-white rounded-xl shadow-soft border border-slate-100 p-4 w-60">
              <div className="flex items-center justify-between px-1">
                {t.heroMockStages.map((s, i) => (
                  <span key={i} className={`w-2.5 h-2.5 rounded-full ${i === 2 ? 'bg-brand-500' : 'bg-slate-200'}`} />
                ))}
              </div>
              <div className="flex items-center justify-between mt-1.5">
                {t.heroMockStages.map((s, i) => (
                  <span key={i} className={`text-[8px] ${i === 2 ? 'text-brand-600 font-bold' : 'text-landing-ink-muted'}`}>{s}</span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Problems */}
      <div className="py-24 px-6 bg-white">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-14">
            <span className="inline-block text-xs font-bold text-brand-600 bg-brand-50 rounded-full px-4 py-1.5 mb-5">{t.problemsEyebrow}</span>
            <h2 className="text-3xl md:text-4xl font-bold mb-3" style={{ textWrap: 'balance' }}>{t.problemsTitle}</h2>
            <p className="text-landing-ink-muted max-w-2xl mx-auto">{t.problemsSubtitle}</p>
          </div>
          <div className="grid md:grid-cols-2 gap-6">
            {t.problems.map((p, i) => (
              <div key={i} className="bg-white border border-slate-100 rounded-2xl p-7 shadow-soft">
                <h3 className="text-lg font-bold mb-3">{p.q}</h3>
                <p className="text-landing-ink-muted text-sm leading-relaxed mb-3">{p.pain}</p>
                <p className="text-landing-ink text-sm leading-relaxed mb-4"><span className="text-brand-500 font-bold">{dir === 'rtl' ? '← ' : '→ '}</span>{p.solution}</p>
                <span className="inline-block text-xs font-semibold text-brand-700 bg-brand-50 rounded-full px-3 py-1.5">{p.highlight}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Mid CTA */}
      <div className="py-20 px-6">
        <div className="max-w-3xl mx-auto relative overflow-hidden rounded-3xl bg-gradient-to-br from-brand-700 via-brand-600 to-brand-500 p-10 md:p-14 text-center text-white shadow-soft">
          <div className="absolute -top-10 -right-10 w-56 h-56 bg-white rounded-full opacity-10 blur-2xl pointer-events-none" />
          <div className="absolute -bottom-10 -left-10 w-56 h-56 bg-accent-400 rounded-full opacity-25 blur-2xl pointer-events-none" />
          <div className="relative space-y-5">
            <h2 className="text-2xl md:text-3xl font-bold">{t.midCtaTitle}</h2>
            <p className="text-brand-50">{t.midCtaDesc}</p>
            <div className="flex gap-4 justify-center pt-2 flex-wrap">
              <a href="/signup" onClick={goSignup} className="px-8 py-3 rounded-lg bg-gradient-to-r from-accent-400 to-accent-600 hover:from-accent-500 hover:to-accent-600 font-semibold transition text-white inline-block">
                {t.ctaStart}
              </a>
              <button onClick={() => setShowContact(true)} className="px-8 py-3 rounded-lg border-2 border-white/70 text-white hover:bg-white/10 font-semibold transition">
                {t.ctaDemo}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Before / After comparison */}
      <div className="py-24 px-6">
        <div className="max-w-4xl mx-auto">
          <div className="flex items-center justify-center gap-5 mb-10 flex-wrap">
            <h2 className="text-xl md:text-2xl font-bold text-landing-ink-muted">{t.compareTitleOld}</h2>
            <span className="text-brand-400 text-xl">{dir === 'rtl' ? '←' : '→'}</span>
            <h2 className="text-xl md:text-2xl font-bold text-brand-700">{t.compareTitleNew}</h2>
          </div>
          <div className="bg-white rounded-2xl shadow-soft border border-slate-100 overflow-hidden">
            {t.compareRows.map((row, i) => (
              <div key={i} className={`grid grid-cols-[1fr_auto_1fr] items-center ${i !== 0 ? 'border-t border-slate-100' : ''}`}>
                <div className="p-4 md:p-5 text-sm text-landing-ink-muted line-through decoration-danger-500/50" style={{ backgroundColor: 'rgba(240,68,56,.04)' }}>{row.before}</div>
                <div className="px-2 text-brand-400 text-base">{dir === 'rtl' ? '←' : '→'}</div>
                <div className="p-4 md:p-5 text-sm text-landing-ink font-semibold bg-brand-50/60">{row.after}</div>
              </div>
            ))}
          </div>
          <p className="text-center text-brand-600 font-medium mt-8">{t.compareClosing}</p>
        </div>
      </div>

      {/* Features */}
      <div id="features" className="py-24 px-6 bg-white scroll-mt-20">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-3xl md:text-4xl font-bold text-center mb-14">{t.featuresTitle}</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {t.features.map((f, i) => {
              const Icon = featureIcons[i];
              return (
                <div key={i} className="bg-white border border-slate-100 rounded-2xl p-7 shadow-soft hover:shadow-app-lg transition">
                  <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-brand-500 to-brand-600 flex items-center justify-center mb-4">
                    <Icon size={24} className="text-white" />
                  </div>
                  <h3 className="text-lg font-bold mb-2 text-landing-ink">{f.title}</h3>
                  <p className="text-landing-ink-muted text-sm leading-relaxed mb-4">{f.desc}</p>
                  <div className="mb-4">{featureVisuals[i]}</div>
                  <span className="inline-block text-xs font-semibold text-brand-700 bg-brand-50 rounded-full px-3 py-1.5">{f.highlight}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* How it works — a horizontal, connected sequence (not a stacked
          list): a background bar links the 4 step circles on large screens,
          each circle carrying its own step-number badge in the corner. */}
      <div id="how-it-works" className="py-24 px-6 scroll-mt-20">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-3xl md:text-4xl font-bold text-center mb-16">{t.howTitle}</h2>
          <div className="relative grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-10">
            <div className="hidden lg:block absolute top-8 inset-x-0 h-0.5 bg-gradient-to-l from-brand-200 via-brand-300 to-brand-200 z-0" />
            {t.howSteps.map((item, i) => (
              <div key={i} className="relative z-10 text-center">
                <div className="relative inline-flex mb-4">
                  <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-brand-500 to-brand-600 flex items-center justify-center shadow-app-md">
                    <span className="text-white font-bold text-xl">{i + 1}</span>
                  </div>
                  <span className="absolute -top-1.5 -end-1.5 w-5 h-5 rounded-full bg-accent-500 text-white text-[10px] font-bold flex items-center justify-center border-2 border-landing-bg">{item.step}</span>
                </div>
                <h3 className="text-base font-bold mb-1.5">{item.title}</h3>
                <p className="text-landing-ink-muted text-sm max-w-[15rem] mx-auto">{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Cloud section */}
      <div className="py-24 px-6 bg-white">
        <div className="max-w-2xl mx-auto text-center space-y-4">
          <h2 className="text-3xl md:text-4xl font-bold">{t.cloudTitle}</h2>
          <p className="text-landing-ink-muted">{t.cloudDesc}</p>
          <p className="text-brand-600 font-medium">{t.cloudHighlight}</p>
        </div>
      </div>

      {/* Trust / why */}
      <div id="why" className="py-24 px-6 scroll-mt-20">
        <div className="max-w-3xl mx-auto text-center">
          <h2 className="text-3xl md:text-4xl font-bold mb-8">{t.trustTitle}</h2>
          <div className="flex flex-wrap items-center justify-center gap-3">
            {t.trustChecklist.map((item, i) => (
              <span key={i} className="flex items-center gap-2 text-sm bg-brand-50 border border-brand-200 text-brand-700 rounded-full px-4 py-2">
                <span>✓</span>{item}
              </span>
            ))}
          </div>

          {/* Pricing status + a plain-language note on what "subscriptions"/
              "deferred payment" in the site description actually mean —
              real product features (customer wallet/debt, §4 of
              PROJECT_REFERENCE.md) the shop owner offers THEIR customers,
              not Ragwa's own billing model. No invented SAR figures here —
              real pricing isn't published yet. */}
          <div className="mt-14 grid md:grid-cols-2 gap-6 text-start">
            <div className="bg-white border border-slate-100 rounded-2xl p-7 shadow-soft">
              <span className="inline-block text-xs font-bold text-brand-600 bg-brand-50 rounded-full px-4 py-1.5 mb-4">{t.pricingEyebrow}</span>
              <h3 className="text-lg font-bold mb-2">{t.pricingTitle}</h3>
              <p className="text-landing-ink-muted text-sm leading-relaxed">{t.pricingDesc}</p>
            </div>
            <div className="bg-white border border-slate-100 rounded-2xl p-7 shadow-soft">
              <h3 className="text-lg font-bold mb-2">{t.walletDebtTitle}</h3>
              <p className="text-landing-ink-muted text-sm leading-relaxed mb-3">{t.walletDebtDesc}</p>
              <a href="/guides/wallet-debt-management-laundry-customers" className="text-sm font-semibold text-brand-600 hover:text-brand-700">
                {t.walletDebtLinkText} {dir === 'rtl' ? '←' : '→'}
              </a>
            </div>
          </div>
        </div>
      </div>

      {/* FAQ */}
      <div id="faq" className="py-24 px-6 bg-white scroll-mt-20">
        <div className="max-w-2xl mx-auto">
          <h2 className="text-3xl md:text-4xl font-bold text-center mb-10">{t.faqTitle}</h2>
          <div className="space-y-3">
            {t.faq.map((item, i) => (
              <div key={i} className="bg-white border border-slate-100 rounded-2xl overflow-hidden shadow-soft">
                <button onClick={() => setOpenFaq(openFaq === i ? null : i)} className="w-full flex items-center justify-between gap-4 p-5 text-start">
                  <span className="font-semibold text-landing-ink">{item.q}</span>
                  <span className={`shrink-0 text-brand-500 transition-transform ${openFaq === i ? 'rotate-45' : ''}`}>+</span>
                </button>
                {(openFaq === i || prerender) && <p hidden={prerender && openFaq !== i} className="px-5 pb-5 text-sm text-landing-ink-muted leading-relaxed">{item.a}</p>}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Final CTA */}
      <div className="py-24 px-6">
        <div className="max-w-3xl mx-auto relative overflow-hidden rounded-3xl bg-gradient-to-br from-brand-700 via-brand-600 to-brand-500 p-10 md:p-14 text-center text-white shadow-soft">
          <div className="absolute -top-10 -left-10 w-56 h-56 bg-white rounded-full opacity-10 blur-2xl pointer-events-none" />
          <div className="absolute -bottom-10 -right-10 w-56 h-56 bg-accent-400 rounded-full opacity-25 blur-2xl pointer-events-none" />
          <div className="relative space-y-4">
            <h2 className="text-2xl md:text-3xl font-bold">{t.finalCtaTitle}</h2>
            <p className="text-brand-50 max-w-xl mx-auto">{t.finalCtaDesc}</p>
            <div className="flex gap-4 justify-center pt-2 flex-wrap">
              <a href="/signup" onClick={goSignup} className="px-8 py-3.5 rounded-lg bg-gradient-to-r from-accent-400 to-accent-600 hover:from-accent-500 hover:to-accent-600 font-semibold transition text-white inline-block">
                {t.ctaStart}
              </a>
              <button onClick={() => setShowContact(true)} className="px-8 py-3.5 rounded-lg border-2 border-white/70 text-white hover:bg-white/10 font-semibold transition">
                {t.ctaDemo}
              </button>
            </div>
            <p className="text-xs text-brand-100 pt-2">{t.finalCtaSupport}</p>
          </div>
        </div>
      </div>

      {/* Footer — the one place besides the CTA banners where dark navy
          appears on the public site, per the approved design. */}
      <footer className="bg-navy-900 text-gray-300">
        <div className="max-w-4xl mx-auto px-6 py-14 text-center space-y-6">
          <div className="space-y-4">
            <h3 className="text-xl font-bold text-white">{t.footerCta}</h3>
            <a href="/signup" onClick={goSignup} className="px-7 py-2.5 rounded-lg bg-gradient-to-r from-accent-400 to-accent-600 hover:from-accent-500 hover:to-accent-600 font-semibold transition text-white inline-block">
              {t.ctaStart}
            </a>
          </div>
          <div className="flex items-center justify-center gap-2 pt-4">
            <img src="/logo.png" alt={t.brand} className="w-8 h-8 rounded-lg object-contain" />
            <span className="font-bold text-white">{t.brand}</span>
          </div>
          <div className="flex items-center justify-center gap-6 flex-wrap text-sm text-gray-400">
            <button onClick={() => scrollTo('features')} className="hover:text-white transition">{t.navFeatures}</button>
            <button onClick={() => scrollTo('how-it-works')} className="hover:text-white transition">{t.navHow}</button>
            <button onClick={() => scrollTo('faq')} className="hover:text-white transition">{t.navFaq}</button>
            <a href="/terms" onClick={(e) => { e.preventDefault(); onOpenTerms(); }} className="hover:text-white transition">
              {lang === 'ar' ? 'الشروط والأحكام' : 'Terms & Conditions'}
            </a>
            <a href="/privacy" onClick={(e) => { e.preventDefault(); onOpenTerms('privacy'); }} className="hover:text-white transition">
              {lang === 'ar' ? 'سياسة الخصوصية' : 'Privacy Policy'}
            </a>
            {/* Plain full-page navigation on purpose -- /guides is a set of
                static HTML pages outside the React app, not an SPA route. */}
            <a href="/guides" className="hover:text-white transition">
              {lang === 'ar' ? 'أدلة ومقالات' : 'Guides'}
            </a>
          </div>
          <p className="text-xs text-gray-500 pt-2">© {new Date().getFullYear()} {t.brand} | {t.footerRights}</p>
        </div>
      </footer>

      {showContact && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setShowContact(false)}>
          <div dir={dir} className="w-full max-w-md rounded-2xl bg-white border border-slate-200 shadow-soft" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
              <h3 className="font-bold text-landing-ink">{t.contactModalTitle}</h3>
              <button onClick={() => setShowContact(false)} className="text-slate-400 hover:text-landing-ink text-lg">✕</button>
            </div>
            <div className="p-5">
              {contactSent ? (
                <div className="py-8 text-center text-brand-600">
                  <div className="text-3xl mb-2">✓</div>
                  <p>{t.contactSentMsg}</p>
                </div>
              ) : (
                <>
                  <div className="mb-4">
                    <label className="block text-landing-ink text-sm font-semibold mb-2">{t.contactName}</label>
                    <input value={contactName} onChange={(e) => setContactName(e.target.value)} className="w-full bg-white border border-slate-200 rounded-lg px-4 py-2.5 text-landing-ink placeholder-slate-400 focus:border-brand-400 outline-none transition" />
                  </div>
                  <div className="mb-4">
                    <label className="block text-landing-ink text-sm font-semibold mb-2">{t.contactMobile}</label>
                    <input value={contactMobile} onChange={(e) => setContactMobile(e.target.value)} placeholder="0501234567" className="w-full bg-white border border-slate-200 rounded-lg px-4 py-2.5 text-landing-ink placeholder-slate-400 focus:border-brand-400 outline-none transition" />
                  </div>
                  <div className="mb-4">
                    <label className="block text-landing-ink text-sm font-semibold mb-2">{t.contactEmail}</label>
                    <input value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} placeholder="name@example.com" className="w-full bg-white border border-slate-200 rounded-lg px-4 py-2.5 text-landing-ink placeholder-slate-400 focus:border-brand-400 outline-none transition" />
                  </div>
                  <div className="mb-4">
                    <label className="block text-landing-ink text-sm font-semibold mb-2">{t.contactType}</label>
                    <select value={contactType} onChange={(e) => setContactType(e.target.value)} className="w-full bg-white border border-slate-200 rounded-lg px-4 py-2.5 text-landing-ink focus:border-brand-400 outline-none transition">
                      {t.contactTypes.map((ct) => <option key={ct}>{ct}</option>)}
                    </select>
                  </div>
                  <div className="mb-5">
                    <label className="block text-landing-ink text-sm font-semibold mb-2">{t.contactMessage}</label>
                    <textarea value={contactMessage} onChange={(e) => setContactMessage(e.target.value)} rows={3} className="w-full bg-white border border-slate-200 rounded-lg px-4 py-2.5 text-landing-ink placeholder-slate-400 focus:border-brand-400 outline-none transition" />
                  </div>
                  {/* Honeypot — invisible to a real visitor (clipped to 0×0, not
                      display:none, since some bots skip fields display:none hides),
                      never tab-reachable. Clipped in place rather than pushed off
                      with a large negative offset — that used to blow up this
                      page's scrollWidth by ~9999px whenever the contact modal was
                      open, since Chrome counts a transformed/offset box's ink
                      overflow toward the document's scrollable area. */}
                  <input
                    type="text" value={contactWebsite} onChange={(e) => setContactWebsite(e.target.value)}
                    autoComplete="off" tabIndex={-1} aria-hidden="true"
                    style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: '-1px', overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', border: 0, opacity: 0 }}
                  />
                  <button onClick={() => submitContact({ website: contactWebsite, formStartedAt: formStartedAtRef.current })} className="w-full bg-gradient-to-r from-accent-400 to-accent-600 hover:from-accent-500 hover:to-accent-600 text-white font-semibold py-3 rounded-lg transition">
                    {t.contactSend}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
