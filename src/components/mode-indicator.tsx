"use client"

import { ChevronLeft, ChevronRight } from "lucide-react"

interface ModeIndicatorProps {
  currentMode: number
  totalModes: number
  modeTitle: string
  onPrevious: () => void
  onNext: () => void
}

export default function ModeIndicator({ currentMode, totalModes, modeTitle, onPrevious, onNext }: ModeIndicatorProps) {
  return (
    <div className="w-full flex items-center justify-between mb-8 sm:mb-12 px-2">
      <button
        onClick={onPrevious}
        className="p-2 hover:bg-card hover:glow-green-sm rounded-full transition-all duration-300 group -ml-4 sm:-ml-8 md:-ml-12"
        aria-label="Previous mode"
      >
        <ChevronLeft className="w-5 h-5 text-muted-foreground group-hover:text-[#22c55e] transition-colors" />
      </button>

      <div className="flex flex-col items-center gap-3 flex-1 mx-8 sm:mx-12 md:mx-16">
        <p className="text-sm text-muted-foreground font-medium uppercase tracking-wide">{modeTitle}</p>
        <div className="flex gap-2">
          {Array.from({ length: totalModes }).map((_, i) => (
            <div
              key={i}
              className={`h-2 transition-all duration-300 rounded-full ${
                i === currentMode
                  ? "bg-[#22c55e] w-8 shadow-[0_0_15px_rgba(34,197,94,0.6)]"
                  : "bg-muted w-2 hover:bg-[#22c55e]/50"
              }`}
            />
          ))}
        </div>
      </div>

      <button
        onClick={onNext}
        className="p-2 hover:bg-card hover:glow-green-sm rounded-full transition-all duration-300 group -mr-4 sm:-mr-8 md:-mr-12"
        aria-label="Next mode"
      >
        <ChevronRight className="w-5 h-5 text-muted-foreground group-hover:text-[#22c55e] transition-colors" />
      </button>
    </div>
  )
}
