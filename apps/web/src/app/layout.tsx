import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Inter } from "next/font/google";
import "./globals.css";

// Ha van globals.css a src/app alatt, ez fogja betölteni a Tailwindet / globál CSS-t
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "CareLoop",
    template: "%s · CareLoop",
  },
  description:
    "AI health diary + clinician note assistant: diary trends + pre-visit summary, voice-to-SOAP notes, closed-loop plan to patient tasks. (Synthetic demo, no PHI.)",
  applicationName: "CareLoop",
  authors: [{ name: "CareLoop" }],
  robots: { index: false, follow: false }, // demo/hackathon safe default; ha publikus kell, vedd ki
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="h-full scroll-smooth">
      <body
        className={[
          inter.className,
          "min-h-full bg-gradient-to-b from-white via-slate-50 to-slate-100 text-slate-900 antialiased",
        ].join(" ")}
      >
        {children}
      </body>
    </html>
  );
}
