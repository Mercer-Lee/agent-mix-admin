import type { ReactNode } from "react";

function safeHref(value: string): string | null {
  try {
    const url = new URL(value);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? value : null;
  } catch {
    return null;
  }
}

function renderInline(text: string): ReactNode[] {
  const tokens = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g);
  return tokens.filter(Boolean).map((token, index) => {
    if (token.startsWith("**") && token.endsWith("**")) {
      return <strong key={index}>{token.slice(2, -2)}</strong>;
    }
    if (token.startsWith("`") && token.endsWith("`")) {
      return <code key={index} className="bg-white/10 px-1 py-0.5 font-mono text-[0.9em] text-[#d8ff65]">{token.slice(1, -1)}</code>;
    }
    const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) {
      const href = safeHref(link[2]!);
      return href ? (
        <a key={index} href={href} target="_blank" rel="noreferrer noopener" className="text-[#caff24] underline decoration-[#b8f500]/40 underline-offset-4">
          {link[1]}
        </a>
      ) : <span key={index}>{link[1]}</span>;
    }
    return <span key={index}>{token}</span>;
  });
}

function TextBlock({ value }: { value: string }) {
  const lines = value.split("\n");
  const nodes: ReactNode[] = [];
  let list: string[] = [];

  function flushList() {
    if (!list.length) return;
    nodes.push(
      <ul key={`list-${nodes.length}`} className="my-3 list-square space-y-1 pl-5 marker:text-[#b8f500]">
        {list.map((item, index) => <li key={index}>{renderInline(item)}</li>)}
      </ul>,
    );
    list = [];
  }

  lines.forEach((line, index) => {
    const listItem = line.match(/^\s*[-*]\s+(.+)$/);
    if (listItem) {
      list.push(listItem[1]!);
      return;
    }
    flushList();
    if (!line.trim()) return;
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      nodes.push(
        <h3 key={index} className="mb-2 mt-5 text-base font-semibold text-zinc-100">{renderInline(heading[2]!)}</h3>,
      );
      return;
    }
    nodes.push(<p key={index} className="my-2 whitespace-pre-wrap leading-7">{renderInline(line)}</p>);
  });
  flushList();
  return nodes;
}

export function SafeMarkdown({ content }: { content: string }) {
  const blocks = content.split(/```/);
  return (
    <div className="text-sm text-zinc-300">
      {blocks.map((block, index) => {
        if (index % 2 === 0) return <TextBlock key={index} value={block} />;
        const firstNewline = block.indexOf("\n");
        const language = firstNewline >= 0 ? block.slice(0, firstNewline).trim() : "";
        const code = firstNewline >= 0 ? block.slice(firstNewline + 1) : block;
        return (
          <div key={index} className="my-4 overflow-hidden border border-white/10 bg-[#070809]">
            {language ? <div className="border-b border-white/10 px-3 py-2 font-mono text-[10px] tracking-wider text-zinc-600 uppercase">{language}</div> : null}
            <pre className="m-0 overflow-x-auto p-4 text-xs leading-6 text-zinc-300"><code>{code}</code></pre>
          </div>
        );
      })}
    </div>
  );
}
