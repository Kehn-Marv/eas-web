import { writeFile, unlink } from "fs/promises";
import { existsSync, readFileSync } from "fs";
import { ocr } from "./ocr";
import { createCourse } from "./create-course";
import type { CourseOutput } from "./create-course";

/**
 * Calculate statistics about lesson generation results
 */
function calculateLessonStats(course: CourseOutput) {
  let total = 0;
  let successful = 0;
  let fixed = 0;
  let failed = 0;
  let fixAttempts = 0;

  for (const module of course.modules) {
    for (const lessonResult of module.lessons) {
      total++;

      if (lessonResult.success) {
        successful++;
        if (lessonResult.data.fixHistory && lessonResult.data.fixHistory.length > 0) {
          fixed++;
          fixAttempts += lessonResult.data.fixHistory.length;
        }
      } else {
        failed++;
        if (lessonResult.error?.fixHistory) {
          fixAttempts += lessonResult.error.fixHistory.length;
        }
      }
    }
  }

  return { total, successful, fixed, failed, fixAttempts };
}

export interface ProgressCallback {
  (type: string, message: string, data?: any): void;
}

export interface GenerateCourseOptions {
  file?: File;
  url?: string;
  apiKey?: string;
  onProgress?: ProgressCallback;
}

export interface GenerateCourseResult {
  course: any;
  metadata: {
    generationTime: string;
    ocrTime: string;
    courseTime: string;
    modulesCount: number;
    lessonsCount: number;
    lessonStats: {
      total: number;
      successful: number;
      fixed: number;
      failed: number;
      fixAttempts: number;
    };
    pages: number;
    tokens: number;
  };
}

/**
 * Generate a course from a PDF file or URL
 */
export async function generateCourseFromPdf(
  options: GenerateCourseOptions
): Promise<GenerateCourseResult> {
  const { file, url, onProgress } = options;
  let tempFilePath: string | null = null;
  let isTemp = false;

  try {
    const apiKey = options.apiKey || process.env.TOGETHER_API_KEY || "";

    if (!apiKey) {
      throw new Error("Together AI API key is required. Please add your API key in the app settings.");
    }

    if (!file && !url) {
      throw new Error("Either 'file' or 'url' must be provided");
    }

    onProgress?.("init", "Initializing...");

    // Handle URL download
    if (url) {
      onProgress?.("download", "Downloading PDF from URL...");
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to download PDF: ${response.status} ${response.statusText}`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      tempFilePath = `/tmp/download-${Date.now()}.pdf`;
      await writeFile(tempFilePath, buffer);
      isTemp = true;
    }
    // Handle file upload
    else if (file) {
      onProgress?.("upload", `Processing uploaded file: ${file.name}`);
      const bytes = await file.arrayBuffer();
      const buffer = Buffer.from(bytes);
      tempFilePath = `/tmp/upload-${Date.now()}.pdf`;
      await writeFile(tempFilePath, buffer);
      isTemp = true;
    }

    if (!tempFilePath) {
      throw new Error("Failed to process file");
    }

    // Extract text from PDF
    const ocrStartTime = Date.now();

    const result = await ocr(tempFilePath, { onProgress });

    const content = result.pages.map((p) => p.content).join("\n\n");
    const ocrElapsed = ((Date.now() - ocrStartTime) / 1000).toFixed(2);

    onProgress?.("ocr-complete", `Text extraction completed in ${ocrElapsed}s`, {
      pages: result.pages.length,
      tokens: 0,
    });

    // Generate course
    const courseStartTime = Date.now();

    const course = await createCourse({
      content,
      apiKey,
      validateStructure: true,
      validateContent: true,
      retryFailures: true,
      maxRetries: 3,
      onProgress,
    });

    const courseElapsed = ((Date.now() - courseStartTime) / 1000).toFixed(2);

    const lessonStats = calculateLessonStats(course);

    onProgress?.(
      "course-complete",
      `Generated ${course.modules.length} modules with ${lessonStats.total} lessons`,
      {
        modules: course.modules.length,
        totalLessons: lessonStats.total,
        successfulLessons: lessonStats.successful,
        failedLessons: lessonStats.failed,
        fixedLessons: lessonStats.fixed,
        fixAttempts: lessonStats.fixAttempts,
      }
    );

    // Cleanup temp file
    if (isTemp && tempFilePath && existsSync(tempFilePath)) {
      await unlink(tempFilePath);
    }

    const totalElapsed = (
      (Date.now() - ocrStartTime + Date.now() - courseStartTime) / 1000
    ).toFixed(2);

    return {
      course,
      metadata: {
        generationTime: `${totalElapsed}s`,
        ocrTime: `${ocrElapsed}s`,
        courseTime: `${courseElapsed}s`,
        modulesCount: course.modules.length,
        lessonsCount: lessonStats.total,
        lessonStats,
        pages: result.pages.length,
        tokens: 0,
      },
    };
  } catch (error) {
    if (isTemp && tempFilePath && existsSync(tempFilePath)) {
      try {
        await unlink(tempFilePath);
      } catch (cleanupError) {
        console.error("Failed to cleanup temp file:", cleanupError);
      }
    }
    throw error;
  }
}
