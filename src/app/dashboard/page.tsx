"use client"

import { useState, useEffect } from "react"
import { GitHubConnectButton } from "@/components/github-connect-button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { ScrollArea } from "@/components/ui/scroll-area"
import { ExternalLink, Lock, Plus, Loader2 } from "lucide-react"
import Link from "next/link"
import { Badge } from "@/components/ui/badge"
import { getGithubConnectionStatus, fetchInstallationRepositoriesAction } from "../../../actions/github/installations"

export default function DashboardPage() {
    const [loading, setLoading] = useState(true)
    const [githubInstallationId, setGithubInstallationId] = useState<string | null>(null)
    const [githubUsername, setGithubUsername] = useState<string | null>(null)
    const [repositories, setRepositories] = useState<any[]>([])
    const [loadingRepos, setLoadingRepos] = useState(false)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        loadConnectionStatus()
    }, [])

    const loadConnectionStatus = async () => {
        try {
            setLoading(true)
            const status = await getGithubConnectionStatus()
            setGithubInstallationId(status.githubInstallationId)
            setGithubUsername(status.githubUsername)

            if (status.githubInstallationId) {
                await loadRepositories(status.githubInstallationId)
            }
        } catch (err) {
            console.error("Error loading connection status:", err)
            setError("Failed to load connection status")
        } finally {
            setLoading(false)
        }
    }

    const loadRepositories = async (installationId: string) => {
        try {
            setLoadingRepos(true)
            setError(null)
            const repos = await fetchInstallationRepositoriesAction(installationId)
            setRepositories(repos)
        } catch (err) {
            console.error("Error loading repositories:", err)
            setError("Failed to load repositories")
        } finally {
            setLoadingRepos(false)
        }
    }

    return (
        <div className="container mx-auto py-10 max-w-4xl">
            <div className="space-y-6">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
                    <p className="text-muted-foreground">
                        Manage your account settings and integrations
                    </p>
                </div>

                <Separator />

                <Card>
                    <CardHeader>
                        <CardTitle>GitHub Integration</CardTitle>
                        <CardDescription>
                            Connect your GitHub account to enable codebase analysis and repository access
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <GitHubConnectButton />
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                        <div className="space-y-1">
                            <CardTitle>Connected Repositories</CardTitle>
                            <CardDescription>
                                View and manage repositories accessible through your GitHub integration
                            </CardDescription>
                        </div>
                        {githubInstallationId && (
                            <a
                                href={`https://github.com/settings/installations/${githubInstallationId}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg border border-emerald-500/40 hover:border-emerald-500/70 hover:shadow-[0_0_12px_rgba(16,185,129,0.2)] text-emerald-400 font-medium text-xs bg-slate-900/40 hover:bg-emerald-500/[0.04] transition-all duration-200"
                            >
                                <Plus className="w-3.5 h-3.5" />
                                Add / Manage Repositories
                            </a>
                        )}
                    </CardHeader>
                    <CardContent>
                        {loading ? (
                            <div className="flex items-center justify-center py-8">
                                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                            </div>
                        ) : !githubInstallationId ? (
                            <div className="text-sm text-muted-foreground">
                                Connect your GitHub account to view repositories
                            </div>
                        ) : loadingRepos ? (
                            <div className="flex items-center justify-center py-8">
                                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                            </div>
                        ) : error ? (
                            <div className="text-sm text-destructive">
                                {error}. Please try reconnecting your GitHub account.
                            </div>
                        ) : repositories.length === 0 ? (
                              <div className="text-sm text-muted-foreground">
                                  No repositories found in the connected installation.
                              </div>
                        ) : (
                            <ScrollArea className="h-[400px] w-full pr-4">
                                <div className="flex flex-col gap-4">
                                    {repositories.map((repo: any) => (
                                        <div
                                            key={repo.id}
                                            className="flex items-center justify-between rounded-lg border p-4 hover:bg-muted/50 transition-colors"
                                        >
                                            <div className="space-y-1">
                                                <div className="flex items-center gap-2">
                                                    <h4 className="font-medium leading-none">
                                                        {repo.fullName}
                                                    </h4>
                                                    <Badge variant="outline" className="text-xs font-normal">
                                                        {repo.private ? <Lock className="h-3 w-3 mr-1" /> : null}
                                                        {repo.private ? "Private" : "Public"}
                                                    </Badge>
                                                </div>
                                                <p className="text-sm text-muted-foreground line-clamp-1">
                                                    {repo.description || "No description provided"}
                                                </p>
                                            </div>
                                            <Link
                                                href={repo.url}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="text-muted-foreground hover:text-foreground"
                                            >
                                                <ExternalLink className="h-4 w-4" />
                                            </Link>
                                        </div>
                                    ))}
                                </div>
                            </ScrollArea>
                        )}
                    </CardContent>
                </Card>
            </div>
        </div>
    )
}
