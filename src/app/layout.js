// src/app/layout.js
// ─────────────────────────────────────────────────────────────────────────────
// FAVICON FIX — what was wrong:
//
// 1. metadata had NO icons field at all → browser showed default blank tab icon
// 2. No favicon.ico in src/app/ (Next.js App Router looks here first)
// 3. No /favicon.ico in public/ (fallback browsers check)
// 4. apple-touch-icon was set but favicon itself was missing
//
// Fix: declare icons in metadata + add <link> tags as fallback
// File placement guide at bottom of this file.
// ─────────────────────────────────────────────────────────────────────────────

import './globals.css';

export const metadata = {
  title: 'AGRYX – AI Student OS',
  description: 'The all-in-one AI-powered platform for students. Study smarter, plan better, achieve more.',
  manifest: '/manifest.json',

  // ── FAVICON CONFIG ────────────────────────────────────────────────────────
  // Next.js App Router reads this and injects the right <link> tags automatically.
  // These paths must exist in your /public folder OR as special files in /src/app/
  icons: {
    // Browser tab favicon (shows in Chrome, Firefox, Edge, Safari tabs)
    icon: [
      { url: '/favicon.ico',          sizes: 'any' },        // legacy browsers
      { url: '/icon-32.png',          sizes: '32x32',   type: 'image/png' },
      { url: '/icon-192.png',         sizes: '192x192', type: 'image/png' },
    ],
    // Apple home screen icon (iPhone/iPad "Add to Home Screen")
    apple: [
      { url: '/icon-192.png',         sizes: '192x192', type: 'image/png' },
      { url: '/icon-512.png',         sizes: '512x512', type: 'image/png' },
    ],
    // High-res for Android PWA
    other: [
      { rel: 'icon',        url: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { rel: 'shortcut icon', url: '/favicon.ico' },
    ],
  },
  // ── END FAVICON CONFIG ────────────────────────────────────────────────────

  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'AGRYX',
  },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  themeColor: '#e02020',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        {/*
          These manual <link> tags are FALLBACK for browsers that ignore Next.js metadata.
          Vercel edge caching can sometimes serve stale metadata — manual tags always work.
        */}
        <link rel="icon"             href="/favicon.ico"   sizes="any" />
        <link rel="icon"             href="/icon-32.png"   sizes="32x32"   type="image/png" />
        <link rel="icon"             href="/icon-192.png"  sizes="192x192" type="image/png" />
        <link rel="apple-touch-icon" href="/icon-192.png"  sizes="192x192" />
        <link rel="apple-touch-icon" href="/icon-512.png"  sizes="512x512" />
        <link rel="shortcut icon"    href="/favicon.ico" />

        {/* PWA / mobile web app */}
        <meta name="apple-mobile-web-app-capable"          content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="apple-mobile-web-app-title"            content="AGRYX" />
        <meta name="mobile-web-app-capable"                content="yes" />
        <meta name="application-name"                      content="AGRYX" />
        <meta name="msapplication-TileImage"               content="/icon-192.png" />
        <meta name="msapplication-TileColor"               content="#e02020" />
      </head>
      <body style={{ margin: 0, padding: 0 }}>
        {children}
      </body>
    </html>
  );
}

/*
═══════════════════════════════════════════════════════════════════════════════
FILE PLACEMENT GUIDE — where every icon file must go
═══════════════════════════════════════════════════════════════════════════════

YOUR PROJECT STRUCTURE:
├── public/
│   ├── favicon.ico        ← REQUIRED — browser tab icon for all browsers
│   ├── icon-32.png        ← REQUIRED — browser tab (high-DPI screens)
│   ├── icon-192.png       ← REQUIRED — Android PWA + Apple touch icon
│   ├── icon-512.png       ← REQUIRED — Android PWA splash screen
│   ├── manifest.json      ← already exists
│   └── sw.js              ← already exists
│
└── src/app/
    ├── favicon.ico        ← OPTIONAL but recommended — Next.js App Router
    │                         auto-detects this and uses it WITHOUT any metadata
    ├── layout.js          ← this file
    ├── page.js
    └── globals.css

HOW TO CREATE THE ICON FILES:
═══════════════════════════════════════════════════════════════════════════════

OPTION A — Use the icon-generator.html file included in this zip
  Open it in a browser → it draws the AGRYX logo → right-click → Save As
  Then resize copies to 32px, 192px, 512px

OPTION B — Online tool (fastest):
  1. Go to https://favicon.io/favicon-generator/
  2. Text: A  |  Background: Rounded  |  Color: #e02020  |  Font: Any bold sans
  3. Download the zip — it contains favicon.ico + all PNG sizes
  4. Put them in /public/

OPTION C — If you have the AGRYX logo as SVG or PNG already:
  1. Go to https://realfavicongenerator.net/
  2. Upload your logo
  3. Download the package
  4. Place ALL files in /public/
  5. They give you exact HTML to paste — use the <link> tags above instead
     (Next.js handles it with the metadata object)

VERIFYING IT WORKS AFTER DEPLOY:
═══════════════════════════════════════════════════════════════════════════════
  1. Deploy to Vercel
  2. Open https://agryxai.com in Chrome
  3. Open DevTools → Network → filter "favicon"
  4. Reload — you should see favicon.ico returning 200
  5. If you see 404 → the file is not in /public/

  IMPORTANT: Browsers cache favicons aggressively.
  After deploying, do a hard reload: Ctrl+Shift+R (Windows) / Cmd+Shift+R (Mac)
  Or open in Incognito window to see the updated favicon immediately.

WHY VERCEL NEEDS /public/:
═══════════════════════════════════════════════════════════════════════════════
  Vercel serves everything in /public/ at the root URL automatically.
  /public/favicon.ico  →  https://agryxai.com/favicon.ico  ✓
  /public/icon-192.png →  https://agryxai.com/icon-192.png ✓

  Files NOT in /public/ are NOT served as static assets.
*/
