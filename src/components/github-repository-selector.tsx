"use client";

import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Github, Loader2 } from "lucide-react";
import { toast } from "sonner";

interface Repository {
    id: number;
    name: string;
    fullName: string;
    private: boolean;
    description: string | null;
    url: string;
}

interface GitHubRepositorySelectorProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSelectRepository: (repository: Repository) => void;
}

export function GitHubRepositorySelector({ open, onOpenChange, onSelectRepository }: GitHubRepositorySelectorProps) {
    const [repositories, setRepositories] = useState<Repository[]>([]);
    const [loading, setLoading] = useState(false);
    const [selectedRepo, setSelectedRepo] = useState<string>("");

    useEffect(() => {
        if (open) {
            fetchRepositories();
        }
    }, [open]);

    const fetchRepositories = async () => {
        try {
            setLoading(true);
            const response = await fetch("/api/github/repositories");

            if (!response.ok) {
                throw new Error("Failed to fetch repositories");
            }

            const data = await response.json();
            setRepositories(data.repositories);
        } catch (error) {
            console.error("Error fetching repositories:", error);
            toast.error("Failed to load repositories");
        } finally {
            setLoading(false);
        }
    };

    const handleSelect = () => {
        const repository = repositories.find((repo) => repo.fullName === selectedRepo);
        if (repository) {
            onSelectRepository(repository);
            onOpenChange(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[500px]">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Github className="h-5 w-5" />
                        Select Repository
                    </DialogTitle>
                    <DialogDescription>
                        Choose a repository from your GitHub account to analyze
                    </DialogDescription>
                </DialogHeader>

                {loading ? (
                    <div className="flex items-center justify-center py-8">
                        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                    </div>
                ) : (
                    <div className="space-y-4">
                        <Select value={selectedRepo} onValueChange={setSelectedRepo}>
                            <SelectTrigger>
                                <SelectValue placeholder="Select a repository" />
                            </SelectTrigger>
                            <SelectContent>
                                {repositories.map((repo) => (
                                    <SelectItem key={repo.id} value={repo.fullName}>
                                        <div className="flex items-center gap-2">
                                            <span className="font-medium">{repo.name}</span>
                                            {repo.private && (
                                                <span className="text-xs text-muted-foreground">(Private)</span>
                                            )}
                                        </div>
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>

                        {selectedRepo && (
                            <div className="text-sm text-muted-foreground">
                                {repositories.find((r) => r.fullName === selectedRepo)?.description || "No description"}
                            </div>
                        )}

                        <div className="flex justify-end gap-2">
                            <Button variant="outline" onClick={() => onOpenChange(false)}>
                                Cancel
                            </Button>
                            <Button onClick={handleSelect} disabled={!selectedRepo}>
                                Select Repository
                            </Button>
                        </div>
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}
