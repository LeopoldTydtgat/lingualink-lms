/**
 * not-found.tsx — branded 404 (LinguaLink Online)
 *
 * Shown for unmatched routes and when you call notFound(). Server Component —
 * no "use client" needed. Place at src/app/not-found.tsx.
 */

import Link from "next/link";

export default function NotFound() {
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
        Page not found
      </h2>
      <p style={{ color: "#4b5563", maxWidth: "28rem", marginBottom: "1.5rem" }}>
        The page you're looking for doesn't exist or may have moved.
      </p>
      <Link
        href="/"
        prefetch={false}
        style={{
          backgroundColor: "#FF8303",
          color: "#ffffff",
          borderRadius: "0.5rem",
          padding: "0.625rem 1.25rem",
          fontSize: "0.9375rem",
          fontWeight: 600,
          textDecoration: "none",
        }}
      >
        Back to home
      </Link>
    </div>
  );
}
