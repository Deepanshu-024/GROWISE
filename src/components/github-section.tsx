"use client"

import { useState, useEffect, useCallback } from "react"
import { Github, Lock, Globe, Plus, Loader2, ChevronRight, Zap, X, Sparkles, AlertTriangle, FileCheck } from "lucide-react"
import { useRouter } from "next/navigation"
import { useUser, useClerk } from "@clerk/nextjs"
import { toast } from "sonner"
import { motion, AnimatePresence } from "motion/react"
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
  const [githubInstallationId, setGithubInstallationId] = useState<string | null>(null)

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
        setGithubInstallationId(data.installationId ?? null)
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
        className="w-full max-w-md mt-4 px-4 sm:px-6 py-3 border border-[#22c55e]/40 hover:border-[#22c55e]/70 hover:shadow-[0_0_15px_rgba(34,197,94,0.3)] text-muted-foreground hover:text-[#22c55e] transition-all duration-200 rounded-xl font-medium text-xs sm:text-sm whitespace-nowrap bg-transparent hover:bg-[#22c55e]/5 flex items-center justify-center gap-2"
      >
        <Github className="w-4 h-4 shrink-0" />
        Connect GitHub & Import Repository
      </button>
    )
  }

  // ── Derived values for modal ──────────────────────────────────────────────
  const isAtLimit = usage !== null && usage.remaining <= 0
  const usedAfter = usage ? usage.used + 1 : 0

  // ── State 2: GitHub Connected ─────────────────────────────────────────────
  return (
    <div className="w-full max-w-md flex flex-col items-center">
      {/* Connected indicator with dynamic color/text */}
      <div className="flex items-center gap-1.5 mb-1.5 h-4 transition-all duration-350">
        <div className={`w-1.5 h-1.5 rounded-full animate-pulse transition-colors duration-500 ${selectedRepo ? "bg-violet-400" : "bg-emerald-400"}`} />
        <span className="text-[10px] text-white/40 select-none">
          {selectedRepo ? (
            <>
              Confirming analysis for <span className="text-violet-400/80 font-medium">{selectedRepo.name}</span>
            </>
          ) : (
            <>
              Connected as <span className="text-emerald-400/70 font-medium">@{githubUsername}</span>
            </>
          )}
        </span>
      </div>

      {/* Repo card with dynamic border gradient & shadow transformation */}
      <motion.div
        layout
        transition={{ type: "spring", stiffness: 300, damping: 30 }}
        className={`w-full rounded-xl p-[1px] transition-all duration-500 ${selectedRepo
          ? "bg-gradient-to-b from-violet-500/40 via-emerald-500/20 to-white/[0.08] shadow-[0_0_30px_rgba(139,92,246,0.15)]"
          : "bg-gradient-to-b from-emerald-500/30 via-white/[0.12] to-white/[0.06] shadow-[0_0_20px_rgba(16,185,129,0.08)]"
          }`}
      >
        <motion.div
          layout
          transition={{ type: "spring", stiffness: 300, damping: 30 }}
          className="w-full h-[162px] rounded-[11px] bg-slate-950/90 backdrop-blur-sm overflow-hidden"
        >
          <AnimatePresence mode="wait" initial={false}>
            {!selectedRepo ? (
              <motion.div
                key="repo-list"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.2 }}
                className="w-full h-full flex flex-col justify-between"
              >
                {loadingRepos ? (
                  <div className="h-[120px] flex items-center justify-center">
                    <Loader2 className="w-4 h-4 animate-spin text-emerald-400/60" />
                  </div>
                ) : repositories.length === 0 ? (
                  <div className="h-[120px] flex items-center justify-center px-3 text-center">
                    <p className="text-xs text-white/40">No repositories found</p>
                  </div>
                ) : (
                  <div className="h-[120px] overflow-y-auto scrollbar-thin">
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
                          <span
                            className={`shrink-0 text-[9px] font-medium px-1.5 py-0.5 rounded-full ${repo.private
                              ? "bg-amber-500/10 text-amber-400/60 border border-amber-500/20"
                              : "bg-emerald-500/10 text-emerald-400/60 border border-emerald-500/20"
                              }`}
                          >
                            {repo.private ? "Private" : "Public"}
                          </span>
                        )}

                        <ChevronRight className="w-3 h-3 text-white/20 group-hover:text-emerald-400/40 transition-all duration-200 group-hover:translate-x-0.5 shrink-0" />
                      </button>
                    ))}
                  </div>
                )}

                {/* Footer */}
                <div className="h-[42px] border-t border-white/[0.08] flex items-center shrink-0">
                  <button
                    onClick={() => {
                      if (githubInstallationId) {
                        window.open(`https://github.com/settings/installations/${githubInstallationId}`, "_blank")
                      } else {
                        window.location.href = "/api/github/install"
                      }
                    }}
                    className="w-full h-full flex items-center justify-center gap-1.5 text-[10px] text-white/35 hover:text-emerald-400 hover:bg-emerald-500/[0.04] transition-all duration-200"
                  >
                    <Plus className="w-3 h-3" />
                    Add New Repository
                  </button>
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="confirm-box"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.2 }}
                className="w-full h-full p-3.5 flex flex-col justify-between relative"
              >
                {/* Close button */}
                {/* <button
                  onClick={closeModal}
                  disabled={analyzing}
                  className="absolute top-3 right-3 w-5 h-5 flex items-center justify-center rounded-full bg-white/[0.05] hover:bg-white/[0.1] transition-colors disabled:opacity-50"
                >
                  <X className="w-3 h-3 text-white/40" />
                </button> */}

                {/* Top Section: Header */}
                <div className="flex flex-col gap-2.5">
                  {/* Header */}
                  <div className="flex items-center gap-2 select-none">
                    <div className="w-6.5 h-6.5 rounded bg-violet-500/15 border border-violet-500/25 flex items-center justify-center shrink-0">
                      <Zap className="w-3.5 h-3.5 text-violet-400" />
                    </div>
                    <div className="min-w-0">
                      <h3 className="text-[11px] font-semibold text-white/90 leading-tight">Analyze Repository</h3>
                      <p className="text-[9px] text-white/40 truncate max-w-[180px]">{selectedRepo.fullName}</p>
                    </div>
                  </div>
                </div>

                {/* Middle Section: Text Message / Loader */}
                <div className="min-h-[36px] flex items-center select-none">
                  {loadingUsage ? (
                    <div className="flex items-center justify-center w-full py-1">
                      <Loader2 className="w-4 h-4 animate-spin text-violet-400/60" />
                    </div>
                  ) : (
                    usage && (
                      <div className="text-[11px] sm:text-[12px] text-white/60 leading-normal font-medium">
                        {isAtLimit ? (
                          <span className="text-red-400/95">
                            Generation limit reached (2/2 used). Pro plans are coming soon to unlock unlimited analyses.
                          </span>
                        ) : (
                          <span className="text-violet-300/90">
                            Analyzing will use 1 of your 2 free generations ({usage.remaining} remaining). Pro plans are coming soon to unlock unlimited analyses.
                          </span>
                        )}
                      </div>
                    )
                  )}
                </div>

                {/* Bottom Section: Actions */}
                <div className="flex flex-col gap-2">
                  {/* Action buttons */}
                  <div className="flex items-center gap-2">
                    <button
                      onClick={closeModal}
                      disabled={analyzing}
                      className="flex-1 h-7 rounded-md text-[10px] font-medium text-white/50 bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] hover:border-white/[0.15] transition-all duration-200 disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleAnalyze}
                      disabled={analyzing || isAtLimit}
                      className="flex-1 h-7 rounded-md text-[10px] font-semibold flex items-center justify-center gap-1 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed bg-gradient-to-r from-violet-600 to-emerald-600 text-white hover:from-violet-500 hover:to-emerald-500 hover:shadow-[0_0_10px_rgba(139,92,246,0.2)] animate-pulse-subtle"
                    >
                      {analyzing ? (
                        <>
                          <Loader2 className="w-2.5 h-2.5 animate-spin" />
                          Analyzing…
                        </>
                      ) : (
                        <>
                          <Zap className="w-2.5 h-2.5" />
                          Analyze
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      </motion.div>
    </div>
  )
}
