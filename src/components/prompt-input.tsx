"use client"

import type React from "react"

import { useState } from "react"
import { ArrowRight } from "lucide-react"

interface PromptInputProps {
  placeholder: string
  buttonText: string
  mode: string
}

export default function PromptInput({ placeholder, buttonText, mode }: PromptInputProps) {
  const [inputValue, setInputValue] = useState("")
  const [isFocused, setIsFocused] = useState(false)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    console.log(`[${mode}] Submitted:`, inputValue)
    // Handle submission logic here
  }

  const secondaryButtonText =
    mode === "brand" ? "Import Company Website" : mode === "codebase" ? "Import GitHub Repository" : null

  return (
    <div className="w-full max-w-3xl">
      {/* Main Input */}
      <form onSubmit={handleSubmit} className="mb-4">
        <div className="relative group">
          <div
            className={`absolute inset-0 rounded-2xl blur-xl transition-all duration-300 ${
              isFocused
                ? "bg-[#22c55e]/30 opacity-100"
                : "bg-gradient-to-r from-[#22c55e]/20 to-[#22c55e]/10 opacity-0 group-hover:opacity-100"
            }`}
          />

          <div
            className={`relative flex items-center gap-3 bg-card border rounded-2xl p-1 pr-3 transition-all duration-300 ${
              isFocused
                ? "border-[#22c55e]/60 shadow-[inset_0_0_20px_rgba(34,197,94,0.15),0_0_20px_rgba(34,197,94,0.3)]"
                : "border-[#22c55e]/30 hover:border-[#22c55e]/50"
            }`}
          >
            <input
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onFocus={() => setIsFocused(true)}
              onBlur={() => setIsFocused(false)}
              placeholder={placeholder}
              className="flex-1 bg-transparent border-none outline-none px-4 py-4 sm:py-5 text-foreground placeholder:text-muted-foreground text-base sm:text-lg"
            />

            <button
              type="submit"
              className="shrink-0 px-4 sm:px-6 py-2.5 sm:py-3 bg-[#22c55e] text-black hover:shadow-[0_0_25px_rgba(34,197,94,0.6)] transition-all duration-200 rounded-xl font-medium font-semibold flex items-center gap-2 whitespace-nowrap text-sm sm:text-base"
            >
              {buttonText}
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </form>

      {/* Secondary Action */}
      {secondaryButtonText && (
        <div className="flex items-center justify-center gap-4">
          <div className="h-px bg-[#22c55e]/30 flex-1" />
          <span className="text-xs text-muted-foreground uppercase tracking-wide">OR</span>
          <div className="h-px bg-[#22c55e]/30 flex-1" />
        </div>
      )}

      {secondaryButtonText && (
        <button className="w-full mt-4 px-6 py-3 border border-[#22c55e]/40 hover:border-[#22c55e]/70 hover:shadow-[0_0_15px_rgba(34,197,94,0.3)] text-muted-foreground hover:text-[#22c55e] transition-all duration-200 rounded-xl font-medium text-sm bg-transparent hover:bg-[#22c55e]/5">
          {secondaryButtonText}
        </button>
      )}
    </div>
  )
}
