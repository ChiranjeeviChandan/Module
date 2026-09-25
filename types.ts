export type Exam = "JEE Main" | "JEE Advanced" | "NEET";
export type Subject = "Physics" | "Chemistry" | "Mathematics" | "Biology" | "Botany" | "Zoology";

export interface ModuleContext {
  exam: string;
  learner: string; // Class 11 / Class 12 / Dropper / Foundation (Class 9-10) ...
  subject: string;
}

export type Severity = "critical" | "major" | "minor";

export type ErrorCategory =
  | "conceptual"
  | "factual"
  | "calculation"
  | "answer-key"
  | "solution"
  | "question-framing"
  | "options"
  | "units-notation"
  | "diagram-reference"
  | "syllabus"
  | "language"
  | "typography"
  | "formatting"
  | "consistency";

export type AgentId = "concept" | "solver" | "language" | "syllabus";

export interface ReviewError {
  id: string;
  page: number; // 1-indexed
  chapter: string;
  topic: string;
  question: string; // e.g. "Q12" or "" when not inside a question
  category: ErrorCategory;
  severity: Severity;
  original: string; // exact text as printed on the page
  corrected: string; // replacement text
  explanation: string;
  confidence: number; // 0..1
  agent: AgentId;
  status: "pending" | "validated" | "rejected";
  verifierNote?: string;
  accepted: boolean; // user toggle before implementing
  // filled by implement
  applied?: "patched" | "corrigendum" | "failed";
  applyNote?: string;
  secondReview?: "confirmed" | "issue";
  secondReviewNote?: string;
}

export interface PageStructure {
  page: number;
  chapter: string;
  topic: string;
  questions: string[];
}

export interface ModuleStructure {
  title: string;
  chapters: { name: string; startPage: number; endPage: number; topics: { name: string; startPage: number; endPage: number }[] }[];
  pages: PageStructure[];
}

export type JobPhase =
  | "uploaded"
  | "analysing"
  | "analysed"
  | "implementing"
  | "implemented"
  | "failed";

export interface ProgressEvent {
  at: number;
  stage: string;
  message: string;
  pct?: number;
}

export interface FinalValidation {
  totalAccepted: number;
  patched: number;
  corrigendum: number;
  failed: number;
  confirmed: number;
  issues: number;
  newIssues: { page: number; description: string }[];
  verdict: "pass" | "pass-with-notes" | "fail";
  summary: string;
}

export interface Job {
  id: string;
  ownerId: string;
  ownerEmail: string;
  lastAnalysedAt?: number;
  fileName: string;
  pageCount: number;
  context: ModuleContext;
  phase: JobPhase;
  events: ProgressEvent[];
  structure?: ModuleStructure;
  errors: ReviewError[];
  validation?: FinalValidation;
  errorMessage?: string;
  usage: { input: number; output: number };
  /** Pages where at least one review agent or the verifier failed — not fully reviewed. */
  incompletePages?: number[];
  /** Stored files: name → "local" or a private blob URL. */
  files?: Record<string, string>;
  /** Resumable work plan; each /step call advances it by one unit. */
  run?: AnalyseRun | ImplementRun;
  createdAt: number;
}

export interface Candidate extends Omit<ReviewError, "id" | "chapter" | "topic" | "status" | "accepted"> {
  cid: string;
}

export interface AnalyseRun {
  kind: "analyse";
  stage: "structure" | "review" | "verify" | "finalize";
  chunks: { start: number; end: number }[];
  chunk: number;
  candidates: Candidate[]; // current chunk, between review and verify
  attempts: number; // tries of the current unit (a killed function never records success)
  seq: number;
  calls: number;
  failures: string[];
}

export interface ImplementRun {
  kind: "implement";
  stage: "patch" | "review2" | "assemble";
  groups: number[][];
  group: number;
  attempts: number;
  newIssues: { page: number; description: string }[];
  reviewFailures: number;
}

export type Role = "admin" | "user";

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: "active" | "disabled";
  passwordHash: string;
  /** Bumped on password reset / disable, which invalidates existing sessions. */
  sessionVersion: number;
  /** Pages this user may analyse per calendar month; 0 = unlimited. */
  monthlyPageQuota: number;
  mustChangePassword?: boolean;
  createdAt: number;
  lastLoginAt?: number;
}

export type PublicUser = Omit<User, "passwordHash" | "sessionVersion">;

/** Small per-job record kept alongside the job for dashboards and history lists. */
export interface JobSummary {
  id: string;
  ownerId: string;
  ownerEmail: string;
  fileName: string;
  pageCount: number;
  context: ModuleContext;
  phase: JobPhase;
  errors: { total: number; critical: number; major: number; minor: number; rejected: number };
  categories: Record<string, number>;
  verdict?: FinalValidation["verdict"];
  usage: { input: number; output: number };
  createdAt: number;
  updatedAt: number;
  lastAnalysedAt?: number;
}
