"use client"

import { useState } from "react"
import Navigation from "@/components/navigation"
import GitHubSection from "@/components/github-section"
import { LampContainer } from "@/components/ui/lamp"
import { motion } from "motion/react"

export default function Home() {
  const [githubConnected, setGithubConnected] = useState(false)

  return (
    <div className="max-h-screen flex flex-col bg-slate-950 text-foreground overflow-hidden">
      <Navigation />

      {/* pt-6 pushes the lamp below the fixed navbar */}
      <div className="pt-5">
        <LampContainer>
          {/* Headline — appears first with the lamp */}
          <motion.div
            initial={{ opacity: 0, y: 100 }}
            whileInView={{ opacity: 1, y: -10 }}
            transition={{
              delay: 0.3,
              duration: 0.8,
              ease: "easeInOut",
            }}
            className="w-full max-w-4xl flex flex-col items-center px-4"
          >
            <h1 className="text-3xl sm:text-5xl lg:text-6xl font-bold mb-5 sm:mb-6 leading-tight bg-gradient-to-b from-white to-white/90 bg-clip-text text-transparent text-center">
              Scale your business <br /> with confidence
            </h1>
          </motion.div>

          {/* Subheadline — shrinks when GitHub is connected */}
          <motion.p
            initial={{ opacity: 0, y: 10 }}
            whileInView={{ opacity: 1, y: 0 }}
            transition={{
              delay: 1,
              duration: 0.6,
              ease: "easeInOut",
            }}
            className={`mx-auto text-balance leading-relaxed text-center transition-all duration-500 ${githubConnected
                ? "text-base sm:text-lg text-white/60 max-w-md mb-12 sm:mb-[68px]"
                : "text-lg sm:text-xl text-white/80 max-w-2xl mb-10 sm:mb-16"
              }`}
          >
            Intelligent analysis and automated fixes for your business&apos;s scalability challenges.
          </motion.p>

          {/* GitHub Section — replaces the old Import button */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: -30 }}
            transition={{
              delay: 1.4,
              duration: 0.6,
              ease: "easeInOut",
            }}
            className="w-full max-w-4xl px-4 flex items-start justify-center h-14 overflow-visible"
          >
            <GitHubSection onStatusResolved={setGithubConnected} />
          </motion.div>
        </LampContainer>
      </div>
    </div>
  )
}
