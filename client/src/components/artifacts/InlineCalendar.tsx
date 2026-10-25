import { CalendarDays } from "lucide-react";
import { parseInlineCalendar } from "@shared/inline-calendar";

export { parseInlineCalendar };

function formatDay(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

/** Compact dated event list rendered inside the chat message. */
export default function InlineCalendar({ content }: { content: string }) {
  const cal = parseInlineCalendar(content);
  if (!cal) return <div className="text-sm text-neutral-600">No dated events in this plan yet.</div>;
  return (
    <div className="space-y-2" data-testid="inline-calendar">
      <ol className="divide-y divide-neutral-200 rounded-lg border border-neutral-200">
        {cal.events.map((event, i) => (
          <li key={`${event.startDate}-${i}`} className="flex gap-3 px-3 py-2 text-sm">
            <span className="flex w-36 shrink-0 items-start gap-1.5 font-medium text-farm-dark-green">
              <CalendarDays className="mt-0.5 h-3.5 w-3.5" aria-hidden />{formatDay(event.startDate)}
            </span>
            <span className="min-w-0">
              <span className="block font-medium">{event.summary}</span>
              {event.description && <span className="block text-xs text-neutral-600 line-clamp-2">{event.description}</span>}
            </span>
          </li>
        ))}
      </ol>
      <p className="text-xs text-neutral-500">{cal.events.length} events · edit dates or export .ics from Calendar plan in the sidebar.</p>
    </div>
  );
}
