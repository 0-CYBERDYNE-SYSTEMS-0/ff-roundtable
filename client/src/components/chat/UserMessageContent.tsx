import type { ReactNode } from "react";
import { requestPresentation } from "@/lib/request-presentation";

export default function UserMessageContent({ content, renderBody }: {
  content: string;
  renderBody: (content: string) => ReactNode;
}) {
  const presentation = requestPresentation(content);
  if (!presentation) return <>{renderBody(content)}</>;

  return <>
    <div>{renderBody(presentation.summary)}</div>
    <details className="mt-3 border-t border-white/20 pt-2">
      <summary className="cursor-pointer rounded text-xs font-medium text-white/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white">
        Request details
      </summary>
      <div className="mt-3 max-h-80 overflow-auto pr-2 text-sm" data-testid="request-details">
        {renderBody(content)}
      </div>
    </details>
  </>;
}
