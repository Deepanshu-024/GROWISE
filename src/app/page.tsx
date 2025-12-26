'use client';

import { useTRPC } from "@/trpc/client";
import { useQuery } from "@tanstack/react-query";
import { trpc } from "@/utils/trpc";

export default function Home() {
  const { data } = useQuery(trpc().hello.queryOptions({ text: 'Deepanshu' }));

  return (
    <div>
      {JSON.stringify(data)}
    </div>
  );
}
