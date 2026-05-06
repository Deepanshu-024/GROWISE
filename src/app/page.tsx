"use client"

import Navigation from "@/components/navigation"
import HeroSection from "@/components/hero-section"
import PromptInput from "@/components/prompt-input"

export default function Home() {
  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground overflow-hidden">
      <Navigation />

      <main className="flex-1 flex flex-col items-center px-4 py-8 sm:py-12">
        <div className="w-full max-w-4xl flex flex-col items-center">
          {/* Hero Section */}
          <div className="w-full flex flex-col items-center mt-20 sm:mb-6">
            <HeroSection
              headline="Understand your codebase like never before"
              subheadline="Intelligent analysis and insights for your development workflow."
            />
          </div>

          {/* Prompt Input */}
          <PromptInput
            placeholder="Paste your GitHub repo URL or describe your codebase..."
            buttonText="Analyze Codebase"
            mode="codebase"
          />
        </div>
      </main>
    </div>
  )
}
