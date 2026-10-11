/**
 * Utility for storing files temporarily in IndexedDB
 * This avoids sessionStorage quota limits for large PDFs
 */

const DB_NAME = "PdfLessonDB";
const STORE_NAME = "pendingFiles";
const DB_VERSION = 1;

interface StoredFile {
  id: string;
  file: File;
  timestamp: number;
}

/**
 * Opens or creates the IndexedDB database
 */
function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      
      // Create object store if it doesn't exist
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
  });
}

/**
 * Store a file in IndexedDB
 */
export async function storePendingFile(file: File): Promise<void> {
  const db = await openDB();
  
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    
    const fileData: StoredFile = {
      id: "pendingPdfUpload",
      file: file,
      timestamp: Date.now(),
    };
    
    const request = store.put(fileData);
    
    request.onsuccess = () => {
      db.close();
      resolve();
    };
    
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
}

/**
 * Retrieve and remove a pending file from IndexedDB
 */
export async function getPendingFile(): Promise<File | null> {
  const db = await openDB();
  
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    
    const getRequest = store.get("pendingPdfUpload");
    
    getRequest.onsuccess = () => {
      const result = getRequest.result as StoredFile | undefined;
      
      if (result) {
        // Delete the entry after retrieving
        const deleteRequest = store.delete("pendingPdfUpload");
        deleteRequest.onsuccess = () => {
          db.close();
          resolve(result.file);
        };
        deleteRequest.onerror = () => {
          db.close();
          reject(deleteRequest.error);
        };
      } else {
        db.close();
        resolve(null);
      }
    };
    
    getRequest.onerror = () => {
      db.close();
      reject(getRequest.error);
    };
  });
}

/**
 * Clear any pending files (useful for cleanup)
 */
export async function clearPendingFile(): Promise<void> {
  try {
    const db = await openDB();
    
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME], "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      
      const request = store.delete("pendingPdfUpload");
      
      request.onsuccess = () => {
        db.close();
        resolve();
      };
      
      request.onerror = () => {
        db.close();
        reject(request.error);
      };
    });
  } catch (error) {
    // If database doesn't exist, no need to clear
    console.error("Error clearing pending file:", error);
  }
}

