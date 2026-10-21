import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "FMPI — Financial Market Pressure Index",
  description:
    "Dynamic momentum-pressure engine for the NSE F&O universe, NIFTY and SENSEX. Genuine Upstox data, adaptive zones, continuation vs exhaustion, 5M/10M.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
