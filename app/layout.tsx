import type { Metadata } from "next";
import { Noto_Sans_Mono } from "next/font/google";
import "katex/dist/katex.min.css";
import "./globals.css";
import { I18nProvider } from "@/lib/i18n";

const notoSansMono = Noto_Sans_Mono({
  subsets: ["latin", "cyrillic"],
  variable: "--font-noto-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Pidance",
  description: "Open-source web client for the Pi coding agent",
  icons: {
    icon: "/brand/pidance-logo.png",
    apple: "/brand/pidance-logo.png",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" translate="no" className={`${notoSansMono.variable} notranslate`} suppressHydrationWarning>
      <head>
        <meta name="google" content="notranslate" />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var r=document.documentElement,m=localStorage.getItem("pi-theme"),s=localStorage.getItem("pi-theme-style");if(m!=="light"&&m!=="dark"&&m!=="system")m="light";if(s!=="fusion"&&s!=="chamber")s="chamber";var d=m==="dark"||(m==="system"&&matchMedia("(prefers-color-scheme: dark)").matches);r.classList.toggle("dark",d);r.dataset.themeMode=m;r.dataset.themeStyle=s}catch(e){}})();`,
          }}
        />
      </head>
      <body translate="no" className="notranslate" style={{ height: "100dvh", display: "flex", flexDirection: "column" }}>
        <I18nProvider>{children}</I18nProvider>
      </body>
    </html>
  );
}
