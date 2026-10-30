"use client";

import { Sparkles } from "lucide-react";
import { buttonVariants } from "./ui/button";
import { EAS_APP_URL } from "@/lib/eas-app";

function HeaderActions() {
  return (
    <div className="flex flex-shrink-0 items-center gap-2">
      <a href={EAS_APP_URL} className={buttonVariants({ variant: "secondary", size: "sm" })}>
        <Sparkles className="h-3.5 w-3.5" />
        Open learning space
      </a>
    </div>
  );
}

export { HeaderActions };
