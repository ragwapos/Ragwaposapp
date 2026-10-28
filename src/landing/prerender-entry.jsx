// Build-time only (never shipped to the browser): scripts/build-landing-prerender.mjs
// compiles this with `vite build --ssr` and calls render() to put the real,
// fully styled landing markup into dist/index.html and dist/en/index.html, so
// the page paints as soon as the HTML + CSS arrive instead of after the JS
// bundle. main.jsx then replaces it with an identical React-rendered tree.
import React from "react";
import { renderToString } from "react-dom/server";
import LandingPage from "./LandingPage.jsx";

const noop = () => {};

export function render(lang) {
  return renderToString(
    <LandingPage
      lang={lang}
      prerender
      navigate={noop}
      showWorkflow={false} setShowWorkflow={noop}
      showContact={false} setShowContact={noop}
      contactName="" setContactName={noop}
      contactMobile="" setContactMobile={noop}
      contactEmail="" setContactEmail={noop}
      contactType="" setContactType={noop}
      contactMessage="" setContactMessage={noop}
      contactSent={false} submitContact={noop}
      onOpenTerms={noop}
    />
  );
}
