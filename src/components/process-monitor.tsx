"use client"

import { useEffect, useState } from "react"
import { motion, AnimatePresence } from "motion/react"

interface Step {
  id: string
  label: string
  status: "pending" | "active" | "done"
  details: string
}

const INITIAL_STEPS: Step[] = [
  { id: "01", label: "CODEBASE_INGESTION", status: "pending", details: "SYNCING_REMOTE_TREE" },
  { id: "02", label: "AGENT_ORCHESTRATION", status: "pending", details: "INIT_LLM_PROTOCOLS" },
  { id: "03", label: "RISK_HEURISTICS", status: "pending", details: "DETECTING_BOTTLENECKS" },
  { id: "04", label: "FIX_SYNTHESIS", status: "pending", details: "RESOLVING_TECHNICAL_DEBT" },
  { id: "05", label: "REPORT_ARTIFACTS", status: "pending", details: "UPDATING_ANALYTICS_DB" },
]

export default function ProcessMonitor() {
  const [steps, setSteps] = useState<Step[]>(INITIAL_STEPS)

  useEffect(() => {
    let currentStep = 0
    
    const interval = setInterval(() => {
      setSteps(prev => 
        prev.map((step, idx) => {
          if (idx < currentStep) return { ...step, status: "done" }
          if (idx === currentStep) return { ...step, status: "active" }
          return step
        })
      )
      
      currentStep++
      if (currentStep > INITIAL_STEPS.length) {
        // After all done, restart after a delay
        setTimeout(() => {
          currentStep = 0
          setSteps(INITIAL_STEPS)
        }, 5000)
        clearInterval(interval)
      }
    }, 3000)

    return () => clearInterval(interval)
  }, [])

  return (
    <div className="flex flex-col gap-5 font-mono max-w-lg w-full">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 text-white/30 uppercase tracking-[0.25em] text-[9px]">
          <div className="w-1.5 h-1.5 rounded-full bg-acid-green animate-pulse" />
          System_Analysis_Active
        </div>
        <div className="text-[9px] text-white/20 uppercase tracking-widest">
          Node_ID: 0xFF92A
        </div>
      </div>
      
      {steps.map((step, idx) => (
        <motion.div
          key={step.id}
          initial={{ opacity: 0, x: 10 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: idx * 0.1, duration: 0.5 }}
          className={`relative group flex flex-col gap-3 p-4 border border-white/5 bg-white/[0.01] overflow-hidden transition-all duration-700 ${
            step.status === "active" ? "border-acid-green/30 bg-acid-green/[0.02] shadow-[0_0_20px_rgba(163,230,53,0.03)]" : ""
          }`}
        >
          {/* Active Accent Bar */}
          {step.status === "active" && (
            <motion.div 
              layoutId="active-bar"
              className="absolute left-0 top-0 bottom-0 w-1 bg-acid-green"
            />
          )}

          <div className="flex items-center justify-between z-10">
            <div className="flex items-center gap-3">
              <span className={`text-[10px] tabular-nums ${step.status === "active" ? "text-acid-green" : "text-white/20"}`}>
                {step.id}
              </span>
              <span className={`text-[11px] font-black tracking-tight ${
                step.status === "done" ? "text-white/40" : step.status === "active" ? "text-white" : "text-white/60"
              }`}>
                {step.label}
              </span>
            </div>
            
            <AnimatePresence mode="wait">
              {step.status === "active" ? (
                <motion.span 
                  key="status-active"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="text-[9px] text-acid-green font-bold tracking-widest flex items-center gap-2"
                >
                  <span className="w-1 h-1 bg-acid-green rounded-full animate-ping" />
                  ANALYZING
                </motion.span>
              ) : step.status === "done" ? (
                <motion.span 
                  key="status-done"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="text-[9px] text-acid-green/50 font-bold tracking-widest"
                >
                  COMPLETE
                </motion.span>
              ) : (
                <span className="text-[9px] text-white/10 font-bold tracking-widest">PENDING</span>
              )}
            </AnimatePresence>
          </div>

          <div className="flex items-center gap-4 z-10">
            <div className="flex-1 h-[2px] bg-white/[0.03] rounded-full overflow-hidden">
              {step.status === "active" && (
                <motion.div
                  initial={{ x: "-100%" }}
                  animate={{ x: "0%" }}
                  transition={{ duration: 3, ease: "easeInOut" }}
                  className="h-full bg-acid-green shadow-[0_0_8px_rgba(163,230,53,0.5)]"
                />
              )}
              {step.status === "done" && (
                <div className="h-full w-full bg-acid-green/10" />
              )}
            </div>
            <span className={`text-[9px] lowercase tracking-tight transition-colors duration-500 ${
              step.status === "active" ? "text-acid-green/60" : "text-white/20"
            }`}>
              {step.details}
            </span>
          </div>
          
          {/* Scanning Line Effect for Active Step */}
          {step.status === "active" && (
            <motion.div 
              initial={{ top: "-100%" }}
              animate={{ top: "200%" }}
              transition={{ duration: 1.5, repeat: Infinity, ease: "linear" }}
              className="absolute left-0 right-0 h-10 bg-gradient-to-b from-transparent via-acid-green/[0.03] to-transparent pointer-events-none"
            />
          )}
        </motion.div>
      ))}

      <div className="mt-4 p-4 border border-dashed border-white/10 flex items-center justify-between text-[10px] text-white/30">
        <span className="flex items-center gap-2">
          <span className="w-1 h-1 bg-white/20 rounded-full" />
          AGENT_HEARTBEAT
        </span>
        <span className="tabular-nums">24 ms_latency</span>
      </div>
    </div>
  )
}
