import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

const isProtectedRoute = createRouteMatcher([
  "/dashboard(.*)",
  "/api/github/status(.*)",
  "/api/github/disconnect(.*)",
  "/api/github/repositories(.*)",
  "/api/github/install(.*)",
]);

export default clerkMiddleware(async (auth, req) => {
  // Skip authentication for webhook routes
  if (isProtectedRoute(req)) {
    await auth.protect();
}

  if (req.nextUrl.pathname.startsWith('/api/webhook')) {
    return;
  }
});

export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    // Always run for API routes (webhooks are excluded in the middleware callback)
    '/(api|trpc)(.*)',
  ],
};