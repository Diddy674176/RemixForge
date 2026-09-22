import { useRef, useState } from 'react';
import { interpret } from '../../assistant/interpret.ts';
import { EXAMPLES } from '../../assistant/vocabulary.ts';
import type { Project } from '../../state/types.ts';
import { Panel } from '../components/primitives.tsx';

interface Message {
  id: number;
  role: 'user' | 'bot';
  text: string;
  ok?: boolean;
  suggestions?: string[];
}

let messageId = 0;

/**
 * Production assistant.
 *
 * Rule-based rather than a model call — it runs offline, it is predictable, and
 * every instruction it understands maps onto an ordinary store action, so its
 * edits appear in the undo history like any other.
 */
export function Assistant({ project }: { project: Project }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  const send = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setInput('');
    const result = interpret(trimmed, project);
    setMessages((prev) => [
      ...prev,
      { id: ++messageId, role: 'user', text: trimmed },
      {
        id: ++messageId,
        role: 'bot',
        text: result.reply,
        ok: result.applied,
        suggestions: result.suggestions,
      },
    ]);
    requestAnimationFrame(() => endRef.current?.scrollIntoView({ block: 'nearest' }));
  };

  return (
    <Panel title="Assistant" defaultOpen={false}>
      <div className="chat" style={{ maxHeight: 260, overflowY: 'auto', marginBottom: 8 }}>
        {messages.length === 0 && (
          <div className="hint">
            Type an instruction in plain English. Everything it does lands on the undo stack.
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role} ${m.role === 'bot' && !m.ok ? 'fail' : ''}`}>
            {m.text}
            {m.suggestions && (
              <div className="chips">
                {m.suggestions.map((s) => (
                  <button key={s} onClick={() => send(s)}>
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <div className="row">
        <input
          className="grow"
          placeholder="Make the vocals louder…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send(input)}
          aria-label="Assistant instruction"
        />
        <button onClick={() => send(input)} disabled={!input.trim()}>
          Send
        </button>
      </div>

      {messages.length === 0 && (
        <div className="chips" style={{ marginTop: 8 }}>
          {EXAMPLES.slice(0, 6).map((e) => (
            <button key={e} onClick={() => send(e)}>
              {e}
            </button>
          ))}
        </div>
      )}
    </Panel>
  );
}
