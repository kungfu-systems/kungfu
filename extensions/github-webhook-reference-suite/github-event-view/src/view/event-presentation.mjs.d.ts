export type GitHubEvidenceRow = {
  index: number;
  valid: boolean;
  accepted?: boolean;
  outcome?: string;
  code?: string;
  delivery?: string;
  event?: string;
  action?: string;
  repository?: string;
  sender?: string;
  payloadRoot?: string;
  receiptRoot?: string;
  replayed?: boolean;
};

export function presentGitHubEvidence(
  text: string,
  maximumRows?: number,
): {
  rows: GitHubEvidenceRow[];
  diagnostics: Array<{ line: number | null; code: string }>;
};
