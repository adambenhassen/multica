/** CI at an open pull request's head commit that has not passed: no check
 * started yet (`queued`), some started (`running`), or `failed`. */
export type IssueCIState = "queued" | "running" | "failed";

export interface IssueCIPullRequest {
  /** `github`, `gitea`, `forgejo` or `gitlab`. */
  provider: string;
  repo_owner: string;
  repo_name: string;
  number: number;
  html_url: string;
}

/** One issue whose open pull request has CI queued, running or failed. */
export interface IssueCIEntry {
  issue_id: string;
  issue_status: string;
  state: IssueCIState;
  /** When CI was queued, started or failed; null when unknown. */
  since: string | null;
  pull_request: IssueCIPullRequest;
}

export interface IssueCIResponse {
  issues: IssueCIEntry[];
}
