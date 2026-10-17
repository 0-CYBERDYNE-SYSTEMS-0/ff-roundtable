import { z } from "zod";
import { parseIsoDate } from "./calendar-date";

export const calendarEventSchema = z.object({
  uid: z.string().min(1).max(200).regex(/^[^\r\n\x00-\x1f]+$/),
  summary: z.string().trim().min(1).max(75).regex(/^[^\r\n\x00-\x1f]+$/),
  startDate: z.string().refine(value => !!parseIsoDate(value), "Use a valid YYYY-MM-DD date"),
  description: z.string().max(4000).default(""),
});
export const calendarEventsSchema = z.array(calendarEventSchema).min(1).max(200)
  .refine(events => new Set(events.map(event => event.uid)).size === events.length, "Event IDs must be unique");
export type CalendarEvent = z.infer<typeof calendarEventSchema>;
export type CalendarDraft = {
  events: CalendarEvent[];
  calendarName: string;
  currentFileId: number | null;
  sourceFileId?: number;
  version: number | null;
  readOnlyReason?: string;
  originalContent?: string;
};
