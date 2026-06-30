// AI-generated. See PROMPT.md for the prompts and model used.

import { User } from "lucide-react";
import { MarkdownView } from "./MarkdownView";

interface Props {
  content: string;
}

export const UserMessage = ({ content }: Props) => {
  return (
    <div className="msg-user" data-testid="msg-user">
      <div className="flex items-center gap-2 mb-2 text-xs text-muted-foreground">
        <User size={14} />
        <span className="font-medium">You</span>
      </div>
      <MarkdownView>{content}</MarkdownView>
    </div>
  );
};
