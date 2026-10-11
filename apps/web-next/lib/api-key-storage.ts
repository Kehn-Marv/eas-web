/**
 * Utility functions for managing the Together AI API key in localStorage
 */

const API_KEY_STORAGE_KEY = "together_ai_api_key";

export function saveApiKey(apiKey: string): void {
  if (typeof window !== "undefined") {
    localStorage.setItem(API_KEY_STORAGE_KEY, apiKey);
  }
}

export function getApiKey(): string | null {
  if (typeof window !== "undefined") {
    return localStorage.getItem(API_KEY_STORAGE_KEY);
  }
  return null;
}

export function removeApiKey(): void {
  if (typeof window !== "undefined") {
    localStorage.removeItem(API_KEY_STORAGE_KEY);
  }
}


