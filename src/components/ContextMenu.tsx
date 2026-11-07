import clsx from "clsx";
import { ChevronRight, type LucideIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { create } from "zustand";

/** One line of a right-click menu. "-" draws a divider; `items` opens a submenu. */
export type MenuItem =
  | "-"
  | {
      label: string;
      icon?: LucideIcon;
      onClick?: () => void;
      /** A submenu, opened on hover or the right arrow key. */
      items?: MenuEntry[];
      danger?: boolean;
      disabled?: boolean;
      /** Small grey text on the right (a shortcut, a count, the current value). */
      hint?: string;
      /** Shows a tick, for the current choice in a submenu. */
      checked?: boolean;
    };

/** Falsy entries are skipped, so items can be written as `cond && {...}`. */
export type MenuEntry = MenuItem | false | null | undefined | "" | 0;

const useMenu = create<{ at: { x: number; y: number } | null; items: MenuItem[] }>(() => ({ at: null, items: [] }));

const clean = (entries: MenuEntry[]): MenuItem[] => {
  const items = entries.filter(Boolean) as MenuItem[];
  // No divider at either end or twice in a row (left behind by skipped entries).
  return items.filter((it, i) => it !== "-" || (i > 0 && i < items.length - 1 && items[i - 1] !== "-"));
};

/** Opens the menu at the pointer. Use as `onContextMenu={(e) => openMenu(e, [...])}`. */
export function openMenu(e: { preventDefault(): void; stopPropagation(): void; clientX: number; clientY: number }, entries: MenuEntry[]) {
  e.preventDefault();
  e.stopPropagation();
  const items = clean(entries);
  if (items.length) useMenu.setState({ at: { x: e.clientX, y: e.clientY }, items });
}

export const closeMenu = () => useMenu.setState({ at: null, items: [] });

const PAD = 6;

/** Places a panel at (x, y), flipped or nudged so it stays inside the window. `alt` is where it
 * goes when it doesn't fit to the right (a submenu opens on the parent's left side instead). */
function place(el: HTMLElement, x: number, y: number, alt?: number) {
  const r = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = x;
  if (left + r.width > vw - PAD) left = alt !== undefined ? alt - r.width : vw - PAD - r.width;
  let top = y;
  if (top + r.height > vh - PAD) top = Math.max(PAD, vh - PAD - r.height);
  el.style.left = `${Math.max(PAD, left)}px`;
  el.style.top = `${top}px`;
  el.style.visibility = "visible";
}

function Panel({ items, x, y, alt, onBack, depth }: { items: MenuItem[]; x: number; y: number; alt?: number; onBack?: () => void; depth: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hot, setHot] = useState(-1);
  const [sub, setSub] = useState<{ i: number; x: number; y: number; alt: number } | null>(null);
  const timer = useRef<number>(0);

  useLayoutEffect(() => {
    if (ref.current) place(ref.current, x, y, alt);
  }, [x, y, alt]);

  useEffect(() => {
    if (depth === 0) ref.current?.focus();
    return () => window.clearTimeout(timer.current);
  }, [depth]);

  const usable = (i: number) => {
    const it = items[i];
    return it !== "-" && !it.disabled;
  };

  function openSub(i: number, focusIt: boolean) {
    const it = items[i];
    const row = ref.current?.querySelectorAll<HTMLElement>("[data-row]")[i];
    if (it === "-" || !it.items || !row) return setSub(null);
    const r = row.getBoundingClientRect();
    setSub({ i, x: r.right - 2, y: r.top - 5, alt: r.left + 2 });
    if (focusIt) requestAnimationFrame(() => (ref.current?.nextElementSibling as HTMLElement | null)?.focus());
  }

  function run(i: number) {
    const it = items[i];
    if (it === "-" || it.disabled) return;
    if (it.items) return openSub(i, true);
    closeMenu();
    it.onClick?.();
  }

  function onKey(e: React.KeyboardEvent) {
    const step = (dir: 1 | -1) => {
      for (let n = 1; n <= items.length; n++) {
        const i = (hot + dir * n + items.length * 2) % items.length;
        if (usable(i)) return setHot(i);
      }
    };
    const keys: Record<string, () => void> = {
      ArrowDown: () => step(1),
      ArrowUp: () => step(-1),
      ArrowRight: () => hot >= 0 && openSub(hot, true),
      ArrowLeft: () => onBack?.(),
      Enter: () => hot >= 0 && run(hot),
      " ": () => hot >= 0 && run(hot),
      Escape: () => (onBack ? onBack() : closeMenu()),
    };
    const fn = keys[e.key];
    if (!fn) return;
    e.preventDefault();
    e.stopPropagation();
    fn();
  }

  const child = sub && items[sub.i] !== "-" ? (items[sub.i] as Exclude<MenuItem, "-">).items : undefined;

  return (
    <>
      <div
        ref={ref}
        role="menu"
        tabIndex={-1}
        onKeyDown={onKey}
        style={{ visibility: "hidden" }}
        className="fixed z-[80] min-w-[200px] max-w-[340px] py-1 rounded-xl bg-panel border border-line shadow-[0_18px_50px_-12px_rgba(0,0,0,.75)] text-[13px] focus:outline-none"
      >
        {items.map((it, i) =>
          it === "-" ? (
            <div key={i} data-row className="my-1 mx-2 border-t border-line" />
          ) : (
            <button
              key={i}
              data-row
              role="menuitem"
              disabled={it.disabled}
              onMouseEnter={() => {
                setHot(i);
                window.clearTimeout(timer.current);
                timer.current = window.setTimeout(() => openSub(i, false), it.items ? 120 : 200);
              }}
              onClick={() => run(i)}
              className={clsx(
                "w-full h-8 px-2.5 flex items-center gap-2.5 text-left disabled:opacity-40",
                hot === i && !it.disabled && (it.danger ? "bg-bad/15 text-bad" : "bg-raise"),
                it.danger ? "text-bad" : "text-moon",
              )}
            >
              <span className="w-4 grid place-items-center shrink-0 text-dim">
                {it.checked ? <span className="w-1.5 h-1.5 rounded-full bg-gold" /> : it.icon ? <it.icon size={14} className={it.danger ? "text-bad" : undefined} /> : null}
              </span>
              <span className="flex-1 truncate">{it.label}</span>
              {it.hint && <span className="text-[11.5px] text-faint truncate max-w-[120px]">{it.hint}</span>}
              {it.items && <ChevronRight size={13} className="text-faint shrink-0" />}
            </button>
          ),
        )}
      </div>
      {sub && child && (
        <Panel
          key={sub.i}
          items={clean(child)}
          x={sub.x}
          y={sub.y}
          alt={sub.alt}
          depth={depth + 1}
          onBack={() => {
            setSub(null);
            ref.current?.focus();
          }}
        />
      )}
    </>
  );
}

/** Mounted once in App: draws whatever `openMenu` asked for. */
export function ContextMenu() {
  const { at, items } = useMenu();

  useEffect(() => {
    if (!at) return;
    const away = (e: Event) => {
      if (!(e.target as Element | null)?.closest?.("[role=menu]")) closeMenu();
    };
    // Focus moving into an embedded tool's frame never reaches this window as a click.
    const blur = () => closeMenu();
    window.addEventListener("mousedown", away, true);
    window.addEventListener("wheel", away, true);
    window.addEventListener("resize", blur);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("mousedown", away, true);
      window.removeEventListener("wheel", away, true);
      window.removeEventListener("resize", blur);
      window.removeEventListener("blur", blur);
    };
  }, [at]);

  if (!at) return null;
  return <Panel key={`${at.x},${at.y}`} items={items} x={at.x} y={at.y} depth={0} />;
}
