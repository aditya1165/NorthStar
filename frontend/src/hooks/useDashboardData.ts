import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../lib/api";

export function useDashboardData() {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries();

  const state = useQuery({
    queryKey: ["state"],
    queryFn: api.getState,
    refetchInterval: 1500,
  });
  const forecasts = useQuery({
    queryKey: ["forecasts", state.data?.elapsed_minutes],
    queryFn: api.getForecasts,
    enabled: Boolean(state.data),
  });
  const interventions = useQuery({
    queryKey: ["interventions", state.data?.elapsed_minutes],
    queryFn: api.getInterventions,
    enabled: Boolean(state.data),
  });

  const action = useMutation({
    mutationFn: (operation: () => Promise<unknown>) => operation(),
    onSuccess: refresh,
  });

  return { state, forecasts, interventions, action, refresh };
}

