"use client"

import { useEffect, useState } from "react"
import { Command } from "lucide-react"
import { motion, AnimatePresence } from "motion/react"

const LOG_LINES = [
  "> Initialize scalabilty_engine_v2.0",
  "> Authenticating agent protocols...",
  "> Scanning codebase for revenue threats...",
  "> Detected 3 potential database bottlenecks",
  "> Analyzing architectural weaknesses...",
  "> Awaiting GitHub repository hook..."
];

export default function TerminalLog() {
  const [displayedLines, setDisplayedLines] = useState<string[]>([]);
  const [currentLineIndex, setCurrentLineIndex] = useState(0);

  useEffect(() => {
    if (currentLineIndex >= LOG_LINES.length) return;

    const timeout = setTimeout(() => {
      setDisplayedLines(prev => [...prev, LOG_LINES[currentLineIndex]]);
      setCurrentLineIndex(prev => prev + 1);
    }, 800);

    return () => clearTimeout(timeout);
  }, [currentLineIndex]);

  return (
    <div className="flex flex-col font-mono text-xs leading-relaxed overflow-hidden">
      <div className="mb-6 text-white/30 uppercase tracking-widest flex items-center gap-2">
        <Command className="w-3.5 h-3.5" />
        <span>System Log</span>
      </div>
      <div className="space-y-3">
        <AnimatePresence mode="popLayout">
          {displayedLines.map((line, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, x: -5 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.3 }}
              className="text-white/70"
            >
              {line}
            </motion.div>
          ))}
        </AnimatePresence>
        {currentLineIndex < LOG_LINES.length && (
          <div className="flex items-center gap-1">
            <span className="text-white/40">{"> "}</span>
            <motion.div
              animate={{ opacity: [1, 0] }}
              transition={{ repeat: Infinity, duration: 0.8 }}
              className="w-1.5 h-3 bg-acid-green"
            />
          </div>
        )}
      </div>
    </div>
  )
}
