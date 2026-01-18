import { PrismaClient } from '../generated/prisma/client'
//import { PrismaPg } from '@prisma/adapter-pg'

const globalForPrisma = global as unknown as {
    prisma: PrismaClient | undefined
}

const prisma = globalForPrisma.prisma || new PrismaClient({} as any)

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma

export default prisma