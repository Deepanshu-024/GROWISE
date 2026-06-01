"use client"

import { useState, useEffect, useRef } from "react"
import { SignInButton, SignUpButton, SignedIn, SignedOut, UserButton } from '@clerk/nextjs'
import { usePathname } from 'next/navigation'
import Link from "next/link"
import { getReportedRepos, type ReportedRepo } from "../../actions/get-reported-repos"

const navLinks = [
  { label: "Home", href: "/" },
  { label: "Dashboard", href: "/dashboard" },
  { label: "Pricing", href: "/pricing" },
  { label: "Contact", href: "/contact" },
]

export default function Navigation() {
  const pathname = usePathname()
  const [reportedRepos, setReportedRepos] = useState<ReportedRepo[]>([])
  const [isHovering, setIsHovering] = useState(false)
  const [loaded, setLoaded] = useState(false)
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
      <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center">
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

        {/* Auth Buttons — same fixed width as logo */}
        <div className="flex items-center justify-end gap-3 flex-1 md:flex-none md:w-48">
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
