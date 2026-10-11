import type { Metadata } from "next";
import { LearnClient } from "./learn-client";

export const metadata: Metadata = { title: "Your learning path", description: "A guided learning path built from your sources." };
export default function LearnPage() { return <LearnClient />; }
