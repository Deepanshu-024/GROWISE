// ─── Findings Parser ──────────────────────────────────────────────────────────
//
// Parses the structured text format emitted by all agents into typed objects.
//
// Input format:
//   --- CRITICAL FINDINGS ---
//   [DB-1] Short title
//   File: path/to/file.ts (Lx-Ly)
//   Evidence: ...
//   Impact: ...
//   Fix: ...
//
//   --- WARNING FINDINGS ---
//   ...
//
//   --- INFO ---
//   ...

export type FindingSeverity = "critical" | "warning" | "info";

export interface ParsedFinding {
    id: string;
    severity: FindingSeverity;
    title: string;
    file?: string;
    evidence?: string;
    impact?: string;
    fix?: string;
}

export interface ParsedReport {
    findings: ParsedFinding[];
    criticalCount: number;
    warningCount: number;
    infoCount: number;
    totalCount: number;
}

/**
 * Parse raw agent findings text into structured objects.
 */
export function parseFindings(raw: string | null | undefined): ParsedReport {
    const empty: ParsedReport = {
        findings: [],
        criticalCount: 0,
        warningCount: 0,
        infoCount: 0,
        totalCount: 0,
    };

    if (!raw || raw.trim().length === 0) return empty;

    const findings: ParsedFinding[] = [];
    let currentSeverity: FindingSeverity = "info";

    // Split into lines and process
    const lines = raw.split("\n");

    let currentFinding: Partial<ParsedFinding> | null = null;
    let currentField: string | null = null;

    for (const line of lines) {
        const trimmed = line.trim();

        // Section headers
        if (/^-+\s*CRITICAL\s*(FINDINGS)?\s*-+$/i.test(trimmed)) {
            flushFinding();
            currentSeverity = "critical";
            continue;
        }
        if (/^-+\s*WARNING\s*(FINDINGS)?\s*-+$/i.test(trimmed)) {
            flushFinding();
            currentSeverity = "warning";
            continue;
        }
        if (/^-+\s*INFO\s*-+$/i.test(trimmed)) {
            flushFinding();
            currentSeverity = "info";
            continue;
        }

        // Skip empty lines / dividers
        if (trimmed === "" || /^-{3,}$/.test(trimmed)) {
            continue;
        }

        // Finding ID line: [DB-1] Title text
        const idMatch = trimmed.match(/^\[([A-Z]+-\d+)\]\s*(.+)$/);
        if (idMatch) {
            flushFinding();
            currentFinding = {
                id: idMatch[1],
                severity: currentSeverity,
                title: idMatch[2],
            };
            currentField = null;
            continue;
        }

        // Field lines: "File:", "Evidence:", "Impact:", "Fix:"
        const fieldMatch = trimmed.match(/^(File|Evidence|Impact|Fix|Use INFO[^:]*|Use):\s*(.*)$/i);
        if (fieldMatch && currentFinding) {
            const fieldName = fieldMatch[1].toLowerCase();
            const value = fieldMatch[2];

            if (fieldName === "file") {
                currentFinding.file = value;
                currentField = "file";
            } else if (fieldName === "evidence") {
                currentFinding.evidence = value;
                currentField = "evidence";
            } else if (fieldName === "impact") {
                currentFinding.impact = value;
                currentField = "impact";
            } else if (fieldName === "fix") {
                currentFinding.fix = value;
                currentField = "fix";
            } else if (fieldName.startsWith("use")) {
                // "Use INFO only for..." — treat as evidence for INFO findings
                currentFinding.evidence = (currentFinding.evidence ? currentFinding.evidence + " " : "") + trimmed;
                currentField = "evidence";
            }
            continue;
        }

        // Continuation line — append to current field
        if (currentFinding && currentField && trimmed.length > 0) {
            const key = currentField as keyof ParsedFinding;
            if (key === "evidence" || key === "impact" || key === "fix" || key === "file") {
                currentFinding[key] = (currentFinding[key] ? currentFinding[key] + " " : "") + trimmed;
            }
        }
    }

    flushFinding();

    function flushFinding() {
        if (currentFinding && currentFinding.id && currentFinding.title) {
            findings.push({
                id: currentFinding.id,
                severity: currentFinding.severity ?? "info",
                title: currentFinding.title,
                file: currentFinding.file,
                evidence: currentFinding.evidence,
                impact: currentFinding.impact,
                fix: currentFinding.fix,
            });
        }
        currentFinding = null;
        currentField = null;
    }

    return {
        findings,
        criticalCount: findings.filter((f) => f.severity === "critical").length,
        warningCount: findings.filter((f) => f.severity === "warning").length,
        infoCount: findings.filter((f) => f.severity === "info").length,
        totalCount: findings.length,
    };
}

// ─── Archetype Display Helpers ────────────────────────────────────────────────

const ARCHETYPE_META: Record<string, { label: string; emoji: string; color: string }> = {
    "database-heavy": { label: "Database", emoji: "🗄️", color: "text-blue-400" },
    "auth-heavy": { label: "Authentication", emoji: "🔐", color: "text-purple-400" },
    "compute-heavy": { label: "Compute", emoji: "⚡", color: "text-yellow-400" },
    "ai-powered": { label: "AI / ML", emoji: "🤖", color: "text-cyan-400" },
    "realtime": { label: "Realtime", emoji: "📡", color: "text-green-400" },
    "event-driven": { label: "Event-Driven", emoji: "🔔", color: "text-orange-400" },
    "financial-transactional": { label: "Payment", emoji: "💳", color: "text-emerald-400" },
    "content-heavy": { label: "Content / CDN", emoji: "🌐", color: "text-pink-400" },
};

export function getArchetypeMeta(archetype: string) {
    return ARCHETYPE_META[archetype] ?? { label: archetype, emoji: "📋", color: "text-muted-foreground" };
}
