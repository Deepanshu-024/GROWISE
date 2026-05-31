/*
  Warnings:

  - You are about to drop the column `graphBuiltAt` on the `Repository` table. All the data in the column will be lost.
  - You are about to drop the column `graphStatus` on the `Repository` table. All the data in the column will be lost.
  - You are about to drop the `CodeEdge` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `CodeFlow` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `CodeNode` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[userId,repositoryId]` on the table `Repository` will be added. If there are existing duplicate values, this will fail.

*/
-- DropForeignKey
ALTER TABLE "CodeEdge" DROP CONSTRAINT "CodeEdge_repositoryId_fkey";

-- DropForeignKey
ALTER TABLE "CodeFlow" DROP CONSTRAINT "CodeFlow_repositoryId_fkey";

-- DropForeignKey
ALTER TABLE "CodeNode" DROP CONSTRAINT "CodeNode_repositoryId_fkey";

-- DropForeignKey
ALTER TABLE "Repository" DROP CONSTRAINT "Repository_userId_fkey";

-- DropIndex
DROP INDEX "Repository_repositoryId_key";

-- AlterTable
ALTER TABLE "Repository" DROP COLUMN "graphBuiltAt",
DROP COLUMN "graphStatus";

-- DropTable
DROP TABLE "CodeEdge";

-- DropTable
DROP TABLE "CodeFlow";

-- DropTable
DROP TABLE "CodeNode";

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "title" TEXT,
    "messages" JSONB[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChatMessage_repositoryId_idx" ON "ChatMessage"("repositoryId");

-- CreateIndex
CREATE INDEX "ChatMessage_repositoryId_createdAt_idx" ON "ChatMessage"("repositoryId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Repository_userId_repositoryId_key" ON "Repository"("userId", "repositoryId");

-- AddForeignKey
ALTER TABLE "Repository" ADD CONSTRAINT "Repository_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
