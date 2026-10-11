import type { Metadata } from "next";
import { CoursesClient } from "./courses-client";

export const metadata: Metadata = { title: "Your courses", description: "Return to your saved EAS learning paths." };
export default function CoursesPage() { return <CoursesClient />; }
