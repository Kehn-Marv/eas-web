/**
 * The activity vocabulary shared by every surface that reports ongoing work.
 *
 * Chat's reasoning trace, a book compile, the sidebar's
 * running sessions — all of them share consistent status indicators.
 * One type, one set of colours, one animation.
 *
 * The type itself lives in `shared/ui/activity-state`, so the pure logic that
 * derives these states can name them without importing the UI layer.
 */

export type { ActivityState } from "@/shared/ui/activity-state";
