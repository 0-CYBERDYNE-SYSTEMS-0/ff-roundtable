import ICAL from "ical.js";
import { calendarEventsSchema, type CalendarEvent } from "@shared/calendar-draft";
import { addDaysIso } from "@shared/ics";

/** Inspect every VEVENT. Unsupported calendar semantics are never silently flattened. */
export function inspectCalendar(content: string): { events: CalendarEvent[]; readOnlyReason?: string; originalContent?: string } {
  const calendar = new ICAL.Component(ICAL.parse(content));
  if (calendar.name !== "vcalendar") throw new Error("Not a calendar");
  const supportedCalendarProperties = new Set(["version", "prodid", "calscale", "method", "x-wr-calname"]);
  let unsupported = calendar.getAllSubcomponents().some(component => component.name !== "vevent") ||
    calendar.getAllProperties().some(property => !supportedCalendarProperties.has(property.name));
  const components = calendar.getAllSubcomponents("vevent");
  if (components.length > 200) throw new Error("Calendar preview supports up to 200 events");
  const events = components.map((component, index) => {
    const start = component.getFirstPropertyValue("dtstart") as ICAL.Time | null;
    if (!start) throw new Error("An event is missing its start date");
    const end = component.getFirstPropertyValue("dtend") as ICAL.Time | null;
    const date = start.toString().slice(0, 10);
    const supportedProperties = new Set(["uid", "dtstamp", "dtstart", "dtend", "summary", "description"]);
    if (!start.isDate || (end && (!end.isDate || end.toString() !== addDaysIso(date, 1))) ||
      component.getAllSubcomponents().length > 0 || component.getAllProperties().some(property => !supportedProperties.has(property.name))) unsupported = true;
    return {
      uid: String(component.getFirstPropertyValue("uid") || `event-${index}`),
      summary: String(component.getFirstPropertyValue("summary") || "Untitled event"),
      startDate: date,
      description: String(component.getFirstPropertyValue("description") || "") +
        (!start.isDate ? `\nStart: ${start.toString()}${start.zone.tzid ? ` (${start.zone.tzid})` : ""}` : "") +
        (end ? `\nEnd (exclusive): ${end.toString()}` : "") +
        (component.hasProperty("rrule") ? `\nRecurrence: ${component.getFirstProperty("rrule")?.toICALString()}` : ""),
    };
  });
  // Metadata is displayed for read-only files; editable events retain their original descriptions.
  const editable = events.map((event, index) => ({ ...event, description: String(components[index].getFirstPropertyValue("description") || "") }));
  const valid = calendarEventsSchema.safeParse(editable);
  if (!valid.success) unsupported = true;
  return unsupported
    ? { events, originalContent: content, readOnlyReason: "This file includes timing, recurrence, extended fields, or event sizes outside the all-day editor. Recurring events are shown as series definitions, not expanded occurrences. Review the original details below and download the original to preserve them." }
    : { events: valid.success ? valid.data : editable };
}
