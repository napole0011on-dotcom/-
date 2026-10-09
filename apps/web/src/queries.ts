import { useQuery } from '@tanstack/react-query';
import {
  api,
  type AgentCard,
  type AgentSettings,
  type Approvals,
  type LlmStatus,
  type RunCardData,
  type Spend,
  type TaskDetail,
  type TaskRow,
} from './api';

// Live updates by polling: 3 s for things that move (agents, tasks, approvals), 10 s for spend.
// React Query stops polling while the tab is hidden and refetches when it becomes visible again.
const FAST = 3_000;
const SLOW = 10_000;

export const useStatus = () =>
  useQuery({
    queryKey: ['status'],
    queryFn: () => api.get<LlmStatus>('/api/status'),
    refetchInterval: SLOW,
  });
export const useAgents = () =>
  useQuery({
    queryKey: ['agents'],
    queryFn: () => api.get<AgentCard[]>('/api/agents'),
    refetchInterval: FAST,
  });
export const useTasks = () =>
  useQuery({
    queryKey: ['tasks'],
    queryFn: () => api.get<TaskRow[]>('/api/tasks'),
    refetchInterval: FAST,
  });
export const useApprovals = () =>
  useQuery({
    queryKey: ['approvals'],
    queryFn: () => api.get<Approvals>('/api/approvals'),
    refetchInterval: FAST,
  });
export const useSpend = () =>
  useQuery({
    queryKey: ['spend'],
    queryFn: () => api.get<Spend>('/api/spend'),
    refetchInterval: SLOW,
  });
export const useTask = (id: string) =>
  useQuery({
    queryKey: ['task', id],
    queryFn: () => api.get<TaskDetail>(`/api/tasks/${id}`),
    refetchInterval: FAST,
  });
export const useRun = (id: string) =>
  useQuery({
    queryKey: ['run', id],
    queryFn: () => api.get<RunCardData>(`/api/runs/${id}`),
    refetchInterval: FAST,
  });
export const useAgentSettings = (id: string) =>
  useQuery({
    queryKey: ['agent-settings', id],
    queryFn: () => api.get<AgentSettings>(`/api/agents/${id}/settings`),
    refetchInterval: SLOW,
  });
