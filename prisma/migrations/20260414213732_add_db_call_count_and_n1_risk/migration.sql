-- AlterTable
ALTER TABLE "CodeFlow" ADD COLUMN     "dbCallCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "hasN1Risk" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "CodeFlow_repositoryId_dbCallCount_idx" ON "CodeFlow"("repositoryId", "dbCallCount");
