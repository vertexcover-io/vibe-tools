// AI-generated. See PROMPT.md for the prompts and model used.

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface Props {
  children: string;
}

export const MarkdownView = ({ children }: Props) => {
  return (
    <div className="prose-tight text-sm">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
};
