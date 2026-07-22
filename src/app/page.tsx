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

      <main className="flex-1 min-h-0 relative grid grid-cols-1 md:grid-cols-2 grid-rows-[auto_1fr_auto] md:grid-rows-[1.3fr_1fr] overflow-hidden">
        {/* Top Left: Headline */}
        <section className="p-[clamp(1rem,3vw,5rem)] flex flex-col justify-end relative md:border-r border-white/15">
          <div className="z-20">
            <motion.h1
              initial={{ opacity: 0, y: 40 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8, ease: "circOut", delay: 0.4 }}
              className="font-mono text-[clamp(2.5rem,min(8vw,14vh),9rem)] leading-[0.85] font-black tracking-tighter uppercase mb-[clamp(1rem,2vh,2rem)]"
            >
              Scale<br />Without<br />Breaking.
            </motion.h1>
            <motion.p
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8, ease: "circOut", delay: 0.6 }}
              className="max-w-md text-white/60 text-[clamp(0.5rem,1.5vw,0.75rem)] leading-relaxed"
            >
              Intelligent analysis and automated fixes for your business&apos;s scalability challenges.
              Find your bottlenecks before they find you.
            </motion.p>
          </div>
        </section>

        {/* Top Right: Terminal Log */}
        <section className="p-4 md:p-8 flex flex-col justify-center overflow-hidden">
          <TerminalLog />
        </section>

        {/* Bottom Row: GitHub Connection */}
        <section className="col-span-1 md:col-span-2 pt-6 pb-2 flex flex-col items-center justify-center relative border-t border-white/15 min-h-0" id="github-section">
            <div className="w-full flex-1 min-h-0 flex items-center justify-center"><GitHubSection onStatusResolved={handleStatusResolved}/></div>

          {/* Open Source Star Banner */}
          <div className="absolute top-0 left-0 w-full -translate-y-1/2 z-30 bg-[#111111] py-1.5 px-4 border-y border-white/15 flex items-center justify-center gap-2 font-mono text-xs uppercase tracking-widest group/banner hover:border-acid-green/40 transition-colors">
            <Star className="w-3.5 h-3.5 fill-acid-green text-acid-green" />
            <span className="text-white/80 group-hover/banner:text-acid-green transition-colors">
              We are open source — Star us on GitHub
            </span>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="shrink-0 border-t border-white/15">
        <div className="h-8 px-12 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.15em]">
          {/* Left: Copyright */}
          <span className="text-white/20">© 2026 All Rights Reserved</span>

          {/* Center: Connected Status */}
          <div className="absolute left-1/2 -translate-x-1/2 flex items-center gap-2">
            {githubConnected && githubUsername ? (
              <>
                <div className="w-1.5 h-1.5 rounded-full animate-pulse bg-acid-green" />
                <span className="text-white/40">
                  Connected as <span className="text-acid-green font-medium">@{githubUsername}</span>
                </span>
              </>
            ) : (
              <>
                <div className="w-1.5 h-1.5 rounded-full bg-white/20" />
                <span className="text-white/20">Not Connected</span>
              </>
            )}
          </div>

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
