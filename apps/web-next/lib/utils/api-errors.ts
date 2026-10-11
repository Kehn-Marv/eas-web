import { NextResponse } from "next/server";

/**
 * Handle API route errors with consistent formatting.
 * Checks for DATABASE_URL misconfiguration and returns appropriate responses.
 */
export function handleApiError(error: unknown, fallbackMessage: string) {
  if (error instanceof Error && error.message.includes("DATABASE_URL")) {
    return NextResponse.json(
      { error: "Database not configured. Please set DATABASE_URL environment variable." },
      { status: 500 }
    );
  }

  return NextResponse.json(
    { error: fallbackMessage },
    { status: 500 }
  );
}
