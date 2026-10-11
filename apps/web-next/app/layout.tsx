import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { metadataBase } from "./seo";
import "./globals.css";


const geistSans = localFont({
  src: "../public/Geist-latin.woff2",
  variable: "--font-geist-sans",
  weight: "100 900",
  display: "swap",
});

const fustat = localFont({
  src: "../public/Fustat-latin.woff2",
  variable: "--font-fustat",
  weight: "400 700",
  display: "swap",
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
};

export const metadata: Metadata = {
  metadataBase,
  title: {
    default: "EAS",
    template: "%s | EAS",
  },
  description: "Learn from your documents with guided lessons, and ask EAS anything.",
  keywords: ["PDF", "interactive lessons", "course generator", "AI", "education", "learning"],
  authors: [{ name: "EAS" }],
  openGraph: {
    title: "EAS",
    description: "Learn from your documents with guided lessons, and ask EAS anything.",
    type: "website",
    siteName: "EAS",
  },
  twitter: {
    card: "summary_large_image",
    title: "EAS",
    description: "Learn from your documents with guided lessons, and ask EAS anything.",
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="light">
      <body
        className={`${geistSans.variable} ${fustat.variable} antialiased bg-white`}
      >
        {children}
      </body>
    </html>
  );
}
