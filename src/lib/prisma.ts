import { PrismaClient } from '@/generated/prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'

const globalForPrisma = global as unknown as {
    prisma: PrismaClient
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
})

const prisma = globalForPrisma.prisma || new PrismaClient({
    adapter: new PrismaPg(pool),
})

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma

export default prisma