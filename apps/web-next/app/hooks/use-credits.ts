import { useState } from "react";

interface Credits {
  coursesRemaining: number;
  gradingsRemaining: number;
}

export function useCredits() {
  const [credits] = useState<Credits>({ coursesRemaining: 3, gradingsRemaining: 50 });
  const loaded = true;
  return { credits, loaded };
}
