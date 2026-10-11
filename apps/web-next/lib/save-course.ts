/**
 * Shared course-save helper. Used by server-owned routes and the queue
 * worker so a generated course lands in Postgres exactly once with a
 * unique slug.
 */

import { db } from "@/lib/db";
import { courses } from "@/lib/db/schema";
import { withCourseSharingMetadata } from "@/lib/course-visibility";
import { generateSlug, ensureUniqueSlug } from "@/lib/utils/slug";

interface SaveCourseInput {
  course: { title: string } & Record<string, unknown>;
  userId?: string | null;
  providedSlug?: string;
  isPublic?: boolean;
}

export interface SavedCourse {
  id: string;
  slug: string;
  title: string;
  createdAt: Date;
}

export async function saveCourse({
  course,
  userId,
  providedSlug,
  isPublic = false,
}: SaveCourseInput): Promise<SavedCourse> {
  let slug = providedSlug;
  if (!slug) {
    const baseSlug = generateSlug(course.title, Date.now().toString());
    const existing = await db.select({ slug: courses.slug }).from(courses);
    slug = ensureUniqueSlug(
      baseSlug,
      existing.map((c) => c.slug)
    );
  }

  const [newCourse] = await db
    .insert(courses)
    .values({
      slug,
      title: course.title,
      courseData: isPublic ? withCourseSharingMetadata(course, true) : course,
      createdBy: userId || null,
      isPublic,
    })
    .returning();

  return {
    id: newCourse.id,
    slug: newCourse.slug,
    title: newCourse.title,
    createdAt: newCourse.createdAt,
  };
}
