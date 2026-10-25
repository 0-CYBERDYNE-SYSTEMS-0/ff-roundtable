export const CALENDAR_NOTES_PROMPT = `
CALENDAR NOTES / TASK INSTRUCTIONS:
An event's DESCRIPTION becomes Notes or Description in calendar apps. Make it a self-contained, readable task brief, not a compressed reminder. Use plain-text section labels, blank lines between sections, and one numbered step per line. Do not cram steps, sources and prompts into one paragraph or use HTML, Markdown tables, or code fences. Keep each description within 4,000 characters; shorten deliberately rather than cutting off a section.

Use only sections useful for that event:
OBJECTIVE — the specific result to achieve.
BEFORE YOU START — required inputs, prerequisites, dependencies and assumptions. Ask for missing inputs; never invent measurements.
STEPS — ordered, actionable instructions, one step per line.
RATES AND QUANTITIES — only where appropriate and permitted: quote rates/dosages from a verified, applicable source or product label, with units, formulation/concentration, intended use and relevant limits. Identify the exact supporting URL. Separate quoted rates from calculated quantities, show the calculation and supplied inputs, and do not guess missing values or extrapolate to an unsupported use. Omit this section when it does not apply. Do not include controlled-substance cultivation instructions.
SOURCES — a short resource name and exact retrieved or farmer-supplied URL, on separate lines. Say what each link is for; never fabricate links or imply an unfetched source was verified.
COMPLETION CHECK — what output or evidence confirms the task is complete.
AI HANDOFF (optional) — a copyable prompt for another AI/agent, with Task, Context, Inputs needed, Expected output, Completion checks, and Limits / human approval. Include enough context to stand alone without this chat. Ask it to flag missing inputs, cite its sources and separate assumptions from facts. A calendar note is not authorization to execute an action: the agent must obtain the user's explicit approval before sending messages, changing records, spending money, or controlling equipment.

For example, a literature-review event can use:
OBJECTIVE
Create a source-backed evidence summary.

STEPS
1. Open the supplied reference links and confirm their scope.
2. Record what each source states and what remains unknown.
3. Summarize the findings without unsupported extrapolation.

COMPLETION CHECK
A concise summary with source URLs and an explicit list of evidence gaps.

AI HANDOFF
Task: Review the references listed in this event.
Context: This is a desk-research review, not a field measurement or treatment instruction.
Inputs needed: The reference URLs and the research question; ask if either is missing.
Expected output: A brief summary, source list and unresolved questions.
Completion checks: Every factual claim has appropriate support; uncertainty is explicit.
Limits / human approval: Prepare a draft only. Do not publish, contact others or change external records without approval.
Never copy this example as actual event content without tailoring it to the user's task.
`;

/**
 * A table the farmer wants "as a calendar" must carry a schedulable column, or
 * the Calendar plan (shared/schedule-extract.ts) has nothing to pick up.
 */
export const CALENDAR_TABLE_RULE = `CALENDAR REQUESTS: when the farmer asks for a calendar, schedule, or dated plan, the table itself is the calendar. Its FIRST column must be "Week" (values W1, W2, …, counted from the plan's start) or "Date" (ISO YYYY-MM-DD). Never use relative offsets like "T-14" or "2 weeks before planting" as the only timing, and never promise "the following calendar" without that table. If the start date is unknown, use Week numbers and say the farmer picks the start date in the Calendar plan.`;
