"use client";

import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Github, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { checkPackageAndFramework } from "../../actions/analysis/repository-analysis";
import { classifyBusinessContext } from "../../actions/analysis/business-classification";
import { getRepositoryById } from "../../actions/github/repository-queries";

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
    const [analyzedRepoId, setAnalyzedRepoId] = useState<string | null>(null);
    const [classifying, setClassifying] = useState(false);
    const [checkingFramework, setCheckingFramework] = useState(false);

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

    // Check if repository framework is already analyzed when selected
    const handleRepoChange = async (repoFullName: string) => {
        setSelectedRepo(repoFullName);
        setAnalyzedRepoId(null);
        setCheckingFramework(true);

        const repository = repositories.find((repo) => repo.fullName === repoFullName);
        if (!repository) {
            setCheckingFramework(false);
            return;
        }

        try {
            // Check if this repository has already been analyzed
            const dbRepo = await getRepositoryById(repository.id.toString());

            if (dbRepo && dbRepo.isSupported && dbRepo.framework) {
                // Repository already analyzed, enable business classification button
                setAnalyzedRepoId(repository.id.toString());
                toast.success(
                    `Framework already detected: ${dbRepo.framework.toUpperCase()}`,
                    {
                        description: "You can proceed with business classification",
                    }
                );
            }
        } catch (error) {
            console.error("Error checking repository status:", error);
            // Continue normally if check fails
        } finally {
            setCheckingFramework(false);
        }
    };

    const handleSelect = async () => {
        const repository = repositories.find((repo) => repo.fullName === selectedRepo);
        if (repository) {
            onOpenChange(false);

            toast.info("Analyzing repository framework with AI...");

            try {
                // Call framework detection
                const result = await checkPackageAndFramework(
                    repository.id.toString(),
                    repository.fullName
                );

                // Log detailed results
                console.log("=== Framework Analysis Result ===");
                console.log("Repository:", repository.fullName);
                console.log("Is Supported:", result.isSupported);
                console.log("Framework:", result.framework);
                console.log("Repo Content:", result.repoContent);
                console.log("Package.json:", result.packageJson?.name);
                if (result.error) {
                    console.error("Error:", result.error);
                }
                console.log("================================");

                // Show result toast
                if (result.isSupported) {
                    toast.success(
                        `Detected ${result.framework?.toUpperCase()} project: ${repository.fullName}`,
                        {
                            description: `Default branch: ${result.defaultBranch || "N/A"}`,
                        }
                    );
                    // Enable business classification button
                    setAnalyzedRepoId(repository.id.toString());
                } else {
                    toast.error("Could not detect Next.js or React framework", {
                        description: result.error || "Repository may not be a supported framework",
                    });
                    setAnalyzedRepoId(null);
                }
            } catch (error) {
                console.error("Error analyzing repository:", error);
                toast.error("Failed to analyze repository", {
                    description: error instanceof Error ? error.message : "Unknown error",
                });
                setAnalyzedRepoId(null);
            }

            onSelectRepository(repository);
        }
    };

    const handleClassifyBusiness = async () => {
        if (!analyzedRepoId) return;

        setClassifying(true);
        toast.info("Analyzing business context with AI...");

        try {
            const result = await classifyBusinessContext(analyzedRepoId);

            // Log detailed results
            console.log("=== Business Classification Result ===");
            if (result.classification) {
                console.log("Business Type:", result.classification.businessType.primary);
                console.log("Secondary Types:", result.classification.businessType.secondary);
                console.log("Confidence:", result.classification.businessType.confidence);
                console.log("Audience Size:", result.classification.audienceSize);
                console.log("Usage Pattern:", result.classification.usagePattern);
                console.log("Risk Profile:", result.classification.riskProfile);
                console.log("Constraints:", result.classification.constraints);
                console.log("Scale Breakpoints:", result.classification.scaleBreakpoints);
                console.log("Evidence:", result.classification.evidence);
            }
            if (result.error) {
                console.error("Error:", result.error);
            }
            console.log("======================================");

            // Show result toast
            if (result.classification) {
                toast.success(
                    `Business Type: ${result.classification.businessType.primary}`,
                    {
                        description: `Audience: ${result.classification.audienceSize} | Risk: ${result.classification.riskProfile}`,
                    }
                );
            } else {
                toast.error("Failed to classify business context", {
                    description: result.error || "Unknown error occurred",
                });
            }
        } catch (error) {
            console.error("Error classifying business context:", error);
            toast.error("Failed to classify business context", {
                description: error instanceof Error ? error.message : "Unknown error",
            });
        } finally {
            setClassifying(false);
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
                        <Select value={selectedRepo} onValueChange={handleRepoChange}>
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
                            {!analyzedRepoId && (
                                <Button onClick={handleSelect} disabled={!selectedRepo || checkingFramework}>
                                    {checkingFramework ? (
                                        <>
                                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                            Checking...
                                        </>
                                    ) : (
                                        "Analyze Framework"
                                    )}
                                </Button>
                            )}
                        </div>

                        {analyzedRepoId && (
                            <div className="pt-4 border-t">
                                <div className="space-y-2">
                                    <p className="text-sm text-muted-foreground">
                                        Framework analysis complete! Run business classification to understand the business context.
                                    </p>
                                    <Button
                                        onClick={handleClassifyBusiness}
                                        disabled={classifying}
                                        className="w-full"
                                    >
                                        {classifying ? (
                                            <>
                                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                                Analyzing Business Context...
                                            </>
                                        ) : (
                                            "Classify Business Context"
                                        )}
                                    </Button>
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}
