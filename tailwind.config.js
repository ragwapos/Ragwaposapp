/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,jsx}",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eefcfb', 100: '#d3f5f1', 200: '#a6ebe4', 300: '#6fdad0', 400: '#3cc2b9',
          500: '#17a5a0', 600: '#0e8688', 700: '#0d6b70', 800: '#0f5459', 900: '#0a3336',
        },
        navy: {
          950: '#070d19', 900: '#0d172a', 800: '#16223b', 700: '#202f4d', 600: '#2c3e63',
        },
        app: {
          bg: '#f7f9fa', surface: '#ffffff', border: '#e6eaed', 'border-strong': '#d7dde2',
          text: '#101828', 'text-muted': '#667085', 'text-subtle': '#98a2b3',
        },
        success: { 50: '#ecfdf3', 500: '#12b76a', 600: '#039855', 700: '#027a48' },
        warning: { 50: '#fffaeb', 500: '#f79009', 600: '#dc6803', 700: '#b54708' },
        danger: { 50: '#fef3f2', 500: '#f04438', 600: '#d92d20', 700: '#b42318' },
        info: { 50: '#eff8ff', 500: '#2e90fa', 600: '#1570ef', 700: '#175cd3' },
        accent: { 400: '#ff9d5c', 500: '#ff7a3d', 600: '#f0611f' },
        // Public landing page only — a light, airy palette, distinct from the
        // internal app's dark navy sidebar/app-* tokens above. Navy still
        // appears on the landing page, but only in the footer band and the
        // CTA banners (per the approved design), never as the page ground.
        landing: { bg: '#f6faf9', ink: '#0b2331', 'ink-muted': '#5b7381' },
      },
      fontFamily: {
        cairo: ["'Cairo'", "'Segoe UI'", 'Tahoma', 'sans-serif'],
      },
      boxShadow: {
        'app-xs': '0 1px 2px rgba(16,24,40,.05)',
        'app-sm': '0 1px 3px rgba(16,24,40,.06), 0 1px 2px rgba(16,24,40,.04)',
        'app-md': '0 4px 8px -2px rgba(16,24,40,.06), 0 2px 4px -2px rgba(16,24,40,.04)',
        'app-lg': '0 12px 16px -4px rgba(16,24,40,.08), 0 4px 6px -2px rgba(16,24,40,.03)',
        soft: '0 2px 8px rgba(11,35,49,.04), 0 16px 40px -12px rgba(11,35,49,.12)',
      },
    },
  },
  plugins: [],
};
