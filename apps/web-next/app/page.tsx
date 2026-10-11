import type { Metadata } from "next";
import { HomeClient } from "./home-client";

export const metadata: Metadata = {
  title: "EAS",
  description: "Learn from your documents with guided lessons, and ask EAS anything.",
  openGraph: {
    title: "EAS",
    description: "Learn from your documents with guided lessons, and ask EAS anything.",
  },
  twitter: {
    title: "EAS",
    description: "Learn from your documents with guided lessons, and ask EAS anything.",
  },
};

export default function Home() {
  return <HomeClient />;
}
