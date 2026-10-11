import type { Metadata } from "next";
import { LearnClient } from "../learn/learn-client";

export const metadata: Metadata = { title: "Shared course", description: "Learn from a shared EAS course." };
export default function SharedCoursePage() { return <LearnClient />; }
