import * as mupdf from "mupdf";
import { readFileSync } from "fs";

export interface OcrProgressCallback {
  (type: string, message: string, data?: any): void;
}

interface OcrOptions {
  onProgress?: OcrProgressCallback;
}

interface OcrResult {
  pages: Array<{
    page: number;
    content: string;
    contentLength: number;
    success: boolean;
    error?: string;
  }>;
  inputTokens: number;
  outputTokens: number;
  completionTime: number;
  failedPages: number;
  successfulPages: number;
}

const MAX_PAGES = 100;

/**
 * Extract text from PDF using mupdf WASM.
 * Direct text extraction — no vision model, no image conversion, no API calls.
 */
export async function ocr(
  filePath: string,
  options: OcrOptions = {},
): Promise<OcrResult> {
  const { onProgress } = options;
  const startTime = Date.now();

  const fileBuffer = readFileSync(filePath);
  const doc = mupdf.Document.openDocument(fileBuffer, "application/pdf");
  const pageCount = doc.countPages();

  if (pageCount > MAX_PAGES) {
    throw new Error(
      `PDF has ${pageCount} pages, but we currently only support PDFs up to ${MAX_PAGES} pages. Please upload a shorter document.`,
    );
  }

  onProgress?.("ocr-start", `Extracting text from ${pageCount} pages...`, {
    totalPages: pageCount,
  });

  const pages: OcrResult["pages"] = [];
  let failedPages = 0;

  for (let i = 0; i < pageCount; i++) {
    try {
      const page = doc.loadPage(i);
      const text = page.toStructuredText("preserve-whitespace").asText();

      pages.push({
        page: i + 1,
        content: text,
        contentLength: text.length,
        success: true,
      });
    } catch (error: any) {
      failedPages++;
      pages.push({
        page: i + 1,
        content: `[Page ${i + 1} could not be processed: ${error.message}]`,
        contentLength: 0,
        success: false,
        error: error.message,
      });
    }

    onProgress?.(
      "ocr-progress",
      `Extracting text from PDF (${i + 1}/${pageCount} pages)`,
      { completed: i + 1, total: pageCount, currentPage: i + 1 },
    );
  }

  const completionTime = Date.now() - startTime;
  const successfulPages = pageCount - failedPages;

  if (failedPages === pageCount) {
    throw new Error(
      `Failed to extract text from any pages in PDF. All ${pageCount} pages failed.`,
    );
  }

  onProgress?.(
    "ocr-complete",
    `Extracted text from ${successfulPages}/${pageCount} pages`,
    { totalPages: pageCount, completed: successfulPages, failed: failedPages },
  );

  return {
    pages,
    inputTokens: 0,
    outputTokens: 0,
    completionTime,
    failedPages,
    successfulPages,
  };
}
