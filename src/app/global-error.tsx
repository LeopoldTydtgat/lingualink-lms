"use client";

/**
 * global-error.tsx — root error boundary (LinguaLink Online)
 *
 * Catches errors thrown in the ROOT layout itself (which a normal error.tsx
 * cannot, because error.tsx renders inside the layout). This replaces the
 * entire document, so it must render its own <html> and <body>.
 *
 * Place at src/app/global-error.tsx. Rarely triggers, but when it does it is
 * the difference between a branded message and a blank browser error page.
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

export default function GlobalError({
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

    console.error("Global error:", error);
    // import("@sentry/nextjs").then((S) => S.captureException(error)).catch(() => {});
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          padding: "2rem",
          fontFamily: "Inter, sans-serif",
          backgroundColor: "#f9fafb",
        }}
      >
        <h2 style={{ fontSize: "1.25rem", fontWeight: 600, color: "#000000", marginBottom: "0.5rem" }}>
          Something went wrong
        </h2>
        <p style={{ color: "#4b5563", maxWidth: "28rem", marginBottom: "1.5rem" }}>
          The application hit an unexpected problem. Please try again.
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
      </body>
    </html>
  );
}
