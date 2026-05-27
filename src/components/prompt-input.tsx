"use client"

import type React from "react"

import { useState, useEffect } from "react"
import { ArrowRight, Github } from "lucide-react"
import { GitHubRepositorySelector } from "./github-repository-selector"
import { toast } from "sonner"

interface PromptInputProps {
  placeholder: string
  buttonText: string
  mode: string
}

export default function PromptInput({ placeholder, buttonText, mode }: PromptInputProps) {
  const [inputValue, setInputValue] = useState("")
  const [isFocused, setIsFocused] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [showRepoSelector, setShowRepoSelector] = useState(false)
  const [githubConnected, setGithubConnected] = useState(false)
  const [githubUsername, setGithubUsername] = useState<string | null>(null)
  const [checkingGithub, setCheckingGithub] = useState(true)
  const [disconnecting, setDisconnecting] = useState(false)

  useEffect(() => {
    checkGitHubStatus()
  }, [])

  const checkGitHubStatus = async () => {
    try {
      setCheckingGithub(true)
      const response = await fetch("/api/github/status")
      if (response.ok) {
        const data = await response.json()
        setGithubConnected(data.connected)
        setGithubUsername(data.username ?? null)
      }
    } catch (error) {
      console.error("Error checking GitHub status:", error)
    } finally {
      setCheckingGithub(false)
    }
  }

  const handleConnect = () => {
    window.location.href = "/api/github/install"
  }

  const handleDisconnect = async () => {
    try {
      setDisconnecting(true)
      const response = await fetch("/api/github/disconnect", { method: "POST" })
      if (!response.ok) throw new Error("Failed to disconnect")
      toast.success("GitHub account disconnected")
      setGithubConnected(false)
      setGithubUsername(null)
    } catch (error) {
      console.error("Error disconnecting GitHub:", error)
      toast.error("Failed to disconnect GitHub account")
    } finally {
      setDisconnecting(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (inputValue.trim()) {
      setIsLoading(true)
      try {
        console.log(`[codebase] Submitted:`, inputValue)
        // TODO: Handle codebase URL analysis
      } catch (error) {
        console.error("Unexpected error:", error)
      } finally {
        setIsLoading(false)
      }
    }
  }

  const handleImportRepository = () => {
    if (!githubConnected) {
      handleConnect()
      return
    }
    setShowRepoSelector(true)
  }

  const handleSelectRepository = (repository: any) => {
    console.log("Selected repository:", repository)
    toast.success(`Selected repository: ${repository.fullName}`)
    // TODO: Implement repository analysis logic
  }

  return (
    <div className="w-full max-w-3xl">

      {/* Main Input */}
      {/* <form onSubmit={handleSubmit} className="mb-4">
        <div className="relative group">
          <div
            className={`absolute inset-0 rounded-2xl blur-xl transition-all duration-300 ${isFocused
                ? "bg-[#22c55e]/30 opacity-100"
                : "bg-linear-to-r from-[#22c55e]/20 to-[#22c55e]/10 opacity-0 group-hover:opacity-100"
              }`}
          />

          <div
            className={`relative flex items-center gap-3 bg-card border rounded-2xl p-1 pr-3 transition-all duration-300 ${isFocused
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
              disabled={isLoading || !inputValue.trim()}
              className="shrink-0 px-4 sm:px-6 py-2.5 sm:py-3 bg-[#22c55e] text-black hover:shadow-[0_0_25px_rgba(34,197,94,0.6)] transition-all duration-200 rounded-xl font-semibold flex items-center gap-2 whitespace-nowrap text-sm sm:text-base disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isLoading ? "Analyzing..." : buttonText}
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </form> */}

      {/* OR Divider */}
      {/* <div className="flex items-center justify-center gap-4">
        <div className="h-px bg-[#22c55e]/30 flex-1" />
        <span className="text-xs text-muted-foreground uppercase tracking-wide">OR</span>
        <div className="h-px bg-[#22c55e]/30 flex-1" />
      </div> */}

      {/* Import Repository Button */}
      <button
        onClick={handleImportRepository}
        disabled={checkingGithub}
        className="w-full mt-4 px-6 py-3 border border-[#22c55e]/40 hover:border-[#22c55e]/70 hover:shadow-[0_0_15px_rgba(34,197,94,0.3)] text-muted-foreground hover:text-[#22c55e] transition-all duration-200 rounded-xl font-medium text-sm bg-transparent hover:bg-[#22c55e]/5 flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <Github className="w-4 h-4" />
        {githubConnected ? "Import GitHub Repository" : "Connect GitHub & Import Repository"}
      </button>

      <GitHubRepositorySelector
        open={showRepoSelector}
        onOpenChange={setShowRepoSelector}
        onSelectRepository={handleSelectRepository}
      />
    </div>
  )
}

