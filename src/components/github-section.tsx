"use client"

import { useState, useEffect } from "react"
import { Github, Lock, Globe, Plus, Loader2, ChevronRight } from "lucide-react"
import { useRouter } from "next/navigation"

interface Repository {
  id: number
  name: string
  fullName: string
  private: boolean
  description: string | null
  url: string
}

// ── Mock data for UI development ──────────────────────────────────────────────
const MOCK_REPOS: Repository[] = [
  { id: 1, name: "next-saas-starter", fullName: "deepanshu/next-saas-starter", private: false, description: "A production-ready SaaS boilerplate with Next.js 14, Stripe, and Prisma", url: "https://github.com/deepanshu/next-saas-starter" },
  { id: 2, name: "ai-chatbot", fullName: "deepanshu/ai-chatbot", private: true, description: "Full-stack AI chatbot with RAG pipeline and vector search", url: "https://github.com/deepanshu/ai-chatbot" },
  { id: 3, name: "e-commerce-api", fullName: "deepanshu/e-commerce-api", private: false, description: "RESTful API for e-commerce platform with Redis caching", url: "https://github.com/deepanshu/e-commerce-api" },
  { id: 4, name: "dashboard-ui", fullName: "deepanshu/dashboard-ui", private: true, description: "Analytics dashboard built with React and D3.js", url: "https://github.com/deepanshu/dashboard-ui" },
  { id: 5, name: "infra-terraform", fullName: "deepanshu/infra-terraform", private: true, description: "Infrastructure as code for multi-cloud deployments", url: "https://github.com/deepanshu/infra-terraform" },
  { id: 6, name: "mobile-app", fullName: "deepanshu/mobile-app", private: false, description: null, url: "https://github.com/deepanshu/mobile-app" },
]

interface GitHubSectionProps {
  subheadline: string
}

export default function GitHubSection({ subheadline }: GitHubSectionProps) {
  const router = useRouter()
  const [checkingGithub, setCheckingGithub] = useState(true)
  const [githubConnected, setGithubConnected] = useState(false)
  const [githubUsername, setGithubUsername] = useState<string | null>(null)
  const [repositories, setRepositories] = useState<Repository[]>([])
  const [loadingRepos, setLoadingRepos] = useState(false)

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

        if (data.connected) {
          fetchRepositories()
        }
      }
    } catch (error) {
      console.error("Error checking GitHub status:", error)
      // Fallback to mock data for UI development
      setGithubConnected(true)
      setGithubUsername("deepanshu")
      setRepositories(MOCK_REPOS)
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
      setRepositories(MOCK_REPOS)
    } finally {
      setLoadingRepos(false)
    }
  }

  const handleConnect = () => {
    window.location.href = "/api/github/install"
  }

  const handleRepoClick = (repo: Repository) => {
    // TODO: Wire up to actual analysis pipeline
    router.push(`/project/${repo.id}`)
  }

  // ── Loading State ─────────────────────────────────────────────────────────
  if (checkingGithub) {
    return (
      <div className="w-full flex flex-col items-center">
        <p className="text-sm text-white/80 max-w-2xl mx-auto text-balance leading-relaxed text-center mb-6">
          {subheadline}
        </p>
        <Loader2 className="w-5 h-5 animate-spin text-emerald-400/60" />
      </div>
    )
  }

  // ── State 1: GitHub NOT Connected ─────────────────────────────────────────
  if (!githubConnected) {
    return (
      <div className="w-full flex flex-col items-center">
        {/* Full-size subheadline */}
        <p className="text-lg sm:text-xl text-white/80 max-w-2xl mx-auto text-balance leading-relaxed text-center mb-8">
          {subheadline}
        </p>

        <button
          onClick={handleConnect}
          className="w-2/3 max-w-md px-6 py-3.5 border border-emerald-500/40 hover:border-emerald-500/70 hover:shadow-[0_0_20px_rgba(16,185,129,0.25)] text-white/70 hover:text-emerald-400 transition-all duration-300 rounded-xl font-medium text-sm bg-transparent hover:bg-emerald-500/5 flex items-center justify-center gap-2.5 group"
        >
          <Github className="w-5 h-5 transition-transform duration-300 group-hover:scale-110" />
          Connect GitHub & Import Repository
        </button>
      </div>
    )
  }

  // ── State 2: GitHub Connected — Compact Inline Repos ──────────────────────
  return (
    <div className="w-full flex flex-col items-center">
      {/* Smaller subheadline when connected */}
      <p className="text-sm text-white/60 max-w-xl mx-auto text-balance leading-relaxed text-center mb-4">
        {subheadline}
      </p>

      {/* Connected indicator */}
      <div className="flex items-center gap-2 mb-3">
        <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
        <span className="text-[11px] text-white/40">
          Connected as <span className="text-emerald-400/70 font-medium">@{githubUsername}</span>
        </span>
      </div>

      {/* Compact repo list */}
      <div className="w-full max-w-lg rounded-xl border border-white/[0.08] bg-white/[0.02] backdrop-blur-sm overflow-hidden">
        {loadingRepos ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="w-4 h-4 animate-spin text-emerald-400/60" />
          </div>
        ) : repositories.length === 0 ? (
          <div className="px-4 py-5 text-center">
            <p className="text-xs text-white/40">No repositories found</p>
          </div>
        ) : (
          <div className="max-h-[180px] overflow-y-auto scrollbar-thin">
            {repositories.map((repo, index) => (
              <button
                key={repo.id}
                onClick={() => handleRepoClick(repo)}
                className={`w-full px-3.5 py-2.5 flex items-center gap-2.5 hover:bg-emerald-500/[0.06] transition-all duration-200 group text-left ${
                  index !== repositories.length - 1 ? "border-b border-white/[0.04]" : ""
                }`}
              >
                {/* Icon */}
                <div className="shrink-0 w-7 h-7 rounded-md bg-white/[0.04] border border-white/[0.08] flex items-center justify-center group-hover:border-emerald-500/30 transition-all duration-200">
                  {repo.private ? (
                    <Lock className="w-3 h-3 text-white/25 group-hover:text-emerald-400/70 transition-colors" />
                  ) : (
                    <Globe className="w-3 h-3 text-white/25 group-hover:text-emerald-400/70 transition-colors" />
                  )}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <span className="text-xs font-medium text-white/70 group-hover:text-emerald-300 transition-colors truncate block">
                    {repo.name}
                  </span>
                </div>

                {/* Badge + arrow */}
                <span className={`shrink-0 text-[9px] font-medium px-1.5 py-0.5 rounded-full ${
                  repo.private
                    ? "bg-amber-500/10 text-amber-400/60"
                    : "bg-emerald-500/10 text-emerald-400/60"
                }`}>
                  {repo.private ? "Private" : "Public"}
                </span>
                <ChevronRight className="w-3 h-3 text-white/10 group-hover:text-emerald-400/40 transition-all duration-200 group-hover:translate-x-0.5 shrink-0" />
              </button>
            ))}
          </div>
        )}

        {/* Footer */}
        <div className="border-t border-white/[0.06]">
          <button
            onClick={() => router.push("/dashboard")}
            className="w-full px-3.5 py-2 flex items-center justify-center gap-1.5 text-[11px] text-white/35 hover:text-emerald-400 hover:bg-emerald-500/[0.04] transition-all duration-200"
          >
            <Plus className="w-3 h-3" />
            Add New Repository
          </button>
        </div>
      </div>
    </div>
  )
}
