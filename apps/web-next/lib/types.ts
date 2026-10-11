/**
 * Shared type definitions for course and lesson generation
 */

export interface Module {
  title: string;
}

export enum QuestionType {
  MultipleChoice = "multiple-choice",
  TrueFalse = "true-false",
  ShortAnswer = "short-answer",
  DragDrop = "drag-drop",
  FlowDiagram = "flow-diagram",
}

// Flow diagram types (matches FlowConfig from app/components/flow-diagram.tsx)
export type SimpleNode = {
  id: string;
  label: string;
  type: 'start' | 'process' | 'output';
};

export type SimpleEdge = [string, string];

export type FlowConfig = {
  nodes: SimpleNode[];
  edges: SimpleEdge[];
};

export interface FixAttempt {
  attempt: number;
  validationType: "structure" | "content";
  reason: string;
  details: string[];
  lesson?: any; // Snapshot of the lesson at this attempt (for debugging)
}

export interface LessonBase {
  title: string;
  content: string;
  info: string;
  question: string;
  questionType: QuestionType;
  fixHistory?: FixAttempt[]; // Present only if lesson was fixed after failing validation
}

export interface ShortAnswerLesson extends LessonBase {
  questionType: QuestionType.ShortAnswer;
  answer: string;
}

export interface TrueFalseLesson extends LessonBase {
  questionType: QuestionType.TrueFalse;
  answer: boolean;
  explanation?: string; // Optional explanation of why the statement is true or false
}

export interface MultipleChoiceLesson extends LessonBase {
  questionType: QuestionType.MultipleChoice;
  answer: number; // Index of the correct choice (0-based)
  choices: (string | number)[]; // Choices can be strings or numbers
  explanation?: string; // Optional explanation of why the correct answer is right
}

export interface DragDropLesson extends LessonBase {
  questionType: QuestionType.DragDrop;
  choices: string[]; // Exactly 3 choices
  slots: string[]; // Exactly 3 slot labels
  answer: number[]; // Array of 3 numbers (choice indices), where index = slot index, value = choice index
}

export interface FlowDiagramLesson extends LessonBase {
  questionType: QuestionType.FlowDiagram;
  flowConfig: FlowConfig; // The flow diagram structure
  answer: number[]; // Array of 3 slot indices for ordering
  choices: string[]; // Exactly 3 node labels from flow
  slots: string[]; // Exactly 3 slot labels (e.g., "First", "Second", "Third")
}

export type Lesson = ShortAnswerLesson | TrueFalseLesson | MultipleChoiceLesson | DragDropLesson | FlowDiagramLesson;

export interface LessonError {
  /**
   * "structure"  — JSON parse / Zod validation failure.
   * "content"    — LLM-judge content validation failure.
   * "duplicate"  — semantic duplicate of another lesson in this course;
   *                regeneration attempted but couldn't produce a distinct
   *                question. UI / consumers should filter these out.
   */
  validationType: "structure" | "content" | "duplicate";
  reason: string;
  details?: string[];
  attempts?: number; // Number of fix attempts made (if retry was enabled)
  fixHistory?: FixAttempt[]; // History of all fix attempts (if retry was enabled)
}

export interface SuccessfulLesson {
  success: true;
  data: Lesson;
  error?: never; // Explicitly no error for successful lessons
}

export interface FailedLesson {
  success: false;
  data: any; // Partial/invalid lesson data
  error: LessonError;
}

export type LessonResult = SuccessfulLesson | FailedLesson;

export interface ModuleWithLessons {
  title: string;
  lessons: LessonResult[];
}

export interface CourseStructure {
  course: {
    title: string;
    module: Module[];
  };
}

// --- Client-side types used by hooks and components ---

export type QuestionTypeString = "short-answer" | "true-false" | "multiple-choice" | "drag-drop" | "flow-diagram";

export interface GradingResult {
  isCorrect: boolean;
  gradedAt: string;
}

export interface LessonData {
  id?: string;
  content: string;
  info: string;
  question: string;
  answer: string | boolean | number | number[];
  title: string;
  questionType: QuestionTypeString;
  choices?: string[];
  slots?: string[];
  flowConfig?: FlowConfig;
  gradingResult?: GradingResult;
  explanation?: string;
}

export interface ClientLesson {
  success: boolean;
  data: LessonData;
  completed?: boolean;
  attempt_count?: number;
  last_correct?: boolean | null;
  last_answer?: string | boolean | number | number[] | null;
}

export interface ClientModule {
  title: string;
  lessons: ClientLesson[];
  id?: string;
}

export interface Course {
  title: string;
  modules: ClientModule[];
  course_id?: string;
}

export type Step =
  | "module-intro"
  | "content"
  | "question"
  | "answer"
  | "module-complete";
