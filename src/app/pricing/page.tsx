import Navigation from "@/components/navigation"

export default function PricingPage() {
  return (
    <div className="min-h-screen flex flex-col bg-slate-950 text-foreground">
      <Navigation />

      <div className="flex-1 flex flex-col items-center justify-center px-4">
        <div className="relative flex flex-col items-center">
          {/* Glow effect */}
          <div className="absolute -inset-20 bg-emerald-500/[0.03] rounded-full blur-3xl" />

          {/* Badge */}
          <span className="relative text-[11px] font-medium px-3 py-1 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 mb-6">
            Coming Soon
          </span>

          {/* Heading */}
          <h1 className="relative text-4xl sm:text-5xl font-bold text-center bg-gradient-to-b from-white to-white/60 bg-clip-text text-transparent mb-4">
            Pricing
          </h1>

          {/* Subtext */}
          <p className="relative text-white/40 text-center max-w-md text-sm sm:text-base leading-relaxed">
            We&apos;re crafting flexible plans to fit teams of every size.<br />Stay tuned — pricing details are on the way.
          </p>

          {/* Back link */}
          <a
            href="/"
            className="relative mt-8 text-sm text-emerald-400/70 hover:text-emerald-400 transition-colors"
          >
            ← Back to Home
          </a>
        </div>
      </div>
    </div>
  )
}
