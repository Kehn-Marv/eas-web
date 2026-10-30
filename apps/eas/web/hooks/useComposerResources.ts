"use client";

import { useEffect, useState } from "react";

import {
  getWorkspaceResources,
  type WorkspaceResourceOption,
} from "@/lib/workspaces-api";

export interface ComposerResourceCatalog {
  skills: WorkspaceResourceOption[];
}

const EMPTY: ComposerResourceCatalog = { skills: [] };

/**
 * The skill catalog visible to a conversation's workspace.
 */
export function useComposerResources(
  workspaceId: string | null,
): ComposerResourceCatalog {
  const [catalog, setCatalog] = useState<ComposerResourceCatalog>(EMPTY);

  useEffect(() => {
    let alive = true;
    void getWorkspaceResources(workspaceId ?? "")
      .then((remote) => {
        if (!alive) return;
        setCatalog({
          skills: remote.skills ?? [],
        });
      })
      .catch(() => {
        // The pickers simply report nothing to pick; a conversation with no
        // selection inherits its workspace, so this degrades to the old
        // behaviour rather than to an error the user must dismiss.
        if (alive) setCatalog(EMPTY);
      });
    return () => {
      alive = false;
    };
  }, [workspaceId]);

  return catalog;
}
