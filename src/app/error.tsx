"use client";

/**
 * error.tsx — route-segment error boundary (LinguaLink Online)
 *
 * Catches runtime errors thrown while rendering a route segment and shows a
 * branded fallback instead of a white screen. Place at src/app/error.tsx for a
 * global catch, and/or inside any route group that should fail gracefully on
 * its own (e.g. the booking flow) so one broken page doesn't take down the nav.
 *
 * Next.js App Router automatically renders this when a child throws.
 * `reset()` re-attempts rendering the segment.
 *
 * NOTE: this must be a Client Component ("use client") — Next.js requires it.
 * Do NOT show the raw error message to users (it can leak internals); log it.
 */

import { useEffect } from "react";

const CHUNK_RELOAD_KEY = "ll_chunk_reload";

function isChunkLoadError(err: unknown): boolean {
  if (!err) return false;
  const e = err as { name?: string; message?: string };
  const name = e.name ?? "";
  const msg = e.message ?? "";
  return (
    name === "ChunkLoadError" ||
    /Loading chunk [\d]+ failed/i.test(msg) ||
    /Loading CSS chunk/i.test(msg) ||
    /error loading dynamically imported module/i.test(msg) ||
    /failed to fetch dynamically imported module/i.test(msg) ||
    /importing a module script failed/i.test(msg)
  );
}

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    if (isChunkLoadError(error)) {
      let alreadyReloaded = false;
      try { alreadyReloaded = sessionStorage.getItem(CHUNK_RELOAD_KEY) === "1"; } catch {}
      if (!alreadyReloaded) {
        try { sessionStorage.setItem(CHUNK_RELOAD_KEY, "1"); } catch {}
        window.location.reload();
        return;
      }
    } else {
      // Not a chunk error - clear any stale reload flag so a future chunk error
      // gets its one reload attempt.
      try { sessionStorage.removeItem(CHUNK_RELOAD_KEY); } catch {}
    }

    // Log for debugging. `digest` is Next.js's server-error correlation id.
    console.error("Route error:", error);

    // If/when Sentry is wired up, report here. Guarded so a missing/renamed
    // Sentry import can never itself crash the error page:
    // import("@sentry/nextjs").then((Sentry) => Sentry.captureException(error)).catch(() => {});
  }, [error]);

  return (
    <div
      style={{
        minHeight: "60vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        padding: "2rem",
        fontFamily: "Inter, sans-serif",
      }}
    >
      <h2 style={{ fontSize: "1.25rem", fontWeight: 600, color: "#000000", marginBottom: "0.5rem" }}>
        Something went wrong
      </h2>
      <p style={{ color: "#4b5563", maxWidth: "28rem", marginBottom: "1.5rem" }}>
        We hit an unexpected problem loading this page. You can try again — if it
        keeps happening, please contact us.
      </p>
      <button
        onClick={() => window.location.reload()}
        style={{
          backgroundColor: "#FF8303",
          color: "#ffffff",
          border: "none",
          borderRadius: "0.5rem",
          padding: "0.625rem 1.25rem",
          fontSize: "0.9375rem",
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        Try again
      </button>
    </div>
  );
}
