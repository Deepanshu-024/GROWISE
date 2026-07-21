"use client"

import { useState } from "react"
import Navigation from "@/components/navigation"
import GitHubSection from "@/components/github-section"
import TerminalLog from "@/components/terminal-log"
import { motion } from "motion/react"

export default function Home() {
  const [githubConnected, setGithubConnected] = useState(false)

  return (
    <div className="h-screen w-full flex flex-col bg-[#111111] text-white overflow-hidden selection:bg-acid-green/30 font-sans">
      <Navigation />

      <main className="flex-1 relative grid grid-cols-1 md:grid-cols-2 grid-rows-[auto_1fr_auto] md:grid-rows-[60vh_auto]">
        {/* Grid Lines Overlay - Now relative to main for perfect alignment */}
        <div className="absolute inset-0 pointer-events-none z-10">
          <motion.div
            initial={{ scaleX: 0 }}
            animate={{ scaleX: 1 }}
            transition={{ duration: 0.8, ease: "circOut" }}
            className="absolute top-[60vh] left-0 w-full h-[1px] bg-white/15 origin-left"
          />
          <motion.div
            initial={{ scaleY: 0 }}
            animate={{ scaleY: 1 }}
            transition={{ duration: 0.8, ease: "circOut", delay: 0.2 }}
            className="absolute top-0 left-1/2 w-[1px] h-[60vh] bg-white/15 origin-top"
          />
        </div>

        {/* Top Left: Headline */}
        <section className="p-[clamp(1rem,3vw,5rem)] flex flex-col justify-end relative overflow-hidden">
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
        <section className="p-8 md:p-20 flex flex-col">
          <TerminalLog />
        </section>

        {/* Bottom Row: GitHub Connection */}
        <section className="col-span-1 md:col-span-2 py-16 md:py-24 flex flex-col items-center justify-center relative acid-sweep group cursor-pointer border-t border-white/15" id="github-section">
          <GitHubSection onStatusResolved={setGithubConnected} />

          {/* Ornamental Crosshair */}
          <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 z-30 bg-[#111111] px-3 py-1.5 border border-white/15 group-hover:bg-acid-green group-hover:border-[#111111]/20 transition-colors">
            <span className="text-xs font-mono group-hover:text-black transition-colors">+</span>
          </div>
        </section>
      </main>

      {/* Viewport Ornaments */}
      <div className="absolute bottom-8 right-8 font-mono text-[10px] text-white/20 uppercase tracking-widest z-30">
        v1.0.4 // Carbon-Acid Interface
      </div>
    </div>
  )
}
