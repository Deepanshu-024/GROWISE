"use client"

import { useState, useEffect } from "react"
import Navigation from "@/components/navigation"
import HeroSection from "@/components/hero-section"
import ModeIndicator from "@/components/mode-indicator"
import PromptInput from "@/components/prompt-input"

const modes = [
  {
    id: "content",
    title: "Independent Content Creation",
    headline: "Create content that actually sounds like you",
    subheadline: "Generate authentic content tailored to your unique voice and style.",
    placeholder: "Describe what you want to create...",
    buttonText: "Generate",
  },
  {
    id: "brand",
    title: "Company / Brand Content Generation",
    headline: "Engage your audience with on-brand intelligence",
    subheadline: "Maintain consistent brand voice across all your content initiatives.",
    placeholder: "Paste your company website URL or brand context...",
    buttonText: "Analyze Brand",
  },
  {
    id: "codebase",
    title: "Codebase Analysis (Dev Stage Brands)",
    headline: "Understand your codebase like never before",
    subheadline: "Intelligent analysis and insights for your development workflow.",
    placeholder: "Paste your GitHub repo URL or describe your codebase...",
    buttonText: "Analyze Codebase",
  },
]

export default function Home() {
  const [currentMode, setCurrentMode] = useState(0)
  const [isClient, setIsClient] = useState(false)

  useEffect(() => {
    setIsClient(true)
  }, [])

  const nextMode = () => {
    setCurrentMode((prev) => (prev + 1) % modes.length)
  }

  const prevMode = () => {
    setCurrentMode((prev) => (prev - 1 + modes.length) % modes.length)
  }

  if (!isClient) {
    return null
  }

  const activeMode = modes[currentMode]

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground overflow-hidden">
      <Navigation />

      <main className="flex-1 flex flex-col items-center px-4 py-8 sm:py-12">
        <div className="w-full max-w-4xl flex flex-col items-center">
          {/* Hero Section - Fixed top position */}
          <div className="w-full flex flex-col items-center mt-20 sm:mb-6">
            <HeroSection headline={activeMode.headline} subheadline={activeMode.subheadline} />
          </div>

          {/* Mode Switcher */}
          <ModeIndicator
            currentMode={currentMode}
            totalModes={modes.length}
            modeTitle={activeMode.title}
            onPrevious={prevMode}
            onNext={nextMode}
          />

          {/* Prompt Input */}
          <PromptInput placeholder={activeMode.placeholder} buttonText={activeMode.buttonText} mode={activeMode.id} />
        </div>
      </main>
    </div>
  )
}
