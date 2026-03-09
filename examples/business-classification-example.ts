// /**
//  * Example: Complete Repository Analysis Flow
//  * 
//  * This example demonstrates how to use both framework detection and business classification
//  * in a complete repository analysis workflow.
//  */

// import { checkPackageAndFramework } from "../actions/analysis/repository-analysis";
// import { classifyBusinessContext } from "../actions/analysis/business-classification";

// /**
//  * Complete analysis of a repository including framework detection and business classification
//  */
// export async function performCompleteAnalysis(
//     repositoryId: string,
//     repoFullName: string,
//     installationId?: string
// ) {
//     console.log("=".repeat(60));
//     console.log("COMPLETE REPOSITORY ANALYSIS");
//     console.log("=".repeat(60));
//     console.log(`Repository: ${repoFullName}`);
//     console.log(`Repository ID: ${repositoryId}`);
//     console.log("");

//     // ========================================
//     // STEP 1: Framework Detection
//     // ========================================
//     console.log("STEP 1: Framework Detection");
//     console.log("-".repeat(60));

//     const frameworkResult = await checkPackageAndFramework(
//         repositoryId,
//         repoFullName,
//         installationId
//     );

//     if (frameworkResult.error) {
//         console.error("❌ Framework detection failed:", frameworkResult.error);
//         return {
//             success: false,
//             error: frameworkResult.error,
//             step: "framework_detection",
//         };
//     }

//     if (!frameworkResult.isSupported) {
//         console.error("❌ Framework not supported");
//         return {
//             success: false,
//             error: "Only React and Next.js projects are supported",
//             step: "framework_detection",
//         };
//     }

//     console.log("✅ Framework detected:", frameworkResult.framework);
//     console.log("✅ Default branch:", frameworkResult.defaultBranch);
//     console.log("✅ Base directory:", frameworkResult.baseDirectory);
//     console.log("");

//     // ========================================
//     // STEP 2: Business Classification
//     // ========================================
//     console.log("STEP 2: Business Classification");
//     console.log("-".repeat(60));

//     const classificationResult = await classifyBusinessContext(
//         repositoryId,
//         installationId
//     );

//     if (classificationResult.error) {
//         console.error("❌ Business classification failed:", classificationResult.error);
//         return {
//             success: false,
//             error: classificationResult.error,
//             step: "business_classification",
//             frameworkData: {
//                 framework: frameworkResult.framework,
//                 defaultBranch: frameworkResult.defaultBranch,
//             },
//         };
//     }

//     const classification = classificationResult.classification!;

//     console.log("✅ Business Type:", classification.businessType.primary);
//     console.log("   Confidence:", classification.businessType.confidence);
//     console.log("   Secondary:", classification.businessType.secondary.join(", ") || "None");
//     console.log("");
//     console.log("✅ Audience Size:", classification.audienceSize);
//     console.log("");
//     console.log("✅ Usage Patterns:", classification.usagePattern.join(", "));
//     console.log("");
//     console.log("✅ Risk Profile:", classification.riskProfile);
//     console.log("");
//     console.log("✅ Engineering Constraints:");
//     console.log("   - Latency:", classification.constraints.latency);
//     console.log("   - Consistency:", classification.constraints.consistency);
//     console.log("   - Failure Cost:", classification.constraints.failureCost);
//     console.log("   - Security:", classification.constraints.security);
//     console.log("   - Compliance:", classification.constraints.compliance);
//     console.log("   - Cost Sensitivity:", classification.constraints.costSensitivity);
//     console.log("");
//     console.log("✅ Scale Breakpoints:");
//     console.log("   - 10k users:", classification.scaleBreakpoints["10k"]);
//     console.log("   - 100k users:", classification.scaleBreakpoints["100k"]);
//     console.log("   - 1M users:", classification.scaleBreakpoints["1M"]);
//     console.log("");
//     console.log("✅ Evidence:");
//     classification.evidence.forEach((evidence, index) => {
//         console.log(`   ${index + 1}. ${evidence}`);
//     });
//     console.log("");

//     // ========================================
//     // STEP 3: Return Complete Analysis
//     // ========================================
//     console.log("=".repeat(60));
//     console.log("ANALYSIS COMPLETE");
//     console.log("=".repeat(60));

//     return {
//         success: true,
//         repository: {
//             id: repositoryId,
//             fullName: repoFullName,
//         },
//         framework: {
//             type: frameworkResult.framework,
//             isSupported: frameworkResult.isSupported,
//             defaultBranch: frameworkResult.defaultBranch,
//             baseDirectory: frameworkResult.baseDirectory,
//             packageJson: frameworkResult.packageJson,
//             repoContent: frameworkResult.repoContent,
//         },
//         businessClassification: classification,
//     };
// }

// /**
//  * Example: Quick classification check
//  * Assumes framework detection has already been completed
//  */
// export async function quickClassificationCheck(repositoryId: string) {
//     console.log("Quick Classification Check");
//     console.log("-".repeat(60));

//     const result = await classifyBusinessContext(repositoryId);

//     if (result.error) {
//         console.error("Error:", result.error);
//         return null;
//     }

//     const classification = result.classification!;

//     return {
//         businessType: classification.businessType.primary,
//         confidence: classification.businessType.confidence,
//         audienceSize: classification.audienceSize,
//         riskProfile: classification.riskProfile,
//         keyConstraints: {
//             latency: classification.constraints.latency,
//             security: classification.constraints.security,
//             compliance: classification.constraints.compliance,
//         },
//     };
// }

// /**
//  * Example: Get scale recommendations based on classification
//  */
// export async function getScaleRecommendations(repositoryId: string) {
//     const result = await classifyBusinessContext(repositoryId);

//     if (result.error || !result.classification) {
//         return {
//             error: result.error || "Classification failed",
//         };
//     }

//     const classification = result.classification;

//     return {
//         currentScale: classification.audienceSize,
//         recommendations: {
//             immediate: generateRecommendations(classification, "current"),
//             at10k: {
//                 breakpoints: classification.scaleBreakpoints["10k"],
//                 recommendations: generateRecommendations(classification, "10k"),
//             },
//             at100k: {
//                 breakpoints: classification.scaleBreakpoints["100k"],
//                 recommendations: generateRecommendations(classification, "100k"),
//             },
//             at1M: {
//                 breakpoints: classification.scaleBreakpoints["1M"],
//                 recommendations: generateRecommendations(classification, "1M"),
//             },
//         },
//         riskLevel: classification.riskProfile,
//         criticalConstraints: getCriticalConstraints(classification.constraints),
//     };
// }

// /**
//  * Helper: Generate recommendations based on classification and scale
//  */
// function generateRecommendations(
//     classification: any,
//     scale: "current" | "10k" | "100k" | "1M"
// ): string[] {
//     const recommendations: string[] = [];

//     // Security recommendations
//     if (classification.constraints.security === "high") {
//         recommendations.push("Implement comprehensive security audits");
//         recommendations.push("Add rate limiting and DDoS protection");
//     }

//     // Latency recommendations
//     if (classification.constraints.latency === "ultra-low") {
//         recommendations.push("Implement edge caching");
//         recommendations.push("Use CDN for static assets");
//     }

//     // Compliance recommendations
//     if (classification.constraints.compliance === "strict") {
//         recommendations.push("Ensure GDPR/HIPAA compliance");
//         recommendations.push("Implement audit logging");
//     }

//     // Scale-specific recommendations
//     if (scale === "100k" || scale === "1M") {
//         recommendations.push("Consider database sharding");
//         recommendations.push("Implement horizontal scaling");
//         recommendations.push("Add caching layer (Redis/Memcached)");
//     }

//     return recommendations;
// }

// /**
//  * Helper: Identify critical constraints
//  */
// function getCriticalConstraints(constraints: any): string[] {
//     const critical: string[] = [];

//     if (constraints.latency === "ultra-low") {
//         critical.push("Ultra-low latency required");
//     }
//     if (constraints.security === "high") {
//         critical.push("High security sensitivity");
//     }
//     if (constraints.compliance === "strict") {
//         critical.push("Strict compliance requirements");
//     }
//     if (constraints.failureCost === "high") {
//         critical.push("High failure cost");
//     }

//     return critical;
// }
