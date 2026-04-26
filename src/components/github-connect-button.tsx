"use client";

import { useEffect, useState } from "react";
import { useUser } from "@clerk/nextjs";
import { Button } from "@/components/ui/button";
import { Github, Loader2, X } from "lucide-react";
import { toast } from "sonner";

interface GitHubStatus {
    connected: boolean;
    username: string | null;
    installationId: string | null;
}

export function GitHubConnectButton() {
    const { user, isLoaded } = useUser();
    const [status, setStatus] = useState<GitHubStatus | null>(null);
    const [loading, setLoading] = useState(true);
    const [disconnecting, setDisconnecting] = useState(false);

    useEffect(() => {
        if (isLoaded && user) {
            fetchStatus();
        }
    }, [isLoaded, user]);

    const fetchStatus = async () => {
        try {
            setLoading(true);
            const response = await fetch("/api/github/status");

            if (!response.ok) {
                throw new Error("Failed to fetch GitHub status");
            }

            const data = await response.json();
            setStatus(data);
        } catch (error) {
            console.error("Error fetching GitHub status:", error);
            toast.error("Failed to load GitHub connection status");
        } finally {
            setLoading(false);
        }
    };

    const handleConnect = () => {
        window.location.href = "/api/github/install";
    };

    const handleDisconnect = async () => {
        try {
            setDisconnecting(true);
            const response = await fetch("/api/github/disconnect", {
                method: "POST",
            });

            if (!response.ok) {
                throw new Error("Failed to disconnect GitHub");
            }

            toast.success("GitHub account disconnected successfully");
            await fetchStatus();
        } catch (error) {
            console.error("Error disconnecting GitHub:", error);
            toast.error("Failed to disconnect GitHub account");
        } finally {
            setDisconnecting(false);
        }
    };

    if (!isLoaded || loading) {
        return (
            <Button disabled variant="outline">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Loading...
            </Button>
        );
    }

    if (!user) {
        return null;
    }

    if (status?.connected) {
        return (
            <div className="flex items-center gap-3">
                <div className="flex items-center gap-2 text-sm">
                    <Github className="h-4 w-4" />
                    <span className="text-muted-foreground">Connected as</span>
                    <span className="font-medium">@{status.username}</span>
                </div>
                <Button
                    variant="outline"
                    size="sm"
                    onClick={handleDisconnect}
                    disabled={disconnecting}
                >
                    {disconnecting ? (
                        <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            Disconnecting...
                        </>
                    ) : (
                        <>
                            <X className="mr-2 h-4 w-4" />
                            Disconnect
                        </>
                    )}
                </Button>
            </div>
        );
    }

    return (
        <Button onClick={handleConnect} variant="outline">
            <Github className="mr-2 h-4 w-4" />
            Connect GitHub
        </Button>
    );
}
