import { LogoSvg } from "./svg-icons";

function Footer() {
  return (
    <div className="w-full py-6">
      <div className="max-w-7xl mx-auto px-6 flex items-center justify-between">
        <a href="/" className="interactive inline-flex items-center gap-2 h-8 px-3 rounded-full bg-white border border-border text-sm font-semibold text-neutral-800" aria-label="EAS home">
          <LogoSvg className="h-5 w-5" aria-hidden="true" />
          EAS
        </a>
        <span className="text-xs text-neutral-500">Learn with clarity. Stay close to your sources.</span>
      </div>
    </div>
  );
}

export { Footer };
