import { PrismaClient } from '@/generated/prisma/client'
//import { PrismaPg } from '@prisma/adapter-pg'

const globalForPrisma = global as unknown as {
    prisma: PrismaClient | undefined
}

// @ts-expect-error - PrismaClient constructor works without args at runtime
const prisma = globalForPrisma.prisma || new PrismaClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma

export default prisma