// Build-time only (never shipped to the browser): scripts/build-landing-prerender.mjs
// compiles this with `vite build --ssr` and calls render() to put the real,
// fully styled landing markup into dist/index.html and dist/en/index.html, so
// the page paints as soon as the HTML + CSS arrive instead of after the JS
// bundle. main.jsx then replaces it with an identical React-rendered tree.
// renderLogin() and renderSkeleton() do the same for the login form and the
// dashboard skeleton (dist/app.html); public/boot.js picks which one shows.
import React from "react";
import { renderToString } from "react-dom/server";
import LandingPage from "./LandingPage.jsx";
import LoginPage from "../auth/LoginPage.jsx";
import { DashboardSkeleton } from "../dashboard/DashboardSkeleton.jsx";

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

export function renderLogin(lang) {
  return renderToString(
    <LoginPage
      lang={lang}
      navigate={noop}
      showPassword={false} setShowPassword={noop}
      loginEmail="" setLoginEmail={noop}
      loginPassword="" setLoginPassword={noop}
      handleLogin={noop} loginError="" loginLoading={false}
      preloadDashboard={noop} focusField={null}
    />
  );
}

export function renderSkeleton() {
  return renderToString(<DashboardSkeleton />);
}
