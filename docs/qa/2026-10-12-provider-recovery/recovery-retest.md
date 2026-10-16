# Live pause, restart, and resume retest — 2026-10-12

The exact pending File Creator request survived a local app restart and completed when the roundtable resumed, without another farmer message.

In fresh developer conversation 12, the initial farmer question produced a Soil Scientist response, a rendered cost comparison chart, and `nitrogen-cost-plan.md` version 1. To create a pending file operation for the recovery check, I sent: “Revise nitrogen-cost-plan.md: change the title to Restart Resume Verified; keep the math and three next steps.” The message was accepted as request 67; an immediate pause returned HTTP 200. A read-only database check showed the conversation paused in autonomous mode with `sequenceFileCreatorRequestId=67`, before the revision created a new file version. The paused screen is captured in [recovery-revision-paused.png](screenshots/recovery-revision-paused.png).

I restarted only the owned local dev process, then clicked **Resume the roundtable** in the UI without sending another farmer message. The saved request ran: file 11 became current version 2, file 10 remained as superseded version 1, and conversation 12 returned to Idle. The authenticated files-list request returned HTTP 200. Downloading `/api/protected/conversations/12/files/11/download` also returned HTTP 200 with `text/markdown` and an attachment filename of `nitrogen-cost-plan.md`; the 1,175-character file has the requested title, includes the assumptions, and contains three next steps. The rendered chart, Idle status, and file are visible in [recovery-after-resume-chart.png](screenshots/recovery-after-resume-chart.png).

The initial request completed before the pause, so this retest specifically validates restoration of the later revision request, not recovery of the original request. Conversation 12 was isolated from existing conversations 10 and 11 and files 8 and 9.

During the same resumed run, a subsequent additional File Creator attempt logged `Response generation failed for expert Document Builder`; the moderator then concluded and the conversation reached Idle with version 2 intact. The recovery path passed, while that extra failed attempt is a separate observed turn error. This run does not establish its cause, so no code change is proposed from this evidence alone.

For handoff, I restarted the owned `wH:p5` server as plain `npm run dev` with `OPENROUTER_SPEND_CAP_USD` unset. The server reports port 5001, `http://localhost:5001` returns HTTP 200, and the authenticated conversation still lists file versions 2 and 1. The normal dev server remains running.
