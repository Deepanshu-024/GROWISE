import { type Metadata } from 'next'
import {
  ClerkProvider
} from '@clerk/nextjs'
import { Geist, Geist_Mono } from 'next/font/google'
import './globals.css'
import { ThemeProvider } from "@/components/theme-provider"
import { Analytics } from "@vercel/analytics/next"

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
})

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
})

export const metadata: Metadata = {
  title: {
    default: 'Gro(W)ise — Business Scale Analyzer',
    template: '%s | Gro(W)ise',
  },
  description:
    'Understand the bottlenecks your business can face before they hit. Gro(W)ise analyzes your codebase for scalability risks, revenue threats, and architectural weaknesses.',
  keywords: [
    'business scalability',
    'bottleneck detection',
    'scale analyzer',
    'architecture review',
    'revenue risk analysis',
    'Gro(W)ise',
    'code analysis',
    'growth readiness',
    'performance bottlenecks',
  ],
  authors: [{ name: 'Gro(W)ise' }],
  creator: 'Gro(W)ise',
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'),
  openGraph: {
    type: 'website',
    locale: 'en_US',
    siteName: 'Gro(W)ise',
    title: 'Gro(W)ise — Business Scale Analyzer',
    description:
      'Understand the bottlenecks your business can face before they hit. Scalability analysis powered by intelligent agents.',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Gro(W)ise — Business Scale Analyzer',
    description:
      'Understand the bottlenecks your business can face before they hit. Scalability analysis powered by intelligent agents.',
  },
  robots: {
    index: true,
    follow: true,
  },
  icons: {
    icon: '/favicon.ico',
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <ClerkProvider>
      <html lang="en" suppressHydrationWarning>
        <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
          <ThemeProvider
            attribute="class"
            defaultTheme="dark"
            enableSystem
            disableTransitionOnChange
          >
            {children}
            <Analytics />
          </ThemeProvider>
        </body>
      </html>
    </ClerkProvider>
  )
}