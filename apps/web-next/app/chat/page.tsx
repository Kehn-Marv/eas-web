import type { Metadata } from "next";
import { ChatClient } from "./chat-client";

export const metadata: Metadata = {
  title: "Ask EAS",
  description: "Ask a question directly or get answers grounded in your learning materials.",
};

export default function ChatPage() {
  return <ChatClient />;
}
