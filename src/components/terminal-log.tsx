"use client"

import { useEffect, useState, useCallback } from "react"
import {
  Command,
  Github,
  FolderGit2,
  ScanSearch,
  Network,
  Bot,
  FileBarChart,
  MessageSquare,
} from "lucide-react"
import { motion, AnimatePresence } from "motion/react"

/* ── Workflow Steps ─────────────────────────────────────────────────────────── */

interface WorkflowStep {
  id: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  description: string
}

const WORKFLOW_STEPS: WorkflowStep[] = [
  {
    id: "github",
    label: "auth_github_connect",
    icon: Github,
    description: "Sign in via Clerk, then connect the Growise GitHub App to grant read-only access to your repositories — secure OAuth, zero credentials stored.",
  },
  {
    id: "repo",
    label: "select_repository",
    icon: FolderGit2,
    description: "Pick the repository you want analyzed. We pull your repo list from the connected GitHub App — just select and go.",
  },
  {
    id: "framework",
    label: "detect_framework",
    icon: ScanSearch,
    description: "We scan your project to detect the framework in use. Currently supporting Next.js and React — if matched, a background job kicks off so you can close the browser.",
  },
  {
    id: "arch",
    label: "map_architecture",
    icon: Network,
    description: "Your codebase is parsed into a full dependency graph — routes, APIs, database layers, and services — then each detected archetype is assigned a specialized agent.",
  },
  {
    id: "agents",
    label: "run_agent_analysis",
    icon: Bot,
    description: "Specialized AI agents run in parallel, each analyzing a different archetype of your architecture. This deep analysis takes roughly 10 minutes to complete.",
  },
  {
    id: "report",
    label: "compile_scalability_report",
    icon: FileBarChart,
    description: "A final agent compiles all findings into a comprehensive scalability report — risk scores, bottlenecks, and actionable recommendations for high-traffic readiness.",
  },
  {
    id: "chatbot",
    label: "init_chatbot_interface",
    icon: MessageSquare,
    description: "Chat with an AI assistant about your report — ask questions, open GitHub issues directly, or generate step-by-step action plans to resolve identified risks.",
  },
]

const TYPING_DELAY = 600
const CYCLE_INTERVAL = 3000

/* ── Main Component ─────────────────────────────────────────────────────────── */

export default function TerminalLog() {
  const [typedCount, setTypedCount] = useState(0)
  const [activeStep, setActiveStep] = useState(0)
  const [phase, setPhase] = useState<"typing" | "cycling">("typing")
  const [hoveredStep, setHoveredStep] = useState<number | null>(null)

  // Phase 1: Type out log lines one by one
  useEffect(() => {
    if (phase !== "typing") return
    if (typedCount >= WORKFLOW_STEPS.length) {
      setPhase("cycling")
      setActiveStep(0)
      return
    }

    const timer = setTimeout(() => {
      setTypedCount(prev => prev + 1)
      setActiveStep(typedCount)
    }, TYPING_DELAY)

    return () => clearTimeout(timer)
  }, [typedCount, phase])

  // Phase 2: Cycle through steps
  useEffect(() => {
    if (phase !== "cycling") return
    if (hoveredStep !== null) return

    const timer = setInterval(() => {
      setActiveStep(prev => (prev + 1) % WORKFLOW_STEPS.length)
    }, CYCLE_INTERVAL)

    return () => clearInterval(timer)
  }, [phase, hoveredStep])

  const effectiveActive = hoveredStep !== null ? hoveredStep : activeStep

  const handleStepHover = useCallback((index: number | null) => {
    if (phase === "cycling") {
      setHoveredStep(index)
      if (index !== null) setActiveStep(index)
    }
  }, [phase])

  return (
    <div className="flex flex-col md:flex-row h-full font-mono text-xs leading-relaxed md:overflow-hidden gap-4 md:gap-2">
      {/* ── Left: Log Lines ───────────────────────────────────────── */}
      <div className="flex flex-col flex-1 min-w-0 justify-center">
        <div className="mb-4 text-white/30 uppercase tracking-widest flex items-center gap-2">
          <Command className="w-3.5 h-3.5" />
          <span>Pipeline</span>
        </div>

        <div className="flex flex-col gap-0.5">
          <AnimatePresence mode="popLayout">
            {WORKFLOW_STEPS.slice(0, typedCount).map((step, i) => {
              const isActive = i === effectiveActive && phase === "cycling"
              const isCompleted = phase === "cycling" && i < effectiveActive
              const isPending = phase === "cycling" && i > effectiveActive

              return (
                <motion.div
                  key={step.id}
                  initial={{ opacity: 0, x: -6 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.3 }}
                  className="flex flex-col"
                  onMouseEnter={() => handleStepHover(i)}
                  onMouseLeave={() => handleStepHover(null)}
                >
                  {/* Step row */}
                  <div className={`flex items-center gap-2 py-1 px-1 rounded-sm cursor-default transition-colors duration-200 ${
                    isActive
                      ? "text-acid-green"
                      : isCompleted
                        ? "text-acid-green/40"
                        : isPending
                          ? "text-white/20"
                          : "text-white/50"
                  }`}>
                    <span className="w-5 text-center shrink-0 text-sm">
                      {phase === "typing" ? (
                        <span className="text-white/40">&gt;</span>
                      ) : isActive ? (
                        <motion.span
                          animate={{ opacity: [1, 0.3] }}
                          transition={{ repeat: Infinity, duration: 0.8 }}
                          className="text-acid-green"
                        >
                          ▸
                        </motion.span>
                      ) : isCompleted ? (
                        <span className="text-acid-green/50">//</span>
                      ) : (
                        <span className="text-white/15">//</span>
                      )}
                    </span>
                    <span className={`truncate text-[11px] font-bold tracking-tight ${
                      isActive ? "text-acid-green" : ""
                    }`}>
                      {step.label}
                    </span>
                  </div>

                  {/* Mobile inline description — shown below the active step */}
                  {isActive && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.25, ease: "circOut" }}
                      className="md:hidden ml-7 mt-1 mb-2 border-l-2 border-acid-green/20 pl-3"
                    >
                      <p className="text-[11px] text-white/40 leading-relaxed">
                        {step.description}
                      </p>
                    </motion.div>
                  )}
                </motion.div>
              )
            })}
          </AnimatePresence>

          {phase === "typing" && typedCount < WORKFLOW_STEPS.length && (
            <div className="flex items-center gap-1.5 py-0.5 px-1">
              <span className="w-4 text-center text-white/40">&gt;</span>
              <motion.div
                animate={{ opacity: [1, 0] }}
                transition={{ repeat: Infinity, duration: 0.8 }}
                className="w-1.5 h-3 bg-acid-green"
              />
            </div>
          )}
        </div>
      </div>

      {/* ── Right: Description Box (desktop only) ─────────────────── */}
      <div className="hidden md:flex w-[65%] shrink-0 flex-col pr-16">
        <div className="flex-1 border border-white/[0.06] bg-white/[0.015] rounded-sm p-3 flex items-center">
          <AnimatePresence mode="wait">
            {typedCount > 0 && (
              <motion.div
                key={effectiveActive}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.25, ease: "circOut" }}
                className="w-full"
              >
                <div className="flex items-center gap-2 mb-2">
                  {(() => {
                    const StepIcon = WORKFLOW_STEPS[effectiveActive].icon
                    return <StepIcon className="w-3.5 h-3.5 text-acid-green/60" />
                  })()}
                  <span className="text-[10px] font-bold text-white/50 uppercase tracking-widest">
                    {WORKFLOW_STEPS[effectiveActive].label}
                  </span>
                </div>
                <p className="text-[11px] text-white/40 leading-relaxed">
                  {WORKFLOW_STEPS[effectiveActive].description}
                </p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}
