"use client"

import { useState, useEffect, useRef } from "react"
import { SignInButton, SignUpButton, SignedIn, SignedOut, UserButton, useUser } from '@clerk/nextjs'
import { usePathname } from 'next/navigation'
import Link from "next/link"
import { Menu, X } from "lucide-react"
import { getReportedRepos, type ReportedRepo } from "../../actions/get-reported-repos"

const navLinks = [
  { label: "Home", href: "/" },
  { label: "Dashboard", href: "/dashboard" },
  { label: "Pricing", href: "/pricing" },
  { label: "Contact", href: "/contact" },
]

export default function Navigation() {
  const pathname = usePathname()
  const { user } = useUser()
  const [reportedRepos, setReportedRepos] = useState<ReportedRepo[]>([])
  const [isHovering, setIsHovering] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [isOpen, setIsOpen] = useState(false)
  const [mobileReportsOpen, setMobileReportsOpen] = useState(false)
  const timeoutRef = useRef<NodeJS.Timeout | null>(null)

  const handleMouseEnter = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    setIsHovering(true)
    if (!loaded) {
      getReportedRepos().then((repos) => {
        setReportedRepos(repos)
        setLoaded(true)
      })
    }
  }

  const handleMouseLeave = () => {
    timeoutRef.current = setTimeout(() => {
      setIsHovering(false)
    }, 120)
  }

  // Re-fetch on route change so new reports appear
  useEffect(() => {
    if (loaded) {
      getReportedRepos().then((repos) => setReportedRepos(repos))
    }
  }, [pathname])

  const isReportsActive = pathname.startsWith("/project")

  const renderNavLink = (label: string, href: string) => {
    const isActive = href === "/" ? pathname === "/" : pathname.startsWith(href) && href !== "#"
    return (
      <a
        key={label}
        href={href}
        className={`transition-colors text-sm ${isActive ? "text-foreground font-medium" : "text-muted-foreground hover:text-foreground"}`}
      >
        {label}
      </a>
    )
  }

  return (
    <nav className="fixed top-0 w-full z-50 bg-background/80 backdrop-blur-md border-b border-border/50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
        {/* Logo — fixed width so center stays centered */}
        <div className="flex items-center gap-2.5 flex-1 md:flex-none md:w-48">
          <span className="font-semibold text-base sm:text-lg bg-gradient-to-r from-emerald-400 to-white bg-clip-text text-transparent">Gro(W)ise</span>
        </div>

        {/* Center Navigation — true center */}
        <div className="flex-1 hidden md:flex items-center justify-center gap-8">
          {/* Home */}
          {renderNavLink("Home", "/")}

          {/* Reports — right after Home, only for signed-in users */}
          <SignedIn>
            <div
              className="relative"
              onMouseEnter={handleMouseEnter}
              onMouseLeave={handleMouseLeave}
            >
              <button
                className={`transition-colors text-sm ${isReportsActive
                  ? "text-foreground font-medium"
                  : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Reports
              </button>

              {/* Dropdown */}
              <div
                className={`
                  absolute top-full left-0 pt-2 min-w-[200px]
                  transition-all duration-200 origin-top
                  ${isHovering
                    ? "opacity-100 scale-100 pointer-events-auto translate-y-0"
                    : "opacity-0 scale-[0.97] pointer-events-none -translate-y-1"
                  }
                `}
              >
                <div className="bg-background/95 backdrop-blur-xl border border-border/50 rounded-lg shadow-[0_8px_30px_rgba(0,0,0,0.35)]">
                <div className="py-2 px-1">
                  {reportedRepos.length === 0 ? (
                    <p className="px-3 py-3 text-sm text-muted-foreground/60 text-center">
                      No reports yet
                    </p>
                  ) : (
                    reportedRepos.map((repo) => (
                      <Link
                        key={repo.id}
                        href={`/project/${repo.id}`}
                        className="block px-3 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors rounded-md hover:bg-white/[0.04]"
                        onClick={() => setIsHovering(false)}
                      >
                        <span className="border-b border-transparent hover:border-current transition-[border-color] duration-150">
                          {repo.name}
                        </span>
                      </Link>
                    ))
                  )}
                </div>
                </div>
              </div>
            </div>
          </SignedIn>

          {/* Remaining nav links */}
          {navLinks.slice(1).map(({ label, href }) => renderNavLink(label, href))}
        </div>

        {/* Desktop Auth Buttons — hidden on mobile */}
        <div className="hidden md:flex items-center justify-end gap-3 flex-1 md:flex-none md:w-48">
          <SignedOut>
            <SignInButton fallbackRedirectUrl="/">
              <button className="px-4 py-2 text-sm font-medium border border-border hover:border-muted-foreground hover:text-foreground text-muted-foreground transition-colors rounded-full">
                Login
              </button>
            </SignInButton>
            <SignUpButton fallbackRedirectUrl="/">
              <button className="px-4 py-2 text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 transition-opacity rounded-full">
                Sign Up
              </button>
            </SignUpButton>
          </SignedOut>
          <SignedIn>
            <UserButton afterSignOutUrl="/" />
          </SignedIn>
        </div>

        {/* Mobile Hamburger Button */}
        <div className="flex md:hidden items-center justify-end flex-1">
          <button
            onClick={() => setIsOpen(!isOpen)}
            className="p-2 text-muted-foreground hover:text-foreground focus:outline-none transition-colors"
            aria-label="Toggle menu"
          >
            {isOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
          </button>
        </div>
      </div>

      {/* Mobile Navigation Dropdown Drawer */}
      {isOpen && (
        <div className="absolute top-16 left-0 w-full bg-background/95 backdrop-blur-xl border-b border-border/50 shadow-xl z-40 md:hidden flex flex-col py-4 px-6 gap-4 animate-in fade-in slide-in-from-top-4 duration-200">
          {/* Links Group */}
          <div className="flex flex-col gap-3">
            {/* Home */}
            <Link
              href="/"
              className={`text-sm py-1.5 transition-colors ${pathname === "/" ? "text-foreground font-semibold" : "text-muted-foreground hover:text-foreground"}`}
              onClick={() => setIsOpen(false)}
            >
              Home
            </Link>

            {/* Reports Section — only for signed-in users */}
            <SignedIn>
              <div className="flex flex-col">
                <button
                  onClick={() => setMobileReportsOpen(!mobileReportsOpen)}
                  className={`flex items-center justify-between text-sm py-1.5 transition-colors ${pathname.startsWith("/project") ? "text-foreground font-semibold" : "text-muted-foreground hover:text-foreground"}`}
                >
                  <span>Reports</span>
                  <span className="text-muted-foreground/60 text-xs">
                    {mobileReportsOpen ? "▲" : "▼"}
                  </span>
                </button>
                {mobileReportsOpen && (
                  <div className="pl-4 flex flex-col gap-2 mt-1.5 border-l border-border/50">
                    {reportedRepos.length === 0 ? (
                      <span className="text-xs text-muted-foreground/60 py-1">No reports yet</span>
                    ) : (
                      reportedRepos.map((repo) => (
                        <Link
                          key={repo.id}
                          href={`/project/${repo.id}`}
                          className="text-xs text-muted-foreground hover:text-foreground py-1 transition-colors"
                          onClick={() => setIsOpen(false)}
                        >
                          {repo.name}
                        </Link>
                      ))
                    )}
                  </div>
                )}
              </div>
            </SignedIn>

            {/* Remaining nav links */}
            {navLinks.slice(1).map(({ label, href }) => {
              const isActive = href === "/" ? pathname === "/" : pathname.startsWith(href) && href !== "#"
              return (
                <Link
                  key={label}
                  href={href}
                  className={`text-sm py-1.5 transition-colors ${isActive ? "text-foreground font-semibold" : "text-muted-foreground hover:text-foreground"}`}
                  onClick={() => setIsOpen(false)}
                >
                  {label}
                </Link>
              )
            })}
          </div>

          {/* User Profile / Auth Actions — inside mobile menu */}
          <div className="border-t border-border/50 pt-4 flex flex-col gap-3">
            <SignedOut>
              <div className="flex flex-col gap-2">
                <SignInButton fallbackRedirectUrl="/">
                  <button 
                    onClick={() => setIsOpen(false)}
                    className="w-full px-4 py-2 text-center text-sm font-medium border border-border hover:border-muted-foreground hover:text-foreground text-muted-foreground transition-colors rounded-full"
                  >
                    Login
                  </button>
                </SignInButton>
                <SignUpButton fallbackRedirectUrl="/">
                  <button 
                    onClick={() => setIsOpen(false)}
                    className="w-full px-4 py-2 text-center text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 transition-opacity rounded-full"
                  >
                    Sign Up
                  </button>
                </SignUpButton>
              </div>
            </SignedOut>
            <SignedIn>
              <div className="flex items-center gap-3">
                <div onClick={() => setIsOpen(false)}>
                  <UserButton afterSignOutUrl="/" />
                </div>
                <div className="flex flex-col min-w-0">
                  <span className="text-sm font-medium text-foreground truncate">
                    {user?.fullName || user?.username || 'User'}
                  </span>
                  <span className="text-xs text-muted-foreground truncate">
                    {user?.primaryEmailAddress?.emailAddress}
                  </span>
                </div>
              </div>
            </SignedIn>
          </div>
        </div>
      )}
    </nav>
  )
}
