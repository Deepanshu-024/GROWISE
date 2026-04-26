/*
  Warnings:

  - A unique constraint covering the columns `[githubInstallationId]` on the table `User` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "githubAccessToken" TEXT,
ADD COLUMN     "githubAccessTokenExpiry" TIMESTAMP(3),
ADD COLUMN     "githubInstallationId" TEXT,
ADD COLUMN     "githubUsername" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_githubInstallationId_key" ON "User"("githubInstallationId");
