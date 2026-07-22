"use client"

import { useState } from "react"
import Navigation from "@/components/navigation"
import GitHubSection from "@/components/github-section"
import TerminalLog from "@/components/terminal-log"
import { Star, Github } from "lucide-react"
import { motion } from "motion/react"

export default function Home() {
  const [githubConnected, setGithubConnected] = useState(false)
  const [githubUsername, setGithubUsername] = useState<string | null>(null)

  const handleStatusResolved = (connected: boolean, username?: string | null) => {
    setGithubConnected(connected)
    setGithubUsername(username ?? null)
  }

  return (
    <div className="h-screen w-full flex flex-col bg-[#111111] text-white overflow-hidden selection:bg-acid-green/30 font-sans">
      <Navigation />

      {/* Mobile: vertical scroll stack | Desktop: 2-col grid */}
      <main className="flex-1 min-h-0 relative flex flex-col overflow-y-auto md:overflow-hidden md:grid md:grid-cols-2 md:grid-rows-[1.3fr_1fr]">

        {/* Section 1: Headline — mobile order 1, desktop: top-left */}
        <section className="order-1 p-[clamp(1rem,3vw,5rem)] max-md:px-6 max-md:pt-10 max-md:pb-10 flex flex-col justify-end max-md:justify-start relative md:border-r border-white/15">
          <div className="z-20">
            <motion.h1
              initial={{ opacity: 0, y: 40 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8, ease: "circOut", delay: 0.4 }}
              className="font-mono text-[clamp(3rem,12vw,9rem)] md:text-[clamp(2.5rem,min(8vw,14vh),9rem)] leading-[0.85] font-black tracking-tighter uppercase mb-4 md:mb-[clamp(1rem,2vh,2rem)]"
            >
              Scale<br />Without<br />Breaking.
            </motion.h1>
            <motion.p
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8, ease: "circOut", delay: 0.6 }}
              className="max-w-md text-white/60 text-sm md:text-[clamp(0.65rem,1.5vw,0.75rem)] leading-relaxed"
            >
              Intelligent analysis and automated fixes for your business&apos;s scalability challenges.
              Find your bottlenecks before they find you.
            </motion.p>
          </div>
        </section>

        {/* Section 2: GitHub Connection — mobile order 2, desktop: bottom row spanning 2 cols */}
        <section className="order-2 md:order-3 col-span-1 md:col-span-2 pt-8 pb-4 md:pt-6 md:pb-2 flex flex-col items-center justify-center relative border-t border-white/15 min-h-[350px] md:min-h-0" id="github-section">
            <div className="w-full flex-1 min-h-0 flex items-center justify-center"><GitHubSection onStatusResolved={handleStatusResolved}/></div>

          {/* Open Source Star Banner */}
          <a
            href="https://github.com/Deepanshu-024/GROWISE"
            target="_blank"
            rel="noopener noreferrer"
            className="max-md:my-4 max-md:relative max-md:translate-y-0 md:absolute md:top-0 md:left-0 md:w-full md:-translate-y-1/2 w-full z-30 bg-[#111111] py-1.5 px-4 border-y border-white/15 flex items-center justify-center gap-2 font-mono text-xs uppercase tracking-widest group/banner hover:border-acid-green/40 transition-colors cursor-pointer"
          >
            <Star className="w-3.5 h-3.5 fill-acid-green text-acid-green" />
            <span className="text-white/80 group-hover/banner:text-acid-green transition-colors">
              We are open source — Star us on GitHub
            </span>
          </a>
        </section>

        {/* Section 3: Terminal Log — mobile order 3, desktop: top-right */}
        <section className="order-3 md:order-2 p-6 md:p-8 flex flex-col justify-center md:overflow-hidden min-h-[40vh] md:min-h-0 border-t md:border-t-0 border-white/15">
          <TerminalLog />
        </section>
      </main>

      {/* Footer */}
      <footer className="shrink-0 border-t border-white/15">
        <div className="h-8 px-4 md:px-12 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.15em] relative">
          {/* Left: Copyright */}
          <span className="text-white/20">© GRO(w)ISE 2026 All Rights Reserved</span>

          {/* Center: Connected Status — only shown when connected */}
          {githubConnected && githubUsername && (
            <div className="hidden sm:flex absolute left-1/2 -translate-x-1/2 items-center gap-2">
              <div className="w-1.5 h-1.5 rounded-full animate-pulse bg-acid-green" />
              <span className="text-white/40">
                Connected as <span className="text-acid-green font-medium">@{githubUsername}</span>
              </span>
            </div>
          )}

          {/* Right: Socials */}
          <a
            href="https://github.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-white/20 hover:text-acid-green transition-colors"
          >
            <Github className="w-3.5 h-3.5" />
          </a>
        </div>
      </footer>
    </div>
  )
}
