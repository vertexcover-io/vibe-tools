// AI-generated. See PROMPT.md for the prompts and model used.

import { Sparkles } from "lucide-react";
import { MarkdownView } from "./MarkdownView";

interface Props {
  content: string;
  model?: string;
}

export const AssistantMessage = ({ content, model }: Props) => {
  return (
    <div className="msg-assistant" data-testid="msg-assistant">
      <div className="flex items-center gap-2 mb-2 text-xs text-muted-foreground">
        <Sparkles size={14} />
        <span className="font-medium">Claude</span>
        {model && <span className="font-mono text-xs">({model})</span>}
      </div>
      <MarkdownView>{content}</MarkdownView>
    </div>
  );
};
