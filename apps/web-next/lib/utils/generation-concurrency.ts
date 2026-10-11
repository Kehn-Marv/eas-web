/**
 * Cross-instance concurrency cap for course generation.
 *
 * Vercel Queues (v2beta) doesn't yet expose a max-concurrency knob on push
 * triggers. We enforce it ourselves with an Upstash counter in the consumer:
 *
 * - `tryClaimSlot()` increments the counter and returns false if over cap,
 *   immediately decrementing back. The consumer throws on false so Vercel
 *   Queues redelivers the message after `retryAfterSeconds`.
 * - `releaseSlot()` decrements on success or normal failure.
 *
 * The counter has a safety TTL that refreshes on every `INCR`, so a
 * worker crashed mid-flight (Vercel kills the process) eventually decays
 * its leaked count instead of starving the cap forever.
 */

import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

const ACTIVE_KEY = "course-gen-active-count";
const SAFETY_TTL_SECONDS = 30 * 60;

const parsedMax = Number(process.env.GENERATION_MAX_CONCURRENT ?? 2);
const MAX_CONCURRENT =
  Number.isFinite(parsedMax) && parsedMax > 0 ? Math.floor(parsedMax) : 2;

export async function tryClaimSlot(): Promise<boolean> {
  const count = await redis.incr(ACTIVE_KEY);
  // Refresh TTL so a leaked count from a crashed worker eventually decays.
  await redis.expire(ACTIVE_KEY, SAFETY_TTL_SECONDS);

  if (count > MAX_CONCURRENT) {
    await redis.decr(ACTIVE_KEY);
    return false;
  }
  return true;
}

export async function releaseSlot(): Promise<void> {
  await redis.decr(ACTIVE_KEY);
}
