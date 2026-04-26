import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { GitHubConnectButton } from "@/components/github-connect-button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import prisma from "@/lib/prisma";
import { getInstallationRepositories } from "@/lib/github";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ExternalLink, GitFork, Lock, Star } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";

export default async function DashboardPage() {
    const { userId } = await auth();

    if (!userId) {
        redirect("/sign-in");
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
                    <CardHeader>
                        <CardTitle>Connected Repositories</CardTitle>
                        <CardDescription>
                            View and manage repositories accessible through your GitHub integration
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <RepositoryList />
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}


async function RepositoryList() {
    const { userId } = await auth();

    if (!userId) return null;

    const user = await prisma.user.findUnique({
        where: { clerkId: userId },
        select: { githubInstallationId: true },
    });

    if (!user?.githubInstallationId) {
        return (
            <div className="text-sm text-muted-foreground">
                Connect your GitHub account to view repositories
            </div>
        );
    }

    try {
        const repositories = await getInstallationRepositories(user.githubInstallationId);

        if (repositories.length === 0) {
            return (
                <div className="text-sm text-muted-foreground">
                    No repositories found in the connected installation.
                </div>
            );
        }

        return (
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
        );
    } catch (error) {
        console.error("Error loading repositories:", error);
        return (
            <div className="text-sm text-destructive">
                Failed to load repositories. Please try reconnecting your GitHub account.
            </div>
        );
    }
}
