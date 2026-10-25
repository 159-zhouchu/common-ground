import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { quoteLines, inlineDiff } from '@/lib/text';

export function Sheet({
  title,
  open,
  onClose,
  wide,
  children,
  returnFocus,
  focusKey,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  wide?: boolean;
  children: ReactNode;
  returnFocus: HTMLElement | null;
  focusKey?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    backdropStart = useRef(false);
  function requestClose() {
    if (ref.current?.dispatchEvent(new Event('cg-before-close', { cancelable: true }))) onClose();
  }
  function outside(e: {
    clientX: number;
    clientY: number;
    currentTarget: HTMLDialogElement;
    target: EventTarget;
  }) {
    const r = e.currentTarget.getBoundingClientRect();
    return (
      e.target === e.currentTarget &&
      (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)
    );
  }
  useEffect(() => {
    if (!open) return;
    const opener = returnFocus ?? (document.activeElement as HTMLElement | null);
    const menu = opener?.closest('details');
    const fallback = menu?.querySelector('summary') as HTMLElement | null;
    const y = window.scrollY,
      previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.showModal();
    return () => {
      ref.current?.close();
      document.body.style.overflow = previous;
      const target = menu && !menu.open ? fallback : opener;
      if (target?.isConnected) target.focus({ preventScroll: true });
      window.scrollTo({ top: y, behavior: 'instant' });
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    // A different drawer can reuse the same open dialog.
    ref.current?.querySelector<HTMLButtonElement>('header button')?.focus({ preventScroll: true });
  }, [open, title, focusKey]);
  return (
    <dialog
      className={'cg-sheet ' + (wide ? 'wide' : '')}
      ref={ref}
      aria-labelledby="cg-sheet-title"
      onCancel={(e) => {
        e.preventDefault();
        requestClose();
      }}
      onPointerDown={(e) => {
        backdropStart.current = outside(e);
      }}
      onPointerCancel={() => {
        backdropStart.current = false;
      }}
      onClick={(e) => {
        const shouldClose = backdropStart.current && outside(e);
        backdropStart.current = false;
        if (shouldClose) requestClose();
      }}
    >
      <header>
        <h2 id="cg-sheet-title">{title}</h2>
        <button className="cg-icon" aria-label="关闭面板" onClick={requestClose}>
          <X size={20} />
        </button>
      </header>
      <div className="cg-sheet-content">{children}</div>
    </dialog>
  );
}
export function Highlight({ text, quote }: { text: string; quote?: string }) {
  const index = quote ? text.indexOf(quote) : -1;
  return index < 0 ? (
    <>{text}</>
  ) : (
    <>
      {text.slice(0, index)}
      <mark>{quote}</mark>
      {text.slice(index + quote!.length)}
    </>
  );
}

export function SourceText({ text, quote }: { text: string; quote?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const id = requestAnimationFrame(() =>
      ref.current?.querySelector('mark')?.scrollIntoView({ block: 'center', behavior: 'instant' }),
    );
    return () => cancelAnimationFrame(id);
  }, [text, quote]);
  return (
    <div className="cg-source-text" ref={ref}>
      {quoteLines(text, quote).map((line, i) => (
        <p key={i}>
          <span>{i + 1}</span>
          <span>
            {line.before}
            {line.match && <mark>{line.match}</mark>}
            {line.after}
          </span>
        </p>
      ))}
    </div>
  );
}
export function Diff({ before, after }: { before: string; after: string }) {
  const d = inlineDiff(before, after);
  return (
    <div className="cg-diff">
      <section>
        <h4>原文</h4>
        <p>
          {before ? (
            <>
              {d.prefix}
              {d.removed && <del>{d.removed}</del>}
              {d.suffix}
            </>
          ) : (
            '没有可定位的原文片段。'
          )}
        </p>
      </section>
      <section>
        <h4>建议修改</h4>
        <p>
          {after ? (
            <>
              {d.prefix}
              {d.added && <ins>{d.added}</ins>}
              {d.suffix}
            </>
          ) : (
            <em>删除上述原文片段</em>
          )}
        </p>
      </section>
    </div>
  );
}
