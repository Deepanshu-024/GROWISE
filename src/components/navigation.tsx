"use client"

export default function Navigation() {
  return (
    <nav className="fixed top-0 w-full z-50 bg-background/80 backdrop-blur-md border-b border-border/50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
        {/* Logo */}
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-primary text-primary-foreground rounded-md flex items-center justify-center font-bold text-lg">
            C
          </div>
          <span className="font-semibold text-lg hidden sm:inline">CreateWise</span>
        </div>

        {/* Center Navigation */}
        <div className="hidden md:flex items-center gap-8">
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
        </div>

        {/* Auth Buttons */}
        <div className="flex items-center gap-3">
          <button className="px-4 py-2 text-sm font-medium border border-border hover:border-muted-foreground hover:text-foreground text-muted-foreground transition-colors rounded-full">
            Login
          </button>
          <button className="px-4 py-2 text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 transition-opacity rounded-full">
            Sign Up
          </button>
        </div>
      </div>
    </nav>
  )
}
