import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";

// Deployment-wide (not workspace-scoped): every member sees the same accounts.
export const providerQuotaKeys = {
  all: ["provider-quota"] as const,
};

export function providerQuotaOptions() {
  return queryOptions({
    queryKey: providerQuotaKeys.all,
    queryFn: () => api.getProviderQuota(),
    staleTime: 30 * 1000,
    refetchInterval: 60 * 1000,
  });
}
