-- AlterTable
ALTER TABLE "Repository" ADD COLUMN     "graphBuiltAt" TIMESTAMP(3),
ADD COLUMN     "graphStatus" TEXT;

-- CreateTable
CREATE TABLE "CodeNode" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "qualifiedName" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "lineStart" INTEGER,
    "lineEnd" INTEGER,
    "language" TEXT,
    "parentName" TEXT,
    "params" TEXT,
    "returnType" TEXT,
    "fileHash" TEXT,
    "extra" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CodeNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CodeEdge" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sourceQualified" TEXT NOT NULL,
    "targetQualified" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "line" INTEGER NOT NULL DEFAULT 0,
    "extra" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CodeEdge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CodeFlow" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "entryPointQn" TEXT NOT NULL,
    "depth" INTEGER NOT NULL,
    "nodeCount" INTEGER NOT NULL,
    "fileCount" INTEGER NOT NULL,
    "criticality" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "pathJson" JSONB NOT NULL DEFAULT '[]',
    "filesJson" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CodeFlow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CodeNode_repositoryId_idx" ON "CodeNode"("repositoryId");

-- CreateIndex
CREATE INDEX "CodeNode_repositoryId_filePath_idx" ON "CodeNode"("repositoryId", "filePath");

-- CreateIndex
CREATE INDEX "CodeNode_repositoryId_kind_idx" ON "CodeNode"("repositoryId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "CodeNode_repositoryId_qualifiedName_key" ON "CodeNode"("repositoryId", "qualifiedName");

-- CreateIndex
CREATE INDEX "CodeEdge_repositoryId_idx" ON "CodeEdge"("repositoryId");

-- CreateIndex
CREATE INDEX "CodeEdge_repositoryId_sourceQualified_idx" ON "CodeEdge"("repositoryId", "sourceQualified");

-- CreateIndex
CREATE INDEX "CodeEdge_repositoryId_targetQualified_idx" ON "CodeEdge"("repositoryId", "targetQualified");

-- CreateIndex
CREATE INDEX "CodeEdge_repositoryId_kind_idx" ON "CodeEdge"("repositoryId", "kind");

-- CreateIndex
CREATE INDEX "CodeFlow_repositoryId_idx" ON "CodeFlow"("repositoryId");

-- CreateIndex
CREATE INDEX "CodeFlow_repositoryId_criticality_idx" ON "CodeFlow"("repositoryId", "criticality");

-- AddForeignKey
ALTER TABLE "CodeNode" ADD CONSTRAINT "CodeNode_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CodeEdge" ADD CONSTRAINT "CodeEdge_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CodeFlow" ADD CONSTRAINT "CodeFlow_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;
