"use client"

import { SignInButton, SignUpButton, SignedIn, SignedOut, UserButton } from '@clerk/nextjs'
import { usePathname } from 'next/navigation'

const navLinks = [
  { label: "Home", href: "/" },
  { label: "Dashboard", href: "/dashboard" },
  { label: "Pricing", href: "/pricing" },
  { label: "Contact", href: "/contact" },
]

export default function Navigation() {
  const pathname = usePathname()

  return (
    <nav className="fixed top-0 w-full z-50 bg-background/80 backdrop-blur-md border-b border-border/50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center">
        {/* Logo — fixed width so center stays centered */}
        <div className="flex items-center gap-2.5 w-48">
          {/* <div className="w-8 h-8 bg-gradient-to-br from-emerald-400 to-emerald-600 rounded-lg flex items-center justify-center shadow-[0_0_12px_rgba(16,185,129,0.3)]">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M13 3h8v8" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M21 3L10 14" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M6 21c-1-3-1-7 2-10" stroke="white" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </div> */}
          <span className="font-semibold text-lg hidden sm:inline bg-gradient-to-r from-emerald-400 to-white bg-clip-text text-transparent">Gro(W)ise</span>
        </div>

        {/* Center Navigation — true center */}
        <div className="flex-1 hidden md:flex items-center justify-center gap-8">
          {navLinks.map(({ label, href }) => {
            const isActive = href === "/" ? pathname === "/" : pathname.startsWith(href) && href !== "#"
            return (
              <a
                key={label}
                href={href}
                className={`transition-colors text-sm ${isActive ? "text-foreground font-medium" : "text-muted-foreground hover:text-foreground"
                  }`}
              >
                {label}
              </a>
            )
          })}
        </div>

        {/* Auth Buttons — same fixed width as logo */}
        <div className="flex items-center justify-end gap-3 w-48">
          <SignedOut>
            <SignInButton>
              <button className="px-4 py-2 text-sm font-medium border border-border hover:border-muted-foreground hover:text-foreground text-muted-foreground transition-colors rounded-full">
                Login
              </button>
            </SignInButton>
            <SignUpButton>
              <button className="px-4 py-2 text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 transition-opacity rounded-full">
                Sign Up
              </button>
            </SignUpButton>
          </SignedOut>
          <SignedIn>
            <UserButton afterSignOutUrl="/" />
          </SignedIn>
        </div>
      </div>
    </nav>
  )
}
