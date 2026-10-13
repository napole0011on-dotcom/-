import { useQuery } from '@tanstack/react-query';
import {
  api,
  type AgentCard,
  type AgentSettings,
  type LiveEvent,
  type RunEvent,
  type BlocksData,
  type TaskPathData,
  type WorkspaceData,
  type Approvals,
  type LlmStatus,
  type RunCardData,
  type Spend,
  type TaskDetail,
  type TaskRow,
  type TranscriptDetail,
  type TranscriptRow,
  type MailingData,
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

export const useBlocks = (id: string) =>
  useQuery({
    queryKey: ['blocks', id],
    queryFn: () => api.get<BlocksData>(`/api/agents/${id}/blocks`),
    refetchInterval: SLOW,
  });

export const useWorkspace = () =>
  useQuery({
    queryKey: ['workspace'],
    queryFn: () => api.get<WorkspaceData>('/api/workspace'),
    refetchInterval: FAST,
  });
/** Live feed; SSE pushes new events, polling is the fallback (interval set by the caller). */
export const useEvents = (pollMs: number | false) =>
  useQuery({
    queryKey: ['events'],
    queryFn: () => api.get<LiveEvent[]>('/api/events'),
    refetchInterval: pollMs,
  });
export const useTaskPath = (id: string | null) =>
  useQuery({
    queryKey: ['task-path', id],
    queryFn: () => api.get<TaskPathData>(`/api/tasks/${id}/path`),
    enabled: !!id,
    refetchInterval: FAST,
  });

export const useRunEvents = (id: string | null) =>
  useQuery({
    queryKey: ['run-events', id],
    queryFn: () => api.get<RunEvent[]>(`/api/tasks/${id}/run-events`),
    enabled: !!id,
    refetchInterval: FAST,
  });

export const useTranscripts = () =>
  useQuery({
    queryKey: ['transcripts'],
    queryFn: () => api.get<TranscriptRow[]>('/api/transcripts'),
    refetchInterval: FAST,
  });

export const useTranscript = (id: string) =>
  useQuery({
    queryKey: ['transcript', id],
    queryFn: () => api.get<TranscriptDetail>(`/api/transcripts/${id}`),
    // Poll only while it is still being transcribed.
    refetchInterval: (q) =>
      q.state.data && ['done', 'failed', 'cancelled'].includes(q.state.data.status) ? false : FAST,
  });

export const useMailing = () =>
  useQuery({
    queryKey: ['mailing'],
    queryFn: () => api.get<MailingData>('/api/mailing'),
    refetchInterval: FAST,
  });
