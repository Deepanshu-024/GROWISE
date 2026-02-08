# Business Classification Analysis

This module provides business context and engineering constraint classification for React/Next.js repositories.

## Overview

The business classification system analyzes a repository to infer:
1. **Business Type** - What kind of business this software serves (B2C, B2B, B2B2C, etc.)
2. **Engineering Constraints** - What constraints it operates under (latency, security, compliance, etc.)
3. **Scale Behavior** - How the code would behave under different audience sizes

## Files

### 1. `prompts/bussinessClassification.ts`
Contains the comprehensive prompt template that guides the LLM to analyze repositories and classify their business context.

**Key Classification Areas:**
- Business Type Classification (B2C, B2B, B2B2C, Internal, Developer Tooling)
- Target Audience Size (Micro to Massive scale)
- Usage Pattern Classification (Read-heavy, Write-heavy, Real-time, etc.)
- Engineering Constraint Extraction (Latency, Consistency, Security, etc.)
- Risk Profile (Low, Medium, High risk domains)
- Scale Breakpoint Analysis (10k, 100k, 1M users)

### 2. `actions/analysis/business-classification.ts`
Server action that executes the business classification analysis.

**Features:**
- Fetches repository data from database
- Validates framework analysis is complete
- Uses GPT-4o for advanced analysis
- Returns structured JSON classification

## Usage

### Prerequisites

1. Repository must be analyzed for framework first:
```typescript
import { checkPackageAndFramework } from "@/actions/analysis/repository-analysis";

// First, analyze the framework
const frameworkResult = await checkPackageAndFramework(
    repositoryId,
    repoFullName,
    installationId
);
```

2. Ensure environment variables are set:
```env
OPENAI_API_KEY=your_openai_api_key
```

### Basic Usage

```typescript
import { classifyBusinessContext } from "@/actions/analysis/business-classification";

// Classify business context
const result = await classifyBusinessContext(
    repositoryId,
    installationId // optional, will fetch from database if not provided
);

if (result.error) {
    console.error("Classification failed:", result.error);
} else {
    console.log("Business Type:", result.classification.businessType);
    console.log("Audience Size:", result.classification.audienceSize);
    console.log("Risk Profile:", result.classification.riskProfile);
    console.log("Constraints:", result.classification.constraints);
}
```

### Response Structure

```typescript
{
    classification: {
        businessType: {
            primary: string,           // e.g., "B2C", "B2B", "B2B2C"
            secondary: string[],       // Alternative classifications
            confidence: string         // "High", "Medium", "Low"
        },
        audienceSize: string,          // e.g., "Small (1k–50k)"
        usagePattern: string[],        // e.g., ["Read-heavy", "Real-time"]
        constraints: {
            latency: string,           // "low", "medium", "ultra-low"
            consistency: string,       // "eventual", "strong"
            failureCost: string,       // "low", "medium", "high"
            security: string,          // "low", "medium", "high"
            compliance: string,        // "none", "moderate", "strict"
            costSensitivity: string    // "low", "medium", "high"
        },
        riskProfile: string,           // "Low-risk", "Medium-risk", "High-risk"
        scaleBreakpoints: {
            "10k": string,             // What breaks at 10k users
            "100k": string,            // What breaks at 100k users
            "1M": string               // What breaks at 1M users
        },
        evidence: string[]             // Signals used for inference
    }
}
```

## Integration Example

Here's a complete example of integrating business classification into a repository analysis flow:

```typescript
"use server";

import { checkPackageAndFramework } from "@/actions/analysis/repository-analysis";
import { classifyBusinessContext } from "@/actions/analysis/business-classification";

export async function analyzeRepository(
    repositoryId: string,
    repoFullName: string,
    installationId?: string
) {
    // Step 1: Analyze framework
    console.log("Step 1: Analyzing framework...");
    const frameworkResult = await checkPackageAndFramework(
        repositoryId,
        repoFullName,
        installationId
    );

    if (frameworkResult.error || !frameworkResult.isSupported) {
        return {
            error: frameworkResult.error || "Framework not supported",
        };
    }

    console.log(`Framework detected: ${frameworkResult.framework}`);

    // Step 2: Classify business context
    console.log("Step 2: Classifying business context...");
    const classificationResult = await classifyBusinessContext(
        repositoryId,
        installationId
    );

    if (classificationResult.error) {
        return {
            error: classificationResult.error,
        };
    }

    // Step 3: Return combined analysis
    return {
        framework: frameworkResult.framework,
        packageJson: frameworkResult.packageJson,
        classification: classificationResult.classification,
    };
}
```

## How It Works

1. **Data Retrieval**: Fetches repository metadata from the database (framework, package.json, repo structure)
2. **Validation**: Ensures framework analysis is complete before proceeding
3. **Token Generation**: Generates GitHub App installation token for potential API calls
4. **LLM Analysis**: Uses GPT-4o with the business classification prompt to analyze:
   - Package.json dependencies
   - Repository structure
   - Framework patterns
   - Naming conventions
5. **JSON Parsing**: Extracts and validates the structured classification result
6. **Response**: Returns comprehensive business and engineering insights

## Prompt Strategy

The prompt is designed to:
- **Minimize Tool Usage**: Prefer inference from available data over API calls
- **Be Decisive**: Avoid vague or hedging language
- **Focus on Signals**: Extract concrete evidence for classifications
- **Be Actionable**: Provide insights useful for downstream analysis

## Error Handling

Common errors and solutions:

| Error | Cause | Solution |
|-------|-------|----------|
| "Unauthorized" | User not authenticated | Ensure user is logged in via Clerk |
| "Repository not found in database" | Repository not analyzed yet | Run framework analysis first |
| "Repository framework not analyzed yet" | Framework detection incomplete | Run `checkPackageAndFramework` first |
| "GitHub App not connected" | No installation ID | Connect GitHub App via settings |
| "Failed to parse classification result" | LLM returned invalid JSON | Check OpenAI API status and prompt |

## Performance Considerations

- **Model**: Uses GPT-4o for advanced reasoning capabilities
- **Cost**: ~$0.01-0.05 per classification (depending on repository complexity)
- **Latency**: Typically 5-15 seconds for analysis
- **Caching**: Results can be cached in database for repeated queries

## Future Enhancements

Potential improvements:
1. **Agent Pattern**: Implement tool-calling agent for deeper repository inspection
2. **Database Caching**: Store classification results in database
3. **Incremental Updates**: Re-classify only when repository changes
4. **Confidence Scoring**: Add numerical confidence scores for classifications
5. **Multi-Model**: Support for alternative LLMs (Claude, Gemini)

## Related Files

- `actions/analysis/repository-analysis.ts` - Framework detection
- `actions/analysis/tools/agent-tools.ts` - GitHub API tools
- `src/lib/llm.ts` - LLM configuration
- `prompts/frameworkPrompt.ts` - Framework detection prompt
