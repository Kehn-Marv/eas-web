"use client";

import { useEffect } from "react";
import localFont from "next/font/local";
import "./landing.css";

const fustat = localFont({
  src: "../../public/fonts/Fustat-latin.woff2",
  variable: "--font-fustat",
  weight: "400 700",
  display: "swap",
});

const geistSans = localFont({
  src: "../../public/fonts/Geist-latin.woff2",
  variable: "--font-geist-sans",
  weight: "100 900",
  display: "swap",
});

export default function LandingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  useEffect(() => {
    const prevHtmlOverflow = document.documentElement.style.overflow;
    const prevHtmlHeight = document.documentElement.style.height;
    const prevBodyOverflow = document.body.style.overflow;
    const prevBodyHeight = document.body.style.height;

    document.documentElement.style.overflowY = "auto";
    document.documentElement.style.overflowX = "hidden";
    document.documentElement.style.height = "auto";
    document.body.style.overflow = "visible";
    document.body.style.height = "auto";

    return () => {
      document.documentElement.style.overflow = prevHtmlOverflow;
      document.documentElement.style.height = prevHtmlHeight;
      document.body.style.overflow = prevBodyOverflow;
      document.body.style.height = prevBodyHeight;
    };
  }, []);

  return (
    <div className={`${fustat.variable} ${geistSans.variable} landing-root min-h-screen bg-[#faf8f5] text-neutral-900`}>
      {children}
    </div>
  );
}
