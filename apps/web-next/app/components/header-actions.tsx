"use client";

import Link from "next/link";
import { BookOpen, MessageCircle } from "lucide-react";
import { buttonVariants } from "./ui/button";

function HeaderActions() {
  return (
    <div className="flex flex-shrink-0 items-center gap-2">
      <Link href="/courses" className={buttonVariants({ variant: "secondary", size: "sm" })}>
        <BookOpen className="h-3.5 w-3.5" />
        Courses
      </Link>
      <Link href="/chat" className={buttonVariants({ variant: "secondary", size: "sm" })}>
        <MessageCircle className="h-3.5 w-3.5" />
        Ask EAS
      </Link>
    </div>
  );
}

export { HeaderActions };
