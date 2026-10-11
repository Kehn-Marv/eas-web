/**
 * Course-generation job state, stored in Upstash Redis.
 *
 * The producer route writes the initial `queued` state and publishes to the
 * Vercel Queues topic. The consumer route transitions through `processing`
 * and lands on `complete` or `error`. The client polls the status endpoint
 * to follow along.
 *
 * The generated course itself lives in Postgres (saved by the worker) — we
 * only store the resulting slug here so the job payload stays well under
 * Upstash's 1 MB request size limit, and so the status endpoint response
 * stays tiny enough to poll cheaply.
 *
 * Keys expire after 1 hour so dead state doesn't accumulate.
 */

import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

const JOB_KEY_PREFIX = "course-job:";
const JOB_TTL_SECONDS = 60 * 60;

export type JobStatus = "queued" | "processing" | "complete" | "error";

export interface JobState {
  status: JobStatus;
  url: string;
  apiKey?: string;
  clientId: string;
  userId?: string;
  progress?: string;
  progressType?: string;
  slug?: string;
  error?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}

function jobKey(jobId: string) {
  return `${JOB_KEY_PREFIX}${jobId}`;
}

export async function createJob(
  jobId: string,
  init: Pick<JobState, "url" | "apiKey" | "clientId" | "userId">
): Promise<void> {
  const state: JobState = {
    status: "queued",
    createdAt: Date.now(),
    ...init,
  };
  await redis.set(jobKey(jobId), state, { ex: JOB_TTL_SECONDS });
}

export async function getJob(jobId: string): Promise<JobState | null> {
  const state = await redis.get<JobState>(jobKey(jobId));
  return state ?? null;
}

export async function updateJob(
  jobId: string,
  patch: Partial<JobState>
): Promise<JobState | null> {
  const current = await getJob(jobId);
  if (!current) return null;
  const next: JobState = { ...current, ...patch };
  await redis.set(jobKey(jobId), next, { ex: JOB_TTL_SECONDS });
  return next;
}
