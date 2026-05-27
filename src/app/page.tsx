"use client"

import Navigation from "@/components/navigation"
import PromptInput from "@/components/prompt-input"
import { LampContainer } from "@/components/ui/lamp"
import { motion } from "motion/react"

export default function Home() {
  return (
    <div className="max-h-screen flex flex-col bg-slate-950 text-foreground overflow-hidden">
      <Navigation />

      {/* pt-16 pushes the lamp below the fixed 4rem/64px navbar */}
      <div className="pt-12">
        <LampContainer>
          {/* Headline — appears first with the lamp */}
          <motion.div
            initial={{ opacity: 0, y: 100 }}
            whileInView={{ opacity: 1, y: 0 }}
            transition={{
              delay: 0.3,
              duration: 0.8,
              ease: "easeInOut",
            }}
            className="w-full max-w-4xl flex flex-col items-center px-4"
          >
            <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold mb-4 sm:mb-6 leading-tight text-balance bg-gradient-to-b from-white to-white/90 bg-clip-text text-transparent text-center">
              Scale your business with confidence
            </h1>
          </motion.div>

          {/* Subheadline — appears after a delay */}
          <motion.p
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            transition={{
              delay: 1,
              duration: 0.6,
              ease: "easeInOut",
            }}
            className="text-lg sm:text-xl text-white/80 max-w-2xl mx-auto text-balance leading-relaxed text-center mb-12 sm:mb-16"
          >
            Intelligent analysis and automated fixes for your business&apos;s scalability challenges.
          </motion.p>

          {/* Prompt Input — appears last */}
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            transition={{
              delay: 1.4,
              duration: 0.6,
              ease: "easeInOut",
            }}
            className="w-full max-w-4xl px-4"
          >
            <PromptInput
              placeholder="Paste your GitHub repo URL or describe your codebase..."
              buttonText="Analyze Codebase"
              mode="codebase"
            />
          </motion.div>
        </LampContainer>
      </div>
    </div>
  )
}
