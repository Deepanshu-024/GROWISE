"use client"

import { useState, useEffect } from "react"
import { Github, Lock, Globe, Plus, Loader2, ChevronRight, Zap } from "lucide-react"
import { useRouter } from "next/navigation"
import { useUser, useClerk } from "@clerk/nextjs"
import { toast } from "sonner"
import { triggerWorkflow } from "../../actions/trigger-workflow"

interface Repository {
  id: number
  name: string
  fullName: string
  private: boolean
  description: string | null
  url: string
}

interface GitHubSectionProps {
  /** Called when GitHub status is resolved so the parent can react */
  onStatusResolved?: (connected: boolean) => void
}

export default function GitHubSection({ onStatusResolved }: GitHubSectionProps) {
  const router = useRouter()
  const { isSignedIn, isLoaded: isAuthLoaded } = useUser()
  const { openSignUp } = useClerk()
  const [checkingGithub, setCheckingGithub] = useState(true)
  const [githubConnected, setGithubConnected] = useState(false)
  const [githubUsername, setGithubUsername] = useState<string | null>(null)
  const [repositories, setRepositories] = useState<Repository[]>([])
  const [loadingRepos, setLoadingRepos] = useState(false)

  // Analysis state
  const [analyzingRepoId, setAnalyzingRepoId] = useState<number | null>(null)

  useEffect(() => {
    if (!isAuthLoaded) return

    if (!isSignedIn) {
      // User logged out — reset everything
      setGithubConnected(false)
      setGithubUsername(null)
      setRepositories([])
      setCheckingGithub(false)
      onStatusResolved?.(false)
      return
    }

    checkGitHubStatus()
  }, [isSignedIn, isAuthLoaded])

  const checkGitHubStatus = async () => {
    try {
      setCheckingGithub(true)
      const response = await fetch("/api/github/status")
      if (response.ok) {
        const data = await response.json()
        setGithubConnected(data.connected)
        setGithubUsername(data.username ?? null)
        onStatusResolved?.(data.connected)

        if (data.connected) {
          fetchRepositories()
        }
      } else {
        onStatusResolved?.(false)
      }
    } catch (error) {
      console.error("Error checking GitHub status:", error)
      onStatusResolved?.(false)
    } finally {
      setCheckingGithub(false)
    }
  }

  const fetchRepositories = async () => {
    try {
      setLoadingRepos(true)
      const response = await fetch("/api/github/repositories")
      if (response.ok) {
        const data = await response.json()
        setRepositories(data.repositories)
      }
    } catch (error) {
      console.error("Error fetching repositories:", error)
    } finally {
      setLoadingRepos(false)
    }
  }

  const handleConnect = () => {
    if (!isAuthLoaded) return
    if (!isSignedIn) {
      openSignUp({ redirectUrl: "/dashboard" })
      return
    }
    window.location.href = "/api/github/install"
  }

  const handleRepoClick = (repo: Repository) => {
    router.push(`/project/${repo.id}`)
  }

  const handleAnalyze = async (repo: Repository, e: React.MouseEvent) => {
    e.stopPropagation()
    if (analyzingRepoId) return

    setAnalyzingRepoId(repo.id)
    toast.info("Starting analysis pipeline…")

    try {
      const result = await triggerWorkflow(repo.id.toString(), repo.fullName)

      if (!result.success) {
        toast.error("Analysis failed", { description: result.error })
        return
      }

      toast.success(
        `Analysis complete — ${result.completedAgents}/${result.totalAgents} agents`,
      )
      router.push(`/project/${repo.id}`)
    } catch (error) {
      console.error("Analysis pipeline error:", error)
      toast.error("Analysis failed", {
        description: error instanceof Error ? error.message : "Unknown error",
      })
    } finally {
      setAnalyzingRepoId(null)
    }
  }

  // ── Loading State ─────────────────────────────────────────────────────────
  if (checkingGithub) {
    return (
      <div className="w-full flex items-center justify-center py-4">
        <Loader2 className="w-5 h-5 animate-spin text-emerald-400/60" />
      </div>
    )
  }

  // ── State 1: GitHub NOT Connected — show the same button as before ────────
  if (!githubConnected) {
    return (
      <button
        onClick={handleConnect}
        className="w-2/3 mt-4 px-6 py-3 border border-[#22c55e]/40 hover:border-[#22c55e]/70 hover:shadow-[0_0_15px_rgba(34,197,94,0.3)] text-muted-foreground hover:text-[#22c55e] transition-all duration-200 rounded-xl font-medium text-sm bg-transparent hover:bg-[#22c55e]/5 flex items-center justify-center gap-2"
      >
        <Github className="w-4 h-4" />
        Connect GitHub & Import Repository
      </button>
    )
  }

  // ── State 2: GitHub Connected — inline repo selection panel ────────────────
  return (
    <div className="w-2/3 flex flex-col items-center">
      {/* Connected indicator */}
      <div className="flex items-center gap-1.5 mb-1.5">
        <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
        <span className="text-[10px] text-white/40">
          Connected as <span className="text-emerald-400/70 font-medium">@{githubUsername}</span>
        </span>
      </div>

      {/* Repo card with glow border */}
      <div className="w-full rounded-xl p-[1px] bg-gradient-to-b from-emerald-500/30 via-white/[0.12] to-white/[0.06] shadow-[0_0_20px_rgba(16,185,129,0.08)]">
        <div className="w-full rounded-[11px] bg-slate-950/90 backdrop-blur-sm overflow-hidden">
          {loadingRepos ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="w-4 h-4 animate-spin text-emerald-400/60" />
            </div>
          ) : repositories.length === 0 ? (
            <div className="px-3 py-3 text-center">
              <p className="text-xs text-white/40">No repositories found</p>
            </div>
          ) : (
            <div className="max-h-[120px] overflow-y-auto scrollbar-thin">
              {repositories.map((repo, index) => {
                const isThisAnalyzing = analyzingRepoId === repo.id
                const isAnyAnalyzing = analyzingRepoId !== null
                return (
                  <div
                    key={repo.id}
                    className={`w-full px-3 py-1.5 flex items-center gap-2 hover:bg-emerald-500/[0.06] transition-all duration-200 group ${index !== repositories.length - 1 ? "border-b border-white/[0.07]" : ""
                      }`}
                  >
                    {/* Clickable repo info */}
                    <button
                      onClick={() => handleRepoClick(repo)}
                      disabled={isAnyAnalyzing}
                      className="flex-1 min-w-0 flex items-center gap-2 text-left disabled:opacity-50"
                    >
                      {/* Icon */}
                      <div className="shrink-0 w-5 h-5 rounded bg-white/[0.05] border border-white/[0.1] flex items-center justify-center group-hover:border-emerald-500/30 group-hover:bg-emerald-500/[0.06] transition-all duration-200">
                        {repo.private ? (
                          <Lock className="w-2.5 h-2.5 text-white/30 group-hover:text-emerald-400/70 transition-colors" />
                        ) : (
                          <Globe className="w-2.5 h-2.5 text-white/30 group-hover:text-emerald-400/70 transition-colors" />
                        )}
                      </div>

                      {/* Name */}
                      <span className="flex-1 min-w-0 text-[11px] font-medium text-white/70 group-hover:text-emerald-300 transition-colors truncate">
                        {repo.name}
                      </span>
                    </button>

                    {/* Badge */}
                    <span className={`shrink-0 text-[9px] font-medium px-1.5 py-0.5 rounded-full ${repo.private
                      ? "bg-amber-500/10 text-amber-400/60 border border-amber-500/20"
                      : "bg-emerald-500/10 text-emerald-400/60 border border-emerald-500/20"
                      }`}>
                      {repo.private ? "Private" : "Public"}
                    </span>

                    {/* Analyze button */}
                    {/* <button
                      onClick={(e) => handleAnalyze(repo, e)}
                      disabled={isAnyAnalyzing}
                      className={`shrink-0 flex items-center gap-1 px-2 py-0.5 rounded-md text-[9px] font-semibold uppercase tracking-wider transition-all duration-200 cursor-pointer disabled:cursor-not-allowed ${isThisAnalyzing
                        ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
                        : "bg-violet-500/10 text-violet-300 border border-violet-500/20 hover:bg-violet-500/20 hover:border-violet-500/40 hover:shadow-[0_0_8px_rgba(139,92,246,0.2)] disabled:opacity-40"
                        }`}
                      title="Run full analysis pipeline"
                    >
                      {isThisAnalyzing ? (
                        <Loader2 className="w-2.5 h-2.5 animate-spin" />
                      ) : (
                        <Zap className="w-2.5 h-2.5" />
                      )}
                      {isThisAnalyzing ? "Running" : "Analyze"}
                    </button> */}

                    <ChevronRight className="w-3 h-3 text-white/20 group-hover:text-emerald-400/40 transition-all duration-200 group-hover:translate-x-0.5 shrink-0" />
                  </div>
                )
              })}
            </div>
          )}

          {/* Footer */}
          <div className="border-t border-white/[0.08]">
            <button
              onClick={() => router.push("/dashboard")}
              className="w-full px-3 py-1.5 flex items-center justify-center gap-1.5 text-[10px] text-white/35 hover:text-emerald-400 hover:bg-emerald-500/[0.04] transition-all duration-200"
            >
              <Plus className="w-3 h-3" />
              Add New Repository
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
