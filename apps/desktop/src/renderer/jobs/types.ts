import type { JobStage, Project } from '@cutaway/core';
import type { AppSettings } from '../../shared/api';

export interface StageState {
  id: JobStage;
  label: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  /** One honest line about what is happening or what happened. */
  detail: string;
  startedAt: number | null;
  endedAt: number | null;
  /** 0…1 only when truly measurable, else null (no invented percentages). */
  progress: number | null;
  /** true when this stage sends data off this Mac. */
  remote: boolean;
}

export interface JobContext {
  projectPath: string;
  get(): Project;
  update(fn: (p: Project) => Project): void;
  setStages(s: StageState[]): void;
  signal: AbortSignal;
  settings: AppSettings;
  /** false = the creator declined remote processing → built-in rules only. */
  useClaude: boolean;
}

export type JobErrorCode = 'cancelled' | 'missing-source' | 'no-sources' | 'permission' | 'native-failed' | 'failed';

/** Typed failure of one stage. Completed stage checkpoints are left intact. */
export class JobError extends Error {
  readonly stage: JobStage;
  readonly code: JobErrorCode;
  readonly retryable: boolean;
  constructor(stage: JobStage, code: JobErrorCode, message: string, retryable = true) {
    super(message);
    this.name = 'JobError';
    this.stage = stage;
    this.code = code;
    this.retryable = retryable;
  }
}

/** How the AI part of a job was actually carried out. */
export interface AiUse {
  mode: 'claude' | 'local-rules';
  /** Why Claude was not used, when it was not. null when it was. */
  reason: string | null;
  /** true when the creator allowed Claude but it could not be used. */
  fellBack: boolean;
}
