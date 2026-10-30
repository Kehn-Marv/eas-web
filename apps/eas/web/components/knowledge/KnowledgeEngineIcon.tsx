import { Database } from "lucide-react";

/**
 * Brand marks for knowledge engines and live knowledge sources.
 *
 * Assets are vendored under /public so the Knowledge Center keeps working in
 * offline/self-hosted deployments. Engines without an EAS-owned mark use the
 * neutral database icon below.
 */
const KNOWLEDGE_ICONS: Record<string, string> = {
  llamaindex: "/knowledge-engine-icons/llamaindex.png",
  "pageindex-oss": "/knowledge-engine-icons/pageindex.png",
  graphrag: "/knowledge-engine-icons/graphrag.png",
};

export function knowledgeSourceIconId(input: {
  provider?: string | null;
  type?: string | null;
}): string {
  return input.provider || "llamaindex";
}

export default function KnowledgeEngineIcon({
  engine,
  size = 20,
  className = "",
}: {
  engine?: string | null;
  size?: number;
  className?: string;
}) {
  const source = engine ? KNOWLEDGE_ICONS[engine] : undefined;
  if (!source) {
    return (
      <Database
        size={size}
        strokeWidth={1.7}
        className={`shrink-0 ${className}`.trim()}
      />
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={source}
      alt=""
      aria-hidden
      width={size}
      height={size}
      draggable={false}
      className={`shrink-0 select-none object-contain ${className}`.trim()}
    />
  );
}
