const SHARING_METADATA_KEY = "_sharing";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isExplicitlyPublicCourse(
  courseData: unknown,
  isPublic: boolean
): boolean {
  if (!isPublic || !isRecord(courseData)) return false;

  const sharing = courseData[SHARING_METADATA_KEY];
  return isRecord(sharing) && sharing.isPublic === true;
}

export function withCourseSharingMetadata<T extends Record<string, unknown>>(
  courseData: T,
  isPublic: boolean
): T {
  const existingSharing = courseData[SHARING_METADATA_KEY];

  return {
    ...courseData,
    [SHARING_METADATA_KEY]: {
      ...(isRecord(existingSharing) ? existingSharing : {}),
      isPublic,
    },
  };
}
