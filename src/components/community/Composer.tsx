import { useState } from 'react';
import { Markdown } from './Markdown';

interface ComposerProps {
  initial?: string;
  submitLabel: string;
  placeholder?: string;
  onSubmit: (bodyMd: string) => void | Promise<void>;
  onCancel?: () => void;
  disabled?: boolean;
  minLength?: number;
}

export function Composer({
  initial = '',
  submitLabel,
  placeholder = 'Write your reply… Markdown is supported.',
  onSubmit,
  onCancel,
  disabled = false,
  minLength = 2,
}: ComposerProps) {
  const [text, setText] = useState(initial);
  const [tab, setTab] = useState<'write' | 'preview'>('write');

  const canSubmit = text.trim().length >= minLength && !disabled;

  return (
    <div className="border border-sand rounded-lg overflow-hidden bg-white">
      <div className="flex items-center gap-1 border-b border-sand bg-cream/40 px-2 py-1">
        <button
          type="button"
          onClick={() => setTab('write')}
          className={`px-3 py-1 rounded-md text-xs font-semibold transition-colors ${tab === 'write' ? 'bg-white text-dark-brown' : 'text-warm-gray hover:text-dark-brown'}`}
        >
          Write
        </button>
        <button
          type="button"
          onClick={() => setTab('preview')}
          className={`px-3 py-1 rounded-md text-xs font-semibold transition-colors ${tab === 'preview' ? 'bg-white text-dark-brown' : 'text-warm-gray hover:text-dark-brown'}`}
        >
          Preview
        </button>
        <div className="flex-1" />
        <span className="text-[10px] text-warm-gray">**bold** *italic* `code` &gt; quote</span>
      </div>
      {tab === 'write' ? (
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          className="w-full min-h-[120px] p-3 text-sm bg-white outline-none resize-y focus:bg-cream/20 disabled:opacity-60 font-mono"
        />
      ) : (
        <div className="p-3 min-h-[120px] text-sm text-dark-brown">
          {text.trim() ? <Markdown>{text}</Markdown> : <p className="text-warm-gray italic">Nothing to preview yet.</p>}
        </div>
      )}
      <div className="flex items-center gap-2 px-3 py-2 border-t border-sand bg-cream/20">
        <span className="text-[11px] text-warm-gray">{text.length}/64000</span>
        <div className="flex-1" />
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={disabled}
            className="px-3 py-1.5 rounded-md text-xs font-heading font-bold bg-sand text-brown hover:bg-coral-light hover:text-coral transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
        )}
        <button
          type="button"
          onClick={() => canSubmit && onSubmit(text.trim())}
          disabled={!canSubmit}
          className="px-3 py-1.5 rounded-md text-xs font-heading font-bold bg-coral text-white hover:bg-[#d4603a] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}
