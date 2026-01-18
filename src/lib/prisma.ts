import { PrismaClient } from '../generated/prisma/client'
//import { PrismaPg } from '@prisma/adapter-pg'

const globalForPrisma = global as unknown as {
    prisma: PrismaClient | undefined
}

// Lazy initialization - only create PrismaClient when actually accessed at runtime
function getPrismaClient(): PrismaClient {
    if (!globalForPrisma.prisma) {
        // Don't initialize during build
        if (typeof window === 'undefined' && process.env.NEXT_PHASE === 'phase-production-build') {
            // Return a dummy object during build that will throw if accessed
            return {} as PrismaClient
        }
        globalForPrisma.prisma = new PrismaClient({} as any)
    }
    return globalForPrisma.prisma
}

// Create a lazy getter
const prisma = new Proxy({} as PrismaClient, {
    get(_target, prop) {
        const client = getPrismaClient()
        const value = (client as any)[prop]
        if (value === undefined && typeof prop === 'string') {
            throw new Error(`PrismaClient property "${prop}" accessed during build phase`)
        }
        return typeof value === 'function' ? value.bind(client) : value
    }
})

if (process.env.NODE_ENV !== 'production') {
    globalForPrisma.prisma = prisma as PrismaClient
}

export default prisma