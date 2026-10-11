/**
 * Generate a URL-friendly slug from a course title
 * Format: title-slugified + "-" + short-id-suffix
 * Example: "Introduction to ML" -> "introduction-to-ml-a3f2"
 */

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "") // Remove special characters
    .replace(/\s+/g, "-") // Replace spaces with hyphens
    .replace(/-+/g, "-") // Replace multiple hyphens with single hyphen
    .replace(/^-+|-+$/g, ""); // Remove leading/trailing hyphens
}

/**
 * Generate a hybrid slug: title-slug + short ID suffix
 * @param title - Course title
 * @param id - Course ID (timestamp string)
 * @returns Hybrid slug like "introduction-to-ml-a3f2"
 */
export function generateSlug(title: string, id: string): string {
  const titleSlug = slugify(title);
  // Use last 4-6 characters of ID as suffix
  const shortId = id.slice(-6);
  return `${titleSlug}-${shortId}`;
}

/**
 * Ensure slug uniqueness by checking against existing courses
 * If slug exists, append a counter
 */
export function ensureUniqueSlug(
  baseSlug: string,
  existingSlugs: string[]
): string {
  if (!existingSlugs.includes(baseSlug)) {
    return baseSlug;
  }

  let counter = 1;
  let uniqueSlug = `${baseSlug}-${counter}`;
  while (existingSlugs.includes(uniqueSlug)) {
    counter++;
    uniqueSlug = `${baseSlug}-${counter}`;
  }

  return uniqueSlug;
}

