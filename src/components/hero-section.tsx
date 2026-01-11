"use client"

interface HeroSectionProps {
  headline: string
  subheadline: string
}

export default function HeroSection({ headline, subheadline }: HeroSectionProps) {
  return (
    <div className="w-full text-center mb-12 sm:mb-16 animate-fade-in">
      <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold mb-4 sm:mb-6 leading-tight text-balance bg-gradient-to-b from-white to-white/90 bg-clip-text text-transparent">
        {headline}
      </h1>
      <p className="text-lg sm:text-xl text-white/80 max-w-2xl mx-auto text-balance leading-relaxed">{subheadline}</p>
    </div>
  )
}
