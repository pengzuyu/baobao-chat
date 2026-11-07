// 会议域 react-query 钩子
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { qk } from '../../../shared/api/keys';
import * as api from './meeting';
import type { CreateMeetingReq, CreateRecurringReq } from '../model/types';

export function useMyMeetings(from: number, to: number) {
  return useQuery({ queryKey: qk.meeting.list(from, to), queryFn: () => api.listMyMeetings(from, to) });
}

export function useCalendar(from: number, to: number) {
  return useQuery({ queryKey: qk.meeting.calendar(from, to), queryFn: () => api.fetchCalendar(from, to) });
}

export function useMeeting(id: string | null) {
  return useQuery({
    queryKey: qk.meeting.detail(id ?? ''),
    queryFn: () => api.fetchMeeting(id as string),
    enabled: !!id,
  });
}

export function useCreateMeeting() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: CreateMeetingReq) => api.createMeeting(req),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['meeting'] }),
  });
}

export function useCreateRecurring() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: CreateRecurringReq) => api.createRecurring(req),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['meeting'] }),
  });
}

export function useRsvp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, rsvp }: { id: string; rsvp: number }) => api.rsvpMeeting(id, rsvp),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['meeting'] }),
  });
}

export function useReschedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, start, end }: { id: string; start: number; end: number }) =>
      api.rescheduleMeeting(id, start, end),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['meeting'] }),
  });
}

export function useCancelMeeting() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.cancelMeeting(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['meeting'] }),
  });
}

export function useStartMeeting() {
  return useMutation({ mutationFn: (id: string) => api.startMeeting(id) });
}

export function useEndMeeting() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.endMeeting(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['meeting'] }),
  });
}
