import { Suspense } from "react";

import SkillsSection from "@/components/space/SkillsSection";

export default function SpaceSkillsPage() {
  // Suspense boundary is required: components below consume useSearchParams
  // and must not bail out of static prerendering.
  return (
    <Suspense>
      <SkillsSection />
    </Suspense>
  );
}
