/**
 * Rate limiting utility using Upstash Redis
 *
 * Allows 3 free courses and 50 free grading calls per IP address (lifetime).
 * Users with their own Together AI API key bypass rate limiting entirely.
 */

import { Redis } from '@upstash/redis';

// Initialize Redis from environment variables
const redis = Redis.fromEnv();

/**
 * Get client identifier from request
 * Uses IP address, falling back to a header if available
 */
export function getClientIdentifier(request: Request): string {
  // Try to get IP from headers (Vercel, Cloudflare, etc.)
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    return forwardedFor.split(",")[0].trim();
  }

  const realIp = request.headers.get("x-real-ip");
  if (realIp) {
    return realIp;
  }

  // Fallback: use a default identifier (not ideal, but works)
  return "unknown";
}

// Constants
const FREE_COURSE_LIMIT = 3;
const FREE_GRADING_LIMIT = 50;
const RATE_LIMIT_KEY_PREFIX = 'rate-limit:';
const GRADING_KEY_PREFIX = 'grading-limit:';

interface RateLimitResult {
  allowed: boolean;
  coursesCreated: number;
  limit: number;
}

interface GradingLimitResult {
  allowed: boolean;
  gradingsUsed: number;
  limit: number;
}

interface RateLimitStatus {
  coursesCreated: number;
  courseLimit: number;
  gradingsUsed: number;
  gradingLimit: number;
  hasReachedCourseLimit: boolean;
  hasReachedGradingLimit: boolean;
}

/**
 * Check if a client is allowed to generate a course
 */
export async function checkRateLimit(
  clientId: string,
  hasApiKey: boolean
): Promise<RateLimitResult> {
  if (hasApiKey) {
    return { allowed: true, coursesCreated: 0, limit: Infinity };
  }

  const key = `${RATE_LIMIT_KEY_PREFIX}${clientId}`;

  try {
    const count = await redis.get<number>(key);
    const coursesCreated = count || 0;

    return {
      allowed: coursesCreated < FREE_COURSE_LIMIT,
      coursesCreated,
      limit: FREE_COURSE_LIMIT,
    };
  } catch (error) {
    console.error('Error checking rate limit:', error);
    return { allowed: true, coursesCreated: 0, limit: FREE_COURSE_LIMIT };
  }
}

/**
 * Increment the course count for a client (call after successful generation)
 */
export async function incrementRateLimit(clientId: string): Promise<number> {
  const key = `${RATE_LIMIT_KEY_PREFIX}${clientId}`;

  try {
    const newCount = await redis.incr(key);
    await redis.expire(key, 60 * 60 * 24 * 365);
    return newCount;
  } catch (error) {
    console.error('Error incrementing rate limit:', error);
    return 0;
  }
}

/**
 * Check if a client is allowed to grade an answer
 */
export async function checkGradingLimit(
  clientId: string,
  hasApiKey: boolean
): Promise<GradingLimitResult> {
  if (hasApiKey) {
    return { allowed: true, gradingsUsed: 0, limit: Infinity };
  }

  const key = `${GRADING_KEY_PREFIX}${clientId}`;

  try {
    const count = await redis.get<number>(key);
    const gradingsUsed = count || 0;

    return {
      allowed: gradingsUsed < FREE_GRADING_LIMIT,
      gradingsUsed,
      limit: FREE_GRADING_LIMIT,
    };
  } catch (error) {
    console.error('Error checking grading limit:', error);
    return { allowed: true, gradingsUsed: 0, limit: FREE_GRADING_LIMIT };
  }
}

/**
 * Increment the grading count for a client (call after successful grading)
 */
export async function incrementGradingLimit(clientId: string): Promise<number> {
  const key = `${GRADING_KEY_PREFIX}${clientId}`;

  try {
    const newCount = await redis.incr(key);
    await redis.expire(key, 60 * 60 * 24 * 365);
    return newCount;
  } catch (error) {
    console.error('Error incrementing grading limit:', error);
    return 0;
  }
}

/**
 * Get current rate limit status for a client (courses + grading)
 */
export async function getRateLimitStatus(
  clientId: string
): Promise<RateLimitStatus> {
  const courseKey = `${RATE_LIMIT_KEY_PREFIX}${clientId}`;
  const gradingKey = `${GRADING_KEY_PREFIX}${clientId}`;

  try {
    const [courseCount, gradingCount] = await Promise.all([
      redis.get<number>(courseKey),
      redis.get<number>(gradingKey),
    ]);
    const coursesCreated = courseCount || 0;
    const gradingsUsed = gradingCount || 0;

    return {
      coursesCreated,
      courseLimit: FREE_COURSE_LIMIT,
      gradingsUsed,
      gradingLimit: FREE_GRADING_LIMIT,
      hasReachedCourseLimit: coursesCreated >= FREE_COURSE_LIMIT,
      hasReachedGradingLimit: gradingsUsed >= FREE_GRADING_LIMIT,
    };
  } catch (error) {
    console.error('Error getting rate limit status:', error);
    return {
      coursesCreated: 0,
      courseLimit: FREE_COURSE_LIMIT,
      gradingsUsed: 0,
      gradingLimit: FREE_GRADING_LIMIT,
      hasReachedCourseLimit: false,
      hasReachedGradingLimit: false,
    };
  }
}
