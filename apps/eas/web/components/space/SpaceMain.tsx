"use client";

import { Suspense } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import { FeaturePage } from "@/components/layout/FeaturePage";

// Hub-and-spoke: the dashboard at `/space` is the only navigator. Once inside a
// section we don't re-list every sibling on a rail — a single "back to the hub"
// link keeps the section focused and sends you to the overview to switch.
function BackToHub() {
  const { t } = useTranslation();
  return (
    <Link
      href="/space"
      className="group inline-flex items-center gap-1.5 text-[13px] text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
    >
      <ArrowLeft
        size={15}
        strokeWidth={1.8}
        className="transition-transform group-hover:-translate-x-0.5"
      />
      {t("Learning Space")}
    </Link>
  );
}

export default function SpaceMain({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const pathname = usePathname() ?? "";
  const isDashboard = pathname === "/space";

  return (
    <FeaturePage>
      {!isDashboard && (
        <div className="mb-5">
          <BackToHub />
        </div>
      )}
      {children}
    </FeaturePage>
  );
}
