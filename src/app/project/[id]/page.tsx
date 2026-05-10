"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
    ArrowLeft, Loader2, Github, Send, Bot, User, FileText, MessageSquare, XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";

/* ─── Types ────────────────────────────────────────────────────────────────── */

interface Repository {
    id: string;
    fullName: string;
    framework: string | null;
    compiledReport: string | null;
    compiledReportAt: string | null;
    updatedAt: string;
}

interface ChatMessage {
    role: "user" | "assistant";
    content: string;
}

/* ─── Markdown Renderer ────────────────────────────────────────────────────── */

function MarkdownReport({ content }: { content: string }) {
    // Convert markdown to styled HTML
    const renderMarkdown = (md: string): string => {
        let html = md
            // Tables — full pipeline
            .replace(/^(\|.+\|)\n(\|[\s:|-]+\|)\n((?:\|.+\|\n?)*)/gm, (_match, header: string, _sep: string, body: string) => {
                const ths = header.split("|").filter((c: string) => c.trim()).map((c: string) => `<th>${c.trim()}</th>`).join("");
                const rows = body.trim().split("\n").map((row: string) => {
                    const tds = row.split("|").filter((c: string) => c.trim()).map((c: string) => `<td>${c.trim()}</td>`).join("");
                    return `<tr>${tds}</tr>`;
                }).join("");
                return `<div class="table-wrap"><table><thead><tr>${ths}</tr></thead><tbody>${rows}</tbody></table></div>`;
            })
            // Headers
            .replace(/^#### (.+)$/gm, '<h4 class="rpt-h4">$1</h4>')
            .replace(/^### (.+)$/gm, '<h3 class="rpt-h3">$1</h3>')
            .replace(/^## (.+)$/gm, '<h2 class="rpt-h2">$1</h2>')
            .replace(/^# (.+)$/gm, '<h1 class="rpt-h1">$1</h1>')
            // Bold + italic
            .replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>")
            .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
            .replace(/\*(.+?)\*/g, "<em>$1</em>")
            // Inline code
            .replace(/`([^`]+)`/g, '<code class="rpt-code">$1</code>')
            // Unordered lists
            .replace(/^- (.+)$/gm, '<li class="rpt-li">$1</li>')
            // Horizontal rule
            .replace(/^---$/gm, '<hr class="rpt-hr"/>')
            // Line breaks → paragraphs for non-empty lines that aren't already tags
            .split("\n").map(line => {
                const trimmed = line.trim();
                if (!trimmed) return "";
                if (trimmed.startsWith("<")) return line;
                return `<p class="rpt-p">${line}</p>`;
            }).join("\n")
            // Wrap consecutive <li> in <ul>
            .replace(/((?:<li class="rpt-li">.*?<\/li>\n?)+)/g, '<ul class="rpt-ul">$1</ul>');

        return html;
    };

    return (
        <div
            className="report-content"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
        />
    );
}

/* ─── Chat Panel ───────────────────────────────────────────────────────────── */

function ChatPanel({ repositoryId }: { repositoryId: string }) {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState("");
    const [loading, setLoading] = useState(false);
    const bottomRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages]);

    const sendMessage = useCallback(async () => {
        const text = input.trim();
        if (!text || loading) return;

        const userMsg: ChatMessage = { role: "user", content: text };
        setMessages((prev) => [...prev, userMsg]);
        setInput("");
        setLoading(true);

        try {
            const res = await fetch(`/api/project/${repositoryId}/chat`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    message: text,
                    history: messages.slice(-10),
                }),
            });

            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || `HTTP ${res.status}`);
            }

            const reader = res.body?.getReader();
            if (!reader) throw new Error("No response body");

            const decoder = new TextDecoder();
            let buffer = "";
            let assistantContent = "";

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() ?? "";

                for (const line of lines) {
                    if (!line.startsWith("data: ")) continue;
                    try {
                        const event = JSON.parse(line.slice(6));
                        if (event.type === "response") {
                            assistantContent = event.content;
                        } else if (event.type === "error") {
                            assistantContent = `Error: ${event.error}`;
                        }
                    } catch { /* ignore */ }
                }
            }

            if (assistantContent) {
                setMessages((prev) => [
                    ...prev,
                    { role: "assistant", content: assistantContent },
                ]);
            }
        } catch (err) {
            setMessages((prev) => [
                ...prev,
                {
                    role: "assistant",
                    content: `Sorry, I encountered an error: ${err instanceof Error ? err.message : "Unknown error"}`,
                },
            ]);
        } finally {
            setLoading(false);
        }
    }, [input, loading, messages, repositoryId]);

    return (
        <div className="flex flex-col h-full">
            {/* Chat header */}
            <div className="flex items-center gap-2 px-4 py-3 border-b border-border/50 shrink-0">
                <Bot className="h-4 w-4 text-emerald-400" />
                <span className="text-sm font-semibold">Report Assistant</span>
            </div>

            {/* Messages area */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4 min-h-0">
                {messages.length === 0 && (
                    <div className="flex flex-col items-center justify-center h-full text-center gap-3 opacity-60">
                        <MessageSquare className="h-10 w-10 text-muted-foreground" />
                        <div>
                            <p className="text-sm font-medium">Ask about the report</p>
                            <p className="text-xs text-muted-foreground mt-1">
                                Try &quot;What are the top 3 risks?&quot; or &quot;How much will it cost to fix critical issues?&quot;
                            </p>
                        </div>
                    </div>
                )}
                {messages.map((msg, i) => (
                    <div key={i} className={`flex gap-2.5 ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                        {msg.role === "assistant" && (
                            <div className="shrink-0 mt-0.5 p-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 h-fit">
                                <Bot className="h-3.5 w-3.5 text-emerald-400" />
                            </div>
                        )}
                        <div
                            className={`max-w-[85%] rounded-xl px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
                                msg.role === "user"
                                    ? "bg-primary text-primary-foreground rounded-br-sm"
                                    : "bg-muted/60 border border-border/50 rounded-bl-sm"
                            }`}
                        >
                            {msg.content}
                        </div>
                        {msg.role === "user" && (
                            <div className="shrink-0 mt-0.5 p-1.5 rounded-lg bg-primary/10 border border-primary/20 h-fit">
                                <User className="h-3.5 w-3.5 text-primary" />
                            </div>
                        )}
                    </div>
                ))}
                {loading && (
                    <div className="flex gap-2.5">
                        <div className="shrink-0 mt-0.5 p-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 h-fit">
                            <Bot className="h-3.5 w-3.5 text-emerald-400" />
                        </div>
                        <div className="bg-muted/60 border border-border/50 rounded-xl rounded-bl-sm px-4 py-3">
                            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                        </div>
                    </div>
                )}
                <div ref={bottomRef} />
            </div>

            {/* Input area */}
            <div className="shrink-0 border-t border-border/50 p-3">
                <div className="flex items-center gap-2">
                    <input
                        type="text"
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
                        placeholder="Ask about the report..."
                        disabled={loading}
                        className="flex-1 bg-muted/40 border border-border/50 rounded-lg px-3 py-2 text-sm placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
                    />
                    <Button
                        size="sm"
                        onClick={sendMessage}
                        disabled={!input.trim() || loading}
                        className="h-9 w-9 p-0 shrink-0"
                    >
                        <Send className="h-4 w-4" />
                    </Button>
                </div>
            </div>
        </div>
    );
}

/* ─── Main Page ────────────────────────────────────────────────────────────── */

export default function ProjectPage() {
    const params = useParams();
    const router = useRouter();
    const id = params.id as string;

    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [repository, setRepository] = useState<Repository | null>(null);

    const fetchData = useCallback(async () => {
        try {
            setLoading(true);
            const res = await fetch(`/api/reports/${id}`);
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || `HTTP ${res.status}`);
            }
            const data = await res.json();
            setRepository(data.repository);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Unknown error");
        } finally {
            setLoading(false);
        }
    }, [id]);

    useEffect(() => {
        if (id) fetchData();
    }, [id, fetchData]);

    /* Loading */
    if (loading) {
        return (
            <div className="min-h-screen bg-background flex items-center justify-center">
                <div className="flex flex-col items-center gap-4">
                    <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">Loading project...</p>
                </div>
            </div>
        );
    }

    /* Error */
    if (error || !repository) {
        return (
            <div className="min-h-screen bg-background flex items-center justify-center">
                <div className="text-center space-y-4">
                    <XCircle className="h-12 w-12 text-red-400 mx-auto" />
                    <h2 className="text-xl font-semibold">Failed to load project</h2>
                    <p className="text-sm text-muted-foreground">{error}</p>
                    <button onClick={() => router.back()} className="text-sm text-muted-foreground hover:text-foreground underline">
                        Go back
                    </button>
                </div>
            </div>
        );
    }

    const hasReport = !!repository.compiledReport;

    return (
        <div className="h-screen flex flex-col bg-background overflow-hidden">
            {/* ── Header ──────────────────────────────────────────── */}
            <header className="shrink-0 bg-background/80 backdrop-blur-md border-b border-border/50 z-50">
                <div className="max-w-[1920px] mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <Link href="/" className="p-2 -ml-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors">
                            <ArrowLeft className="h-4 w-4" />
                        </Link>
                        <div>
                            <h1 className="text-sm font-semibold flex items-center gap-2">
                                <Github className="h-4 w-4 text-muted-foreground" />
                                {repository.fullName}
                            </h1>
                            <div className="flex items-center gap-2 mt-0.5">
                                {repository.framework && (
                                    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground uppercase tracking-wider">
                                        {repository.framework}
                                    </span>
                                )}
                                {repository.compiledReportAt && (
                                    <span className="text-[10px] text-muted-foreground">
                                        Report compiled {new Date(repository.compiledReportAt).toLocaleDateString("en-US", {
                                            month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit",
                                        })}
                                    </span>
                                )}
                            </div>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <Link href={`/reports/${id}`}>
                            <Button variant="outline" size="sm" className="text-xs gap-1.5">
                                <FileText className="h-3.5 w-3.5" />
                                Raw Reports
                            </Button>
                        </Link>
                    </div>
                </div>
            </header>

            {/* ── Body: Chat + Report Side-by-Side ────────────────── */}
            <div className="flex-1 flex min-h-0 overflow-hidden">
                {/* Left: Chat Panel */}
                {hasReport && (
                    <div className="w-[380px] shrink-0 border-r border-border/50 bg-card/30 flex flex-col min-h-0">
                        <ChatPanel repositoryId={id} />
                    </div>
                )}

                {/* Right: Compiled Report */}
                <div className="flex-1 overflow-y-auto min-w-0">
                    {hasReport ? (
                        <div className="max-w-4xl mx-auto px-6 sm:px-10 py-8">
                            <MarkdownReport content={repository.compiledReport!} />
                        </div>
                    ) : (
                        <div className="flex flex-col items-center justify-center h-full gap-4 text-center px-8">
                            <FileText className="h-16 w-16 text-muted-foreground/30" />
                            <div>
                                <h2 className="text-lg font-semibold">No Compiled Report Yet</h2>
                                <p className="text-sm text-muted-foreground mt-1 max-w-md">
                                    Run the analysis pipeline or compile the report from the dashboard to generate the founder-optimized scalability report.
                                </p>
                            </div>
                            <Link href="/">
                                <Button variant="outline">Go to Dashboard</Button>
                            </Link>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
