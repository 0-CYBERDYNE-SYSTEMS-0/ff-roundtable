import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { calendarEventsSchema, type CalendarDraft, type CalendarEvent } from "@shared/calendar-draft";
import { addDays, endOfMonth, format, startOfMonth, startOfWeek } from "date-fns";
import { ChevronLeft, ChevronRight, Download, Plus, Save, Trash2 } from "lucide-react";
import CalendarEventNotes from "./CalendarEventNotes";

export default function CalendarPreviewDialog({ conversationId, start, fileId, onClose }: {
  conversationId: number; start: string; fileId?: number; onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<CalendarDraft | null>(null);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [dirty, setDirty] = useState(false);
  const [view, setView] = useState<"agenda" | "month">("agenda");
  const [month, setMonth] = useState((start || format(new Date(), 'yyyy-MM-dd')).slice(0, 7));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams(start ? { start } : {});
    if (fileId) query.set("fileId", String(fileId));
    void fetch(`/api/protected/conversations/${conversationId}/calendar?${query}`, { credentials: "include", signal: controller.signal })
      .then(async response => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.message || "Calendar preview unavailable");
        if (result.empty) throw new Error(result.message || "No schedulable items found.");
        if (!controller.signal.aborted) {
          setDraft(result); setEvents(result.events);
          setMonth(result.events.map((event: CalendarEvent) => event.startDate).sort()[0]?.slice(0, 7) || (start || format(new Date(), 'yyyy-MM-dd')).slice(0, 7));
        }
      })
      .catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [conversationId, start, fileId]);

  function update(uid: string, change: Partial<CalendarEvent>) {
    setEvents(previous => previous.map(event => event.uid === uid ? { ...event, ...change } : event));
    setDirty(true); setStatus("");
  }
  async function save(exportAfter = false) {
    if (!draft) return;
    setError(""); setStatus("");
    if (!draft.readOnlyReason && !calendarEventsSchema.safeParse(events).success) {
      setError("Include 1–200 events, each with a title (up to 75 characters), valid date, and description up to 4,000 characters."); return;
    }
    setBusy(true);
    try {
      let downloadId = draft.currentFileId ?? draft.sourceFileId ?? fileId;
      if (!draft.readOnlyReason && (dirty || !draft.currentFileId)) {
        const response = await fetch(`/api/protected/conversations/${conversationId}/calendar`, {
          method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ events, expectedCurrentFileId: draft.currentFileId, sourceFileId: draft.sourceFileId }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.message || "Calendar could not be saved");
        downloadId = result.currentFileId;
        setDraft({ ...draft, currentFileId: result.currentFileId, version: result.version });
        setDirty(false); setStatus(`Saved calendar v${result.version}.`);
        void queryClient.invalidateQueries({ queryKey: [`/api/protected/conversations/${conversationId}/files`] });
      }
      if (exportAfter && downloadId) {
        const response = await fetch(`/api/protected/conversations/${conversationId}/files/${downloadId}/download`, { credentials: "include" });
        if (!response.ok) throw new Error("Calendar download failed. Your saved revision is available in Files.");
        const url = URL.createObjectURL(await response.blob());
        const link = document.createElement("a");
        link.href = url; link.download = "reviewed-calendar.ics"; link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (error) { setError(error instanceof Error ? error.message : "Calendar could not be saved"); }
    finally { setBusy(false); }
  }
  const sorted = [...events].sort((a, b) => a.startDate.localeCompare(b.startDate));
  const monthDate = new Date(`${month || start.slice(0, 7)}-01T12:00:00`);
  const gridStart = startOfWeek(startOfMonth(monthDate));
  const days = Array.from({ length: Math.ceil((endOfMonth(monthDate).getDate() + startOfMonth(monthDate).getDay()) / 7) * 7 }, (_, index) => addDays(gridStart, index));
  const readOnly = !!draft?.readOnlyReason;
  const fieldClass = "w-full rounded-md border border-neutral-300 bg-card px-3 py-2 text-sm disabled:bg-neutral-50 disabled:text-neutral-600";

  return <Dialog open onOpenChange={open => { if (!open && !busy && (!dirty || window.confirm("Discard unsaved calendar edits?"))) onClose(); }}>
    <DialogContent className="max-w-5xl w-[calc(100%-1rem)] max-h-[92vh] flex flex-col p-4 sm:p-6">
      <DialogHeader>
        <DialogTitle>Calendar preview{draft?.version ? ` · v${draft.version}` : ""}</DialogTitle>
        <DialogDescription>{draft?.calendarName || "Review the schedule"} · {events.length} events · {readOnly ? "Original calendar preview." : "All-day dates stay on the selected calendar day. Edits are saved as a calendar revision; the council’s plan is unchanged."}</DialogDescription>
      </DialogHeader>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {status && <p role="status" className="text-sm text-farm-dark-green">{status}</p>}
      {draft?.readOnlyReason && <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-900">{draft.readOnlyReason}</p>}
      {!draft && !error && <p role="status">Loading events…</p>}
      {draft && <>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant={view === "agenda" ? "default" : "outline"} onClick={() => setView("agenda")}>Agenda</Button>
          <Button size="sm" variant={view === "month" ? "default" : "outline"} onClick={() => setView("month")}>Month</Button>
          <span className="text-xs text-neutral-500 ml-auto">{dirty ? "Unsaved changes" : draft.version ? "Saved revision" : "Review before exporting"}</span>
        </div>
        <div className="min-h-0 overflow-auto flex-1 pr-1">
          {draft.originalContent && <details className="mb-4 rounded border p-3 text-sm"><summary className="cursor-pointer">View original calendar · all event fields</summary><pre className="max-h-64 overflow-auto mt-2 text-xs whitespace-pre-wrap">{draft.originalContent}</pre></details>}
          {view === "agenda" ? <div className="space-y-3">
            {sorted.map((event, index) => <fieldset key={event.uid} id={`calendar-event-${index}`} disabled={busy || readOnly} className="rounded-lg border border-neutral-200 p-4 space-y-3">
              <legend className="px-1 text-xs font-medium text-neutral-500">Event {index + 1} · {event.startDate}</legend>
              <div className="grid sm:grid-cols-[1fr_10rem_auto] gap-3 items-end">
                <label className="text-xs font-medium">Event title<input aria-label={`Event ${index + 1} title`} value={event.summary} maxLength={75} className={fieldClass} onChange={e => update(event.uid, { summary: e.target.value })} /></label>
                <label className="text-xs font-medium">Date<input aria-label={`Event ${index + 1} date`} type="date" value={event.startDate} className={fieldClass} onChange={e => update(event.uid, { startDate: e.target.value })} /></label>
                {!readOnly && <Button size="icon" variant="ghost" aria-label={`Remove event ${index + 1}`} onClick={() => { setEvents(events.filter(item => item.uid !== event.uid)); setDirty(true); setStatus(""); }}><Trash2 className="h-4 w-4" /></Button>}
              </div>
              <CalendarEventNotes value={event.description} eventNumber={index + 1} readOnly={readOnly} onChange={description => update(event.uid, { description })} />
            </fieldset>)}
            {!events.length && <p className="text-sm text-neutral-500 py-8">No events. Add an event to save and export this calendar.</p>}
          </div> : <div>
            <div className="flex items-center justify-center gap-3 mb-4">
              <Button size="icon" variant="ghost" aria-label="Previous month" onClick={() => setMonth(format(addDays(startOfMonth(monthDate), -1), "yyyy-MM"))}><ChevronLeft className="h-4 w-4" /></Button>
              <label className="text-sm">Month <input aria-label="Calendar month" type="month" value={month} onChange={e => { if (e.target.value) setMonth(e.target.value); }} className="rounded border px-2 py-1" /></label>
              <Button size="icon" variant="ghost" aria-label="Next month" onClick={() => setMonth(format(addDays(endOfMonth(monthDate), 1), "yyyy-MM"))}><ChevronRight className="h-4 w-4" /></Button>
            </div>
            <div className="overflow-x-auto"><div className="grid grid-cols-7 min-w-[560px]">
              {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(day => <div key={day} className="text-center text-xs font-medium text-neutral-500 pb-2">{day}</div>)}
              {days.map(day => { const date = format(day, "yyyy-MM-dd"); return <div key={date} className={`min-h-24 p-1.5 border border-neutral-100 ${day.getMonth() !== monthDate.getMonth() ? "bg-neutral-50 text-neutral-400" : "bg-card"}`}>
                <span className="text-xs">{day.getDate()}</span>
                {sorted.filter(event => event.startDate === date).map(event => <button key={event.uid} className="block w-full text-left text-xs bg-emerald-50 text-emerald-900 rounded p-1 mt-1 break-words" onClick={() => { setView("agenda"); window.requestAnimationFrame(() => document.getElementById(`calendar-event-${sorted.indexOf(event)}`)?.scrollIntoView({ block: "center" })); }}>{event.summary}</button>)}
              </div>; })}
            </div></div>
          </div>}
        </div>
        <div className="flex flex-wrap gap-2 pt-3 border-t">
          {!readOnly && <Button variant="outline" disabled={busy || events.length >= 200} onClick={() => { setEvents([...events, { uid: `${crypto.randomUUID()}@farmfriend-roundtable`, summary: "New event", startDate: start, description: "" }]); setDirty(true); setView("agenda"); setStatus(""); }}><Plus className="h-4 w-4 mr-2" />Add event</Button>}
          {!readOnly && <Button variant="outline" disabled={busy || !events.length || (!dirty && !!draft.currentFileId)} onClick={() => save()}><Save className="h-4 w-4 mr-2" />Save revision</Button>}
          <Button className="sm:ml-auto" disabled={busy || !events.length} onClick={() => save(true)}><Download className="h-4 w-4 mr-2" />{busy ? "Saving…" : readOnly ? "Download original .ics" : "Export reviewed .ics"}</Button>
        </div>
      </>}
    </DialogContent>
  </Dialog>;
}
