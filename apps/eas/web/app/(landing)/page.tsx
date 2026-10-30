import type { Metadata } from "next";
import { LandingScreen } from "@/components/landing/landing-screen";

export const metadata: Metadata = {
  title: "EAS",
  description:
    "Ask questions freely, bring your study materials, and explore difficult concepts with interactive visuals when text isn't enough.",
  openGraph: {
    title: "EAS",
    description:
      "Ask questions freely, bring your study materials, and explore difficult concepts with interactive visuals when text isn't enough.",
  },
  twitter: {
    title: "EAS",
    description:
      "Ask questions freely, bring your study materials, and explore difficult concepts with interactive visuals when text isn't enough.",
  },
};

export default function Home() {
  return <LandingScreen />;
}
