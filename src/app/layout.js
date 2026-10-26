import { Inter } from "next/font/google";
import { GoogleAnalytics } from "@next/third-parties/google";
import "material-symbols/outlined.css";
import "./globals.css";
import { ThemeProvider } from "@/shared/components/ThemeProvider";
import "@/lib/network/initOutboundProxy"; // Auto-initialize outbound proxy env
import "@/shared/services/bootstrap"; // Auto-run initializeApp (watchdog, auto-resume tunnel)
import { initConsoleLogCapture } from "@/lib/consoleLogBuffer";
import { RuntimeI18nProvider } from "@/i18n/RuntimeI18nProvider";

// Hook console immediately at module load time (server-side only, runs once)
initConsoleLogCapture();

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

export const metadata = {
  title: "9Router - AI Infrastructure Management",
  description: "One endpoint for all your AI providers. Manage keys, monitor usage, and scale effortlessly.",
  icons: {
    icon: "/favicon.svg",
  },
};

export const viewport = {
  themeColor: "#0a0a0a",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Preconnect to external font domains to establish early TCP/TLS handshake */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* Apply persisted theme before first paint so a reload does not flash the
            default (light) theme before the client store hydrates. Mirrors the
            zustand-persist "theme" key and the `dark` class applyTheme() sets. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var s=localStorage.getItem('theme');var t=s?(JSON.parse(s).state||{}).theme:'system';t=t||'system';var m=window.matchMedia('(prefers-color-scheme: dark)').matches;if(t==='dark'||(t==='system'&&m)){document.documentElement.classList.add('dark')}}catch(e){}})();`,
          }}
        />
        <script
          dangerouslySetInnerHTML={{
            __html: `var d=document,r=d.documentElement,f=function(){r.classList.add('fonts-loaded')};if(d.fonts&&d.fonts.load){d.fonts.load('24px "Material Symbols Outlined"').then(f).catch(f);setTimeout(f,500)}else{f()}`,
          }}
        />
      </head>
      <body className={`${inter.variable} font-sans antialiased`}>
        {/*
          Skip link. It must be focusable and visible once focused, so it
          carries only the `skip-link` class — combining it with
          `visually-hidden` left the element 1x1px and clipped, because
          `.visually-hidden` sets width/height/clip unconditionally and
          `.skip-link:focus` only changed `top`. The link points at
          `#main`, the content wrapper rendered below.

          The wrapper is a `<div>`, not a `<main>`: three components in the
          tree already render their own `<main>` landmark (DashboardLayout,
          AuthLayout, the landing page), and a `<main>` in the root layout
          would nest a second one inside every one of them. A document may
          have only one non-hidden `<main>`, and two of them defeat the
          purpose of the skip link that this same change is fixing.
        */}
        <a href="#main" className="skip-link">
          Skip to main content
        </a>
        <ThemeProvider>
          <RuntimeI18nProvider>
            <div id="main" tabIndex={-1}>
              {children}
            </div>
          </RuntimeI18nProvider>
        </ThemeProvider>
        <GoogleAnalytics gaId={"G-LC959F603F"} />
      </body>
    </html>
  );
}
