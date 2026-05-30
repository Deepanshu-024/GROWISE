"use client"

import { useState, useEffect, useCallback } from "react"
import { Github, Lock, Globe, Plus, Loader2, ChevronRight, Zap, X, Sparkles, AlertTriangle, FileCheck } from "lucide-react"
import { useRouter } from "next/navigation"
import { useUser, useClerk } from "@clerk/nextjs"
import { toast } from "sonner"
import { triggerWorkflow } from "../../actions/trigger-workflow"
import { getAnalysisUsage, type AnalysisUsage } from "../../actions/get-analysis-usage"

interface Repository {
  id: number
  name: string
  fullName: string
  private: boolean
  description: string | null
  url: string
  dbId: string | null       // Database UUID (null if not yet in DB)
  hasReport: boolean         // Whether a compiled report exists
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

  // Modal & analysis state
  const [selectedRepo, setSelectedRepo] = useState<Repository | null>(null)
  const [usage, setUsage] = useState<AnalysisUsage | null>(null)
  const [loadingUsage, setLoadingUsage] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)

  useEffect(() => {
    if (!isAuthLoaded) return

    if (!isSignedIn) {
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

  // ── Repo click: navigate if report exists, else open modal ────────────────
  const handleRepoClick = useCallback(async (repo: Repository) => {
    // If report already exists, go straight to the project page
    if (repo.hasReport && repo.dbId) {
      router.push(`/project/${repo.dbId}`)
      return
    }

    // Otherwise open the analysis modal
    setSelectedRepo(repo)
    setLoadingUsage(true)
    try {
      const usageData = await getAnalysisUsage()
      setUsage(usageData)
    } catch {
      setUsage({ used: 0, limit: 2, remaining: 2 })
    } finally {
      setLoadingUsage(false)
    }
  }, [router])

  const closeModal = useCallback(() => {
    if (analyzing) return
    setSelectedRepo(null)
    setUsage(null)
  }, [analyzing])

  // ── Run analysis from modal ────────────────────────────────────────────────
  const handleAnalyze = async () => {
    if (!selectedRepo || analyzing) return

    setAnalyzing(true)
    toast.info("Starting analysis pipeline…")

    try {
      const result = await triggerWorkflow(
        selectedRepo.id.toString(),
        selectedRepo.fullName,
      )

      if (!result.success) {
        toast.error("Analysis failed", { description: result.error })
        return
      }

      toast.success(
        `Analysis complete — ${result.completedAgents}/${result.totalAgents} agents`,
      )
      setSelectedRepo(null)
      // Navigate using the database UUID returned from the server action
      if (result.dbId) {
        router.push(`/project/${result.dbId}`)
      }
    } catch (error) {
      console.error("Analysis pipeline error:", error)
      toast.error("Analysis failed", {
        description: error instanceof Error ? error.message : "Unknown error",
      })
    } finally {
      setAnalyzing(false)
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

  // ── State 1: GitHub NOT Connected ─────────────────────────────────────────
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

  // ── Derived values for modal ──────────────────────────────────────────────
  const isAtLimit = usage !== null && usage.remaining <= 0
  const usedAfter = usage ? usage.used + 1 : 0

  // ── State 2: GitHub Connected ─────────────────────────────────────────────
  return (
    <>
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
                {repositories.map((repo, index) => (
                  <button
                    key={repo.id}
                    onClick={() => handleRepoClick(repo)}
                    className={`w-full px-3 py-1.5 flex items-center gap-2 hover:bg-emerald-500/[0.06] transition-all duration-200 group text-left ${index !== repositories.length - 1 ? "border-b border-white/[0.07]" : ""
                      }`}
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

                    {/* Report Generated badge */}
                    {repo.hasReport ? (
                      <span className="shrink-0 text-[9px] font-medium px-1.5 py-0.5 rounded-full bg-violet-500/10 text-violet-300 border border-violet-500/20 flex items-center gap-1">
                        <FileCheck className="w-2.5 h-2.5" />
                        Report Generated
                      </span>
                    ) : (
                      /* Private/Public badge */
                      <span className={`shrink-0 text-[9px] font-medium px-1.5 py-0.5 rounded-full ${repo.private
                        ? "bg-amber-500/10 text-amber-400/60 border border-amber-500/20"
                        : "bg-emerald-500/10 text-emerald-400/60 border border-emerald-500/20"
                        }`}>
                        {repo.private ? "Private" : "Public"}
                      </span>
                    )}

                    <ChevronRight className="w-3 h-3 text-white/20 group-hover:text-emerald-400/40 transition-all duration-200 group-hover:translate-x-0.5 shrink-0" />
                  </button>
                ))}
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

      {/* ── Analysis Confirmation Modal ──────────────────────────────────── */}
      {selectedRepo && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200"
          onClick={closeModal}
        >
          <div
            className="relative w-full max-w-sm mx-4 rounded-2xl p-[1px] bg-gradient-to-b from-violet-500/40 via-emerald-500/20 to-white/[0.08] shadow-[0_0_40px_rgba(139,92,246,0.15)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="rounded-[15px] bg-slate-950/95 backdrop-blur-xl p-5">
              {/* Close button */}
              <button
                onClick={closeModal}
                disabled={analyzing}
                className="absolute top-3 right-3 w-6 h-6 flex items-center justify-center rounded-full bg-white/[0.05] hover:bg-white/[0.1] transition-colors disabled:opacity-50"
              >
                <X className="w-3.5 h-3.5 text-white/40" />
              </button>

              {/* Header */}
              <div className="flex items-center gap-2.5 mb-4">
                <div className="w-8 h-8 rounded-lg bg-violet-500/15 border border-violet-500/25 flex items-center justify-center">
                  <Zap className="w-4 h-4 text-violet-400" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-white/90">Analyze Repository</h3>
                  <p className="text-[10px] text-white/40">{selectedRepo.fullName}</p>
                </div>
              </div>

              {/* Usage info */}
              {loadingUsage ? (
                <div className="flex items-center justify-center py-6">
                  <Loader2 className="w-4 h-4 animate-spin text-violet-400/60" />
                </div>
              ) : usage && (
                <>
                  {/* Usage meter */}
                  <div className="mb-4 p-3 rounded-xl bg-white/[0.03] border border-white/[0.07]">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[10px] font-medium text-white/50 uppercase tracking-wider">Free Tier Usage</span>
                      <span className="text-[11px] font-semibold text-white/70">
                        {usage.used} / {usage.limit}
                      </span>
                    </div>
                    {/* Progress bar */}
                    <div className="w-full h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-500 ${isAtLimit
                          ? "bg-red-500/70"
                          : usage.used >= 1
                            ? "bg-amber-500/70"
                            : "bg-emerald-500/70"
                          }`}
                        style={{ width: `${(usage.used / usage.limit) * 100}%` }}
                      />
                    </div>
                  </div>

                  {isAtLimit ? (
                    /* ── At limit message ──────────────────────────────────── */
                    <div className="mb-4 p-3 rounded-xl bg-red-500/[0.06] border border-red-500/20">
                      <div className="flex items-start gap-2">
                        <AlertTriangle className="w-3.5 h-3.5 text-red-400 mt-0.5 shrink-0" />
                        <div>
                          <p className="text-[11px] text-red-300/90 font-medium mb-1">
                            Analysis limit reached
                          </p>
                          <p className="text-[10px] text-white/40 leading-relaxed">
                            You&apos;ve used all {usage.limit} free analyses. We&apos;re bringing premium plans soon to unlock unlimited repository analysis.
                          </p>
                        </div>
                      </div>
                    </div>
                  ) : (
                    /* ── Usage warning ─────────────────────────────────────── */
                    <div className="mb-4 p-3 rounded-xl bg-violet-500/[0.06] border border-violet-500/20">
                      <div className="flex items-start gap-2">
                        <Sparkles className="w-3.5 h-3.5 text-violet-400 mt-0.5 shrink-0" />
                        <div>
                          <p className="text-[11px] text-violet-300/90 font-medium mb-1">
                            This will use 1 of your {usage.limit} free analyses
                          </p>
                          <p className="text-[10px] text-white/40 leading-relaxed">
                            After analysis, you&apos;ll have{" "}
                            <span className="text-white/60 font-medium">{usage.limit - usedAfter}</span>{" "}
                            {usage.limit - usedAfter === 1 ? "analysis" : "analyses"} remaining.
                            We&apos;re bringing premium plans soon to unlock more.
                          </p>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Actions */}
                  <div className="flex items-center gap-2.5">
                    <button
                      onClick={closeModal}
                      disabled={analyzing}
                      className="flex-1 px-3 py-2 rounded-lg text-[11px] font-medium text-white/50 bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] hover:border-white/[0.15] transition-all duration-200 disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleAnalyze}
                      disabled={analyzing || isAtLimit}
                      className="flex-1 px-3 py-2 rounded-lg text-[11px] font-semibold flex items-center justify-center gap-1.5 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed bg-gradient-to-r from-violet-600 to-emerald-600 text-white hover:from-violet-500 hover:to-emerald-500 hover:shadow-[0_0_15px_rgba(139,92,246,0.3)]"
                    >
                      {analyzing ? (
                        <>
                          <Loader2 className="w-3 h-3 animate-spin" />
                          Analyzing…
                        </>
                      ) : (
                        <>
                          <Zap className="w-3 h-3" />
                          Analyze Repository
                        </>
                      )}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
