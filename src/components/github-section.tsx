"use client"

import { useState, useEffect, useCallback } from "react"
import { Github, Lock, Globe, Plus, Loader2, ChevronRight, Zap, X, Sparkles, AlertTriangle, FileCheck, CircleCheck } from "lucide-react"
import { useRouter } from "next/navigation"
import { useUser, useClerk } from "@clerk/nextjs"
import { toast } from "sonner"
import { motion, AnimatePresence } from "motion/react"
import { triggerWorkflow } from "../../actions/trigger-workflow"
import { getAnalysisUsage, type AnalysisUsage } from "../../actions/get-analysis-usage"
import { checkPackageAndFramework } from "../../actions/analysis/repository-analysis"

interface Repository {
  id: number
  name: string
  fullName: string
  private: boolean
  description: string | null
  url: string
  dbId: string | null       // Database UUID (null if not yet in DB)
  hasReport: boolean         // Whether a compiled report exists
  isSupported?: boolean | null
  framework?: string | null
}

interface GitHubSectionProps {
  /** Called when GitHub status is resolved so the parent can react */
  onStatusResolved?: (connected: boolean, username?: string | null) => void
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
  const [repoIsUnsupported, setRepoIsUnsupported] = useState<boolean>(false)
  const [checkingFramework, setCheckingFramework] = useState(false)

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
        onStatusResolved?.(data.connected, data.username ?? null)

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

  const isAtLimit = usage !== null && usage.remaining <= 0

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
    setRepoIsUnsupported(repo.isSupported === false || repo.framework === "unsupported")
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
    setRepoIsUnsupported(false)
  }, [analyzing])

  const handleRedetectFramework = async () => {
    if (!selectedRepo || checkingFramework) return
    setCheckingFramework(true)
    toast.info("Re-detecting framework...")
    try {
      const result = await checkPackageAndFramework(
        selectedRepo.id.toString(),
        selectedRepo.fullName
      )
      if (result.isSupported) {
        toast.success(`Detected ${result.framework?.toUpperCase()} project`)
        setRepoIsUnsupported(false)
        setRepositories(prev =>
          prev.map(r =>
            r.id === selectedRepo.id
              ? { ...r, isSupported: true, framework: result.framework }
              : r
          )
        )
      } else {
        toast.error("Could not detect Next.js or React framework", {
          description: result.error || "Repository may not be a supported framework",
        })
        setRepoIsUnsupported(true)
        setRepositories(prev =>
          prev.map(r =>
            r.id === selectedRepo.id
              ? { ...r, isSupported: false, framework: "unsupported" }
              : r
          )
        )
      }
    } catch (error) {
      console.error("Error re-detecting framework:", error)
      toast.error("Failed to re-detect framework")
    } finally {
      setCheckingFramework(false)
    }
  }

  // ── Run analysis from modal ────────────────────────────────────────────────
  const handleAnalyze = async () => {
    if (!selectedRepo || analyzing || repoIsUnsupported) return

    setAnalyzing(true)
    toast.info("Starting analysis pipeline…")

    try {
      const result = await triggerWorkflow(
        selectedRepo.id.toString(),
        selectedRepo.fullName,
      )

      if (!result.success) {
        toast.error("Analysis failed", { description: result.error })
        if (result.error?.toLowerCase().includes("unsupported") || result.error?.toLowerCase().includes("package.json")) {
          setRepoIsUnsupported(true)
          setRepositories(prev =>
            prev.map(r =>
              r.id === selectedRepo.id
                ? { ...r, isSupported: false, framework: "unsupported" }
                : r
            )
          )
        }
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
      <div className="w-full max-w-xl md:max-w-2xl flex flex-col items-center font-mono h-full min-h-0">
        {/* Box matching connected state structure */}
        <motion.div
          layout
          transition={{ type: "spring", stiffness: 300, damping: 30 }}
          className="w-full flex-1 min-h-0 border p-[1px] transition-all duration-500 border-white/10 bg-white/[0.02] flex flex-col"
        >
          <div className="w-full flex-1 min-h-0 overflow-hidden flex flex-col">
            {/* Main content area — connect prompt */}
            <button
              onClick={handleConnect}
              className="flex-1 flex flex-col items-center justify-center gap-4 group hover:bg-white/[0.02] transition-all duration-300 cursor-pointer"
            >
              <div className="flex items-center gap-3 text-sm md:text-base font-bold tracking-tight">
                <span className="text-white/40 group-hover:text-acid-green/60 transition-colors">$</span>
                <span className="text-white group-hover:text-acid-green transition-colors uppercase">
                  CONNECT_GITHUB_REPOSITORY
                </span>
                <span className="cursor-blink" />
              </div>

              <div className="flex items-center gap-6 text-white/40 group-hover:text-white/70 transition-colors">
                <div className="flex items-center gap-1.5 text-[9px] uppercase tracking-widest font-bold">
                  <Github className="w-3.5 h-3.5 text-acid-green/60" />
                  <span>Select Repo</span>
                </div>
                {/* <div className="h-px w-8 bg-white/10" />
                <div className="flex items-center gap-1.5 text-[9px] uppercase tracking-widest font-bold">
                  <CircleCheck className="w-3.5 h-3.5 text-acid-green/60" />
                  <span>Analyze Scale</span>
                </div> */}
              </div>
            </button>

            {/* Footer — status indicator */}
            <div className="h-[42px] border-t border-white/10 flex items-center justify-center shrink-0 gap-2">
              <div className="w-1.5 h-1.5 rounded-full bg-white/20" />
              <span className="text-[10px] text-white/20 uppercase tracking-[0.2em] select-none">
                Not Connected
              </span>
            </div>
          </div>
        </motion.div>
      </div>
    )
  }

  // ── State 2: GitHub Connected ─────────────────────────────────────────────
  return (
    <div className="w-full max-w-xl md:max-w-2xl flex flex-col items-center font-mono h-full min-h-0">
      {/* Repo card */}
      <motion.div
        layout
        transition={{ type: "spring", stiffness: 300, damping: 30 }}
        className={`w-full flex-1 min-h-0 border p-[1px] transition-all duration-500 border-white/10 bg-white/[0.02] flex flex-col`}
      >
        <motion.div
          layout
          transition={{ type: "spring", stiffness: 300, damping: 30 }}
          className="w-full flex-1 min-h-0 overflow-hidden flex flex-col"
        >
          <AnimatePresence mode="wait" initial={false}>
            {!selectedRepo ? (
              <motion.div
                key="repo-list"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="w-full flex flex-col flex-1 min-h-0"
              >
                {loadingRepos ? (
                  <div className="flex-1 min-h-0 flex items-center justify-center">
                    <Loader2 className="w-5 h-5 animate-spin text-acid-green/60" />
                  </div>
                ) : repositories.length === 0 ? (
                  <div className="flex-1 min-h-0 flex items-center justify-center px-3 text-center">
                    <p className="text-[10px] text-white/30 tracking-widest">ERR: NO_REPOSITORIES_FOUND</p>
                  </div>
                ) : (
                  <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin divide-y divide-white/[0.05]">
                    {repositories.map((repo) => (
                      <button
                        key={repo.id}
                        onClick={() => handleRepoClick(repo)}
                        className="w-full px-4 py-2.5 flex items-center gap-3 hover:bg-white/[0.03] transition-all duration-200 group text-left"
                      >
                        {/* Icon */}
                        <div className="shrink-0 w-6 h-6 border border-white/5 flex items-center justify-center group-hover:border-acid-green/30 transition-all duration-200">
                          {repo.private ? (
                            <Lock className="w-3 h-3 text-white/20 group-hover:text-acid-green transition-colors" />
                          ) : (
                            <Globe className="w-3 h-3 text-white/20 group-hover:text-acid-green transition-colors" />
                          )}
                        </div>

                        {/* Name */}
                        <span className="flex-1 min-w-0 text-[11px] font-bold text-white/60 group-hover:text-white transition-colors truncate tracking-tight">
                          {repo.name.toUpperCase()}
                        </span>

                        {/* Report Generated badge */}
                        {repo.hasReport ? (
                          <span className="shrink-0 text-[9px] font-bold px-2 py-0.5 bg-acid-green/10 text-acid-green border border-acid-green/20 flex items-center gap-1">
                            <FileCheck className="w-2.5 h-2.5" />
                            INDEXED
                          </span>
                        ) : (
                          /* Private/Public badge */
                          <span
                            className={`shrink-0 text-[9px] font-bold px-2 py-0.5 border ${repo.private
                              ? "bg-amber-500/10 text-amber-400/60 border-amber-500/20"
                              : "bg-white/5 text-white/40 border-white/10"
                              }`}
                          >
                            {repo.private ? "PVT" : "PUB"}
                          </span>
                        )}

                        <ChevronRight className="w-3 h-3 text-white/10 group-hover:text-acid-green transition-all duration-200 group-hover:translate-x-0.5 shrink-0" />
                      </button>
                    ))}
                  </div>
                )}

                {/* Footer */}
                <div className="h-[25px] border-t border-white/10 flex items-center shrink-0">
                  <button
                    onClick={() => {
                      if (githubInstallationId) {
                        window.open(`https://github.com/settings/installations/${githubInstallationId}`, "_blank")
                      } else {
                        window.location.href = "/api/github/install"
                      }
                    }}
                    className="w-full h-full flex items-center justify-center gap-2 text-[10px] text-white/20 hover:text-white hover:bg-white/5 transition-all duration-200 tracking-[0.2em]"
                  >
                    <Plus className="w-3 h-3" />
                    APPEND_REPOSITORY
                  </button>
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="confirm-box"
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0 }}
                className="w-full p-6 flex flex-col justify-between relative"
              >
                {/* Top Section: Header */}
                <div className="flex flex-col gap-4">
                  {/* Header */}
                  <div className="flex items-center gap-3 select-none">
                    <div className="w-10 h-10 bg-acid-green/10 border border-acid-green/20 flex items-center justify-center shrink-0">
                      <Zap className="w-5 h-5 text-acid-green" />
                    </div>
                    <div className="min-w-0">
                      <h3 className="text-xs font-bold text-white tracking-widest uppercase">Analyze_Repository</h3>
                      <p className="text-[10px] text-white/30 truncate max-w-[240px] font-mono">{selectedRepo.fullName}</p>
                    </div>
                  </div>
                </div>

                {/* Middle Section: Text Message / Loader */}
                <div className="min-h-[40px] flex flex-col justify-center select-none mt-4">
                  {loadingUsage ? (
                    <div className="flex items-center justify-center w-full">
                      <Loader2 className="w-5 h-5 animate-spin text-acid-green/60" />
                    </div>
                  ) : repoIsUnsupported ? (
                    <div className="p-3 bg-red-500/10 border border-red-500/20 text-[10px] text-red-400 flex items-center gap-3 w-full justify-between">
                      <div className="flex items-center gap-2 min-w-0">
                        <AlertTriangle className="h-4 w-4 shrink-0" />
                        <span className="font-bold uppercase tracking-tight">ERR: UNSUPPORTED_FRAMEWORK</span>
                      </div>
                      <button
                        type="button"
                        disabled={checkingFramework}
                        onClick={handleRedetectFramework}
                        className="font-bold text-red-300 hover:text-white underline shrink-0 disabled:opacity-50"
                      >
                        RETRY
                      </button>
                    </div>
                  ) : (
                    usage && (
                      <div className="text-[11px] text-white/60 leading-normal font-medium text-left">
                        {isAtLimit ? (
                          <span className="text-red-400/90 tracking-tight font-bold">
                            LIMIT_EXCEEDED: UPGRADE_TO_PRO
                          </span>
                        ) : (
                          <span className="text-acid-green/80 tracking-tight font-bold">
                            TOKEN_ALLOCATION: 01 / {usage.remaining} REMAINING
                          </span>
                        )}
                      </div>
                    )
                  )}
                </div>

                {/* Bottom Section: Actions */}
                <div className="flex items-center gap-3 mt-4">
                  <button
                    onClick={closeModal}
                    disabled={analyzing || checkingFramework}
                    className="flex-1 h-9 border border-white/10 text-[10px] font-bold text-white/40 hover:text-white hover:bg-white/5 transition-all duration-200 uppercase tracking-widest"
                  >
                    Abort
                  </button>
                  <button
                    onClick={handleAnalyze}
                    disabled={analyzing || isAtLimit || repoIsUnsupported || checkingFramework}
                    className="flex-1 h-9 bg-acid-green text-[#111111] text-[10px] font-black flex items-center justify-center gap-2 hover:bg-white transition-all duration-200 disabled:opacity-50 disabled:grayscale tracking-widest"
                  >
                    {analyzing ? (
                      <>
                        <Loader2 className="w-3 h-3 animate-spin" />
                        EXECUTING...
                      </>
                    ) : (
                      <>
                        <Zap className="w-3 h-3" />
                        INITIALIZE
                      </>
                    )}
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      </motion.div>
    </div>
  )
}
