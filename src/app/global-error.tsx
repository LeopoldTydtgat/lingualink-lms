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

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
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
          onClick={reset}
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
