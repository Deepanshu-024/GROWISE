import { Prisma } from "@/generated/prisma/client";
import prisma from "@/lib/prisma";

export async function findRepositoryByAnyId<T extends Prisma.RepositorySelect>(
  repositoryIdOrId: string,
  select: T
): Promise<Prisma.RepositoryGetPayload<{ select: T }> | null> {
  return prisma.repository.findFirst({
    where: {
      OR: [
        { id: repositoryIdOrId },
        { repositoryId: repositoryIdOrId },
      ],
    },
    select,
  }) as Promise<Prisma.RepositoryGetPayload<{ select: T }> | null>;
}
