/** CI at an open pull request's head commit that has not passed. */
export type IssueCIState = "pending" | "failed";

export interface IssueCIPullRequest {
  /** `github`, `gitea`, `forgejo` or `gitlab`. */
  provider: string;
  repo_owner: string;
  repo_name: string;
  number: number;
  html_url: string;
}

/** One issue whose open pull request has CI pending or failed. */
export interface IssueCIEntry {
  issue_id: string;
  issue_status: string;
  state: IssueCIState;
  /** When CI started (pending) or failed; null when unknown. */
  since: string | null;
  pull_request: IssueCIPullRequest;
}

export interface IssueCIResponse {
  issues: IssueCIEntry[];
}
