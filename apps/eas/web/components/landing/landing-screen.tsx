import Image from "next/image";
import Link from "next/link";
import { Sparkles } from "lucide-react";
import { HeaderActions } from "./header-actions";
import { LandingSteps } from "./landing-steps";
import { Reveal } from "./reveal";
import { buttonVariants } from "./ui/button";
import { EAS_APP_URL } from "@/lib/eas-app";

function LandingScreen() {
  return (
    <div className="min-h-screen bg-[#faf8f5] relative flex flex-col">
      <header className="landing-header sticky top-0 z-50 h-16 border-b-[0.5px] border-border">
        <div className="h-full max-w-7xl mx-auto px-6 flex items-center justify-between">
          <Link href="/" aria-label="EAS home" className="flex items-center gap-2.5 text-neutral-950">
            <Image
              src="/logo.svg"
              alt=""
              width={26}
              height={29}
              priority
              className="h-7 w-[25px] object-contain"
              aria-hidden="true"
            />
            <span className="font-sans text-lg font-bold leading-none tracking-normal whitespace-nowrap">EAS</span>
          </Link>
          <HeaderActions />
        </div>
      </header>

      <main className="relative z-10 flex-1 w-full max-w-7xl mx-auto px-6 pt-16 md:pt-24 pb-8 md:pb-10 overflow-x-clip">
        <section className="relative">
          <Image src="/landing-left.webp" alt="" aria-hidden="true" width={300} height={338} priority className="rise hidden lg:block absolute left-0 top-10 w-56 xl:w-72 h-auto z-0 pointer-events-none select-none" style={{ animationDelay: "0.15s" }} />
          <Image src="/landing-right.webp" alt="" aria-hidden="true" width={300} height={300} priority className="rise hidden lg:block absolute right-0 top-10 w-56 xl:w-72 h-auto z-0 pointer-events-none select-none" style={{ animationDelay: "0.22s" }} />
          <div className="relative z-10 text-center max-w-3xl mx-auto">
            <h1 className="rise font-bold text-neutral-900 leading-[1.05] tracking-[-0.045em] text-balance mb-5 text-[clamp(2.5rem,7vw,4.5rem)]" style={{ animationDelay: "0.11s" }}>
              Learning that moves at your pace
            </h1>
            <p className="rise text-lg md:text-xl text-neutral-600 font-medium text-pretty max-w-2xl mx-auto mb-8" style={{ animationDelay: "0.18s" }}>
              Ask questions freely, bring your study materials, and explore difficult concepts with interactive visuals when text isn&rsquo;t enough.
            </p>
            <a href={EAS_APP_URL} className={buttonVariants({ size: "lg" })}>
              <Sparkles className="w-5 h-5" />
              Open learning space
            </a>
          </div>
        </section>

        <LandingSteps />

        <section>
          <Reveal className="gradient-border max-w-5xl mx-auto p-8 md:p-12">
            <div className="flex flex-col items-center lg:flex-row lg:justify-between gap-8">
              <div className="max-w-xl text-center lg:text-left">
                <span className="text-xs font-semibold uppercase tracking-wider text-hint-fg">Ready when you are</span>
                <h2 className="text-[clamp(1.75rem,4vw,2.75rem)] font-bold text-neutral-900 tracking-[-0.04em] text-balance mt-2 mb-3 leading-[1.1]">
                  Start with a question. Follow your curiosity.
                </h2>
                <p className="text-base text-neutral-600">Bring your material, ask your questions, and find a better way to understand.</p>
              </div>
              <a href={EAS_APP_URL} className={buttonVariants({ size: "lg", className: "w-full sm:w-auto" })}>
                <Sparkles className="w-5 h-5" />
                Open learning space
              </a>
            </div>
          </Reveal>
        </section>
      </main>

    </div>
  );
}

export { LandingScreen };
