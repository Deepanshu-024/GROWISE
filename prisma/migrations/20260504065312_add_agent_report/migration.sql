-- CreateTable
CREATE TABLE "AgentReport" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "archetype" TEXT NOT NULL,
    "rawFindings" TEXT,
    "totalToolCalls" INTEGER NOT NULL DEFAULT 0,
    "executionTimeMs" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentReport_repositoryId_idx" ON "AgentReport"("repositoryId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentReport_repositoryId_archetype_key" ON "AgentReport"("repositoryId", "archetype");

-- AddForeignKey
ALTER TABLE "AgentReport" ADD CONSTRAINT "AgentReport_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;
