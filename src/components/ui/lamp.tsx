"use client";
import React from "react";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";

export default function LampDemo() {
  return (
    <LampContainer>
      <motion.h1
        initial={{ opacity: 0.5, y: 100 }}
        whileInView={{ opacity: 1, y: 0 }}
        transition={{
          delay: 0.3,
          duration: 0.8,
          ease: "easeInOut",
        }}
        className="mt-8 bg-gradient-to-br from-slate-300 to-slate-500 py-4 bg-clip-text text-center text-4xl font-medium tracking-tight text-transparent md:text-7xl"
      >
        Build lamps <br /> the right way
      </motion.h1>
    </LampContainer>
  );
}

export const LampContainer = ({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) => {
  return (
    <div
      className={cn(
        "relative flex min-h-screen max-sm:min-h-[85vh] flex-col items-center justify-center overflow-hidden bg-slate-950 w-full rounded-md z-0",
        className
      )}
    >
      <div className="relative flex w-full flex-1 scale-y-125 items-center justify-center isolate z-0 ">
        <motion.div
          initial={{ opacity: 0.5, width: "20rem" }}
          whileInView={{ opacity: 1, width: "45rem" }}
          transition={{
            delay: 0.3,
            duration: 0.8,
            ease: "easeInOut",
          }}
          style={{
            backgroundImage: `conic-gradient(var(--conic-position), var(--tw-gradient-stops))`,
          }}
          className="absolute inset-auto right-1/2 h-72 overflow-visible w-[45rem] bg-gradient-conic from-emerald-500 via-transparent to-transparent text-white [--conic-position:from_70deg_at_center_top]"
        >
          <div className="absolute  w-[100%] left-0 bg-slate-950 h-40 bottom-0 z-20 [mask-image:linear-gradient(to_top,white,transparent)]" />
          <div className="absolute  w-40 h-[100%] left-0 bg-slate-950  bottom-0 z-20 [mask-image:linear-gradient(to_right,white,transparent)]" />
        </motion.div>
        <motion.div
          initial={{ opacity: 0.5, width: "20rem" }}
          whileInView={{ opacity: 1, width: "45rem" }}
          transition={{
            delay: 0.3,
            duration: 0.8,
            ease: "easeInOut",
          }}
          style={{
            backgroundImage: `conic-gradient(var(--conic-position), var(--tw-gradient-stops))`,
          }}
          className="absolute inset-auto left-1/2 h-72 w-[45rem] bg-gradient-conic from-transparent via-transparent to-emerald-500 text-white [--conic-position:from_290deg_at_center_top]"
        >
          <div className="absolute  w-40 h-[100%] right-0 bg-slate-950  bottom-0 z-20 [mask-image:linear-gradient(to_left,white,transparent)]" />
          <div className="absolute  w-[100%] right-0 bg-slate-950 h-40 bottom-0 z-20 [mask-image:linear-gradient(to_top,white,transparent)]" />
        </motion.div>
        <div className="absolute top-1/2 h-48 w-full translate-y-12 scale-x-150 bg-slate-950 blur-2xl"></div>
        <div className="absolute top-1/2 z-50 h-48 w-full bg-transparent opacity-10 backdrop-blur-md"></div>
        <div className="absolute inset-auto z-50 h-48 w-[35rem] max-xl:w-[24rem] -translate-y-1/2 max-xl:-translate-y-[18.5rem] rounded-full bg-emerald-500 opacity-50 blur-3xl"></div>
        <motion.div
          initial={{ width: "var(--glow-initial)" }}
          whileInView={{ width: "var(--glow-active)" }}
          transition={{
            delay: 0.3,
            duration: 0.8,
            ease: "easeInOut",
          }}
          className="absolute inset-auto z-30 h-48 w-96 -translate-y-[6rem] max-xl:-translate-y-[18rem] rounded-full bg-emerald-400 blur-2xl [--glow-initial:12rem] [--glow-active:20rem] max-xl:[--glow-initial:12rem] max-xl:[--glow-active:18rem]"
        ></motion.div>
        <motion.div
          initial={{ width: "var(--line-initial)" }}
          whileInView={{ width: "var(--line-active)" }}
          transition={{
            delay: 0.3,
            duration: 0.8,
            ease: "easeInOut",
          }}
          className="absolute inset-auto z-50 h-0.5 w-[35rem] -translate-y-[7rem] max-xl:-translate-y-[19rem] bg-emerald-400 [--line-initial:20rem] [--line-active:30rem] max-xl:[--line-initial:16rem] max-xl:[--line-active:24rem]"
        ></motion.div>

        <div className="absolute inset-auto z-40 h-44 w-full -translate-y-[12.5rem] max-xl:-translate-y-[24.5rem] bg-slate-950 "></div>
      </div>

      <div className="relative z-50 flex -translate-y-52 max-xl:-translate-y-[15rem] max-sm:-translate-y-[12rem] flex-col items-center px-5 w-full">
        {children}
      </div>
    </div>
  );
};
