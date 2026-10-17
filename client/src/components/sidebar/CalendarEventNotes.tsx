import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";

export default function CalendarEventNotes({ value, eventNumber, readOnly, onChange }: {
  value: string; eventNumber: number; readOnly: boolean; onChange: (value: string) => void;
}) {
  const [editing, setEditing] = useState(!value.trim());
  const [expanded, setExpanded] = useState(false);
  // Presentation only: exported notes retain their original plain-text headings.
  const preview = value.replace(/^(OBJECTIVE|BEFORE YOU START|STEPS|RATES AND QUANTITIES|SOURCES|COMPLETION CHECK|AI HANDOFF):?\s*$/gm, "### $1");

  return <div className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-sm font-medium text-neutral-800">Notes / task instructions</span>
      {!readOnly && <Button size="sm" variant="ghost" aria-label={`${editing ? "Preview" : "Edit"} event ${eventNumber} notes`} onClick={() => setEditing(!editing)}>{editing ? "Preview notes" : "Edit notes"}</Button>}
    </div>
    <p className="text-xs text-neutral-500">Exports to the calendar event’s Notes / Description. Separate sections with blank lines.</p>
    {editing && !readOnly ? <>
      <textarea aria-label={`Event ${eventNumber} notes / task instructions`} value={value} maxLength={4000} rows={expanded ? 20 : 10}
        className="block w-full rounded-md border border-neutral-300 bg-white px-4 py-3 text-sm leading-7 focus-visible:outline focus-visible:outline-2 focus-visible:outline-farm-blue"
        onChange={event => onChange(event.target.value)} />
      <div className="flex items-center justify-between gap-2 text-xs text-neutral-500">
        <Button size="sm" variant="ghost" onClick={() => setExpanded(!expanded)}>{expanded ? "Smaller editor" : "Expand editor"}</Button>
        <span>{value.length.toLocaleString()} / 4,000 characters</span>
      </div>
    </> : <div className="rounded-md border border-neutral-200 bg-neutral-50/60 px-4 py-3 text-sm leading-7 [overflow-wrap:anywhere]" aria-label={`Event ${eventNumber} notes preview`}>
      {value.trim() ? <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
        h3: ({ children }) => <h4 className="mb-2 mt-5 first:mt-0 text-xs font-semibold tracking-wide text-farm-dark-green">{children}</h4>,
        p: ({ children }) => <p className="mb-4 last:mb-0 whitespace-pre-wrap">{children}</p>,
        ol: ({ children }) => <ol className="mb-4 list-decimal space-y-2 pl-5">{children}</ol>,
        ul: ({ children }) => <ul className="mb-4 list-disc space-y-2 pl-5">{children}</ul>,
        a: ({ href, children }) => href && /^https?:\/\//i.test(href)
          ? <a href={href} target="_blank" rel="noopener noreferrer" className="text-farm-blue underline underline-offset-2">{children}</a>
          : <span>{children}</span>,
        img: ({ alt }) => <span>{alt}</span>,
      }}>{preview}</ReactMarkdown> : <p className="text-neutral-500">No notes yet.</p>}
    </div>}
  </div>;
}
