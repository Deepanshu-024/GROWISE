 export interface UiImport {
    importedNames: string[];
    rawPath: string;
    resolvedPath: string | null;
    isServerAction: boolean;
}

export interface LLMUiImportResult {
    imports: UiImport[];
}

/** One file's resolved imports inside a batch LLM response */
export interface LLMBatchFileImports {
    filePath: string;
    imports: UiImport[];
}

/** Full response from a single batched LLM call (covers up to BATCH_SIZE files) */
export interface LLMBatchImportResult {
    files: LLMBatchFileImports[];
}

/** Aggregated entry for a single (functionName + definedIn) pair */
export interface FrequencyEntry {
    name: string;
    definedIn: string | null;
    isServerAction: boolean;
    uiImportCount: number;
    frequency: "high" | "medium" | "low";
    importedInUiFiles: string[];
}

export interface FrequencyMap {
    repository: string;
    summary: {
        totalUiFiles: number;
        totalUiFilesProcessed: number;
        totalFunctionsTracked: number;
        highFrequencyCount: number;
        mediumFrequencyCount: number;
        lowFrequencyCount: number;
        serverActionsFound: number;
        skippedFiles: string[];
    };
    functions: FrequencyEntry[];
}

export type FileCache = Map<string, string>;
