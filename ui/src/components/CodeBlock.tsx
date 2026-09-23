import { useState } from 'react';
import { Icon } from './Icon';

/** A titled snippet with a copy button. */
export function CodeBlock({ title, code }: { title: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  };
  return (
    <div className="codeblock">
      <div className="codeblock-h">
        <span>{title}</span>
        <button className="codeblock-copy" onClick={copy} aria-label={`Copy ${title}`}>
          <Icon name={copied ? 'check' : 'list'} size={13} /> {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>{code}</pre>
    </div>
  );
}
