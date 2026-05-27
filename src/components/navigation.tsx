"use client"

import { SignInButton, SignUpButton, SignedIn, SignedOut, UserButton } from '@clerk/nextjs'

export default function Navigation() {
  return (
    <nav className="fixed top-0 w-full z-50 bg-background/80 backdrop-blur-md border-b border-border/50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center">
        {/* Logo — fixed width so center stays centered */}
        <div className="flex items-center gap-2 w-48">
          <div className="w-8 h-8 bg-primary text-primary-foreground rounded-md flex items-center justify-center font-bold text-lg">
            G
          </div>
          <span className="font-semibold text-lg hidden sm:inline">Gro(W)ise</span>
        </div>

        {/* Center Navigation — true center */}
        <div className="flex-1 hidden md:flex items-center justify-center gap-8">
          <a href="#" className="text-muted-foreground hover:text-foreground transition-colors text-sm">
            Home
          </a>
          <a href="#" className="text-muted-foreground hover:text-foreground transition-colors text-sm">
            Community
          </a>
          <a href="#" className="text-muted-foreground hover:text-foreground transition-colors text-sm">
            Pricing
          </a>
          <a href="#" className="text-muted-foreground hover:text-foreground transition-colors text-sm">
            Contact
          </a>
          <SignedIn>
            <a href="/dashboard" className="text-muted-foreground hover:text-foreground transition-colors text-sm">
              Dashboard
            </a>
          </SignedIn>
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
