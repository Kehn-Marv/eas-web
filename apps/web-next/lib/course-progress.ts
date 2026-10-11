/**
 * Local storage for course progress (per browser)
 * Courses are shared via DB, but progress is personal and stored locally
 */

export interface CourseProgress {
  slug: string;
  completedModules: number[];
  lastAccessedAt: string;
}

/**
 * Derive current module index from completedModules.
 * Returns the first incomplete module, or the last module if all are done.
 */
export function deriveCurrentModuleIndex(completedModules: number[], totalModules: number): number {
  if (totalModules === 0) return 0;
  for (let i = 0; i < totalModules; i++) {
    if (!completedModules.includes(i)) return i;
  }
  return totalModules - 1;
}

const STORAGE_KEY = 'course-progress';

/**
 * Get all course progress from localStorage
 */
export function getAllProgress(): Record<string, CourseProgress> {
  if (typeof window === 'undefined') return {};
  
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return {};
    return JSON.parse(stored);
  } catch (error) {
    console.error('Failed to load progress from localStorage:', error);
    return {};
  }
}

/**
 * Get progress for a specific course
 */
export function getCourseProgress(slug: string): CourseProgress | null {
  const allProgress = getAllProgress();
  return allProgress[slug] || null;
}

/**
 * Save progress for a specific course
 */
export function saveCourseProgress(progress: CourseProgress): void {
  if (typeof window === 'undefined') return;
  
  try {
    const allProgress = getAllProgress();
    allProgress[progress.slug] = {
      ...progress,
      lastAccessedAt: new Date().toISOString(),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(allProgress));
  } catch (error) {
    console.error('Failed to save progress to localStorage:', error);
  }
}

/**
 * Update completedModules for a course
 */
export function updateCourseProgress(
  slug: string,
  completedModules: number[]
): void {
  const progress: CourseProgress = {
    slug,
    completedModules,
    lastAccessedAt: new Date().toISOString(),
  };
  saveCourseProgress(progress);
}

/**
 * Clear progress for a specific course
 */
export function clearCourseProgress(slug: string): void {
  if (typeof window === 'undefined') return;
  
  try {
    const allProgress = getAllProgress();
    delete allProgress[slug];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(allProgress));
  } catch (error) {
    console.error('Failed to clear progress from localStorage:', error);
  }
}

