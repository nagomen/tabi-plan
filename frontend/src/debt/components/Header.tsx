import { useEffect, useRef, useState, type MouseEvent } from "react";

export interface NavSection {
  id: string;
  label: string;
  no?: string;
}

interface HeaderProps {
  accessLabel: string;
  /** 本文を表示している間だけ目次を出す。読み込み中・エラー時は空。 */
  sections: NavSection[];
}

function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function Header({ accessLabel, sections }: HeaderProps) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const toggleRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLElement>(null);

  // メニューの外側タップ・Escape で閉じる。
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector("a")?.focus();
    const onClick = (event: globalThis.MouseEvent): void => {
      const target = event.target as Node | null;
      if (target && !menuRef.current?.contains(target) && !toggleRef.current?.contains(target)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setOpen(false);
      toggleRef.current?.focus();
    };
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // いま読んでいるセクションを目次で強調する。
  useEffect(() => {
    if (!sections.length || typeof IntersectionObserver !== "function") return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (visible) setCurrent(visible.target.id);
    }, { rootMargin: "-20% 0px -60% 0px" });
    for (const section of sections) {
      const node = document.getElementById(section.id);
      if (node) observer.observe(node);
    }
    return () => observer.disconnect();
  }, [sections]);

  const jump = (event: MouseEvent<HTMLAnchorElement>, id: string): void => {
    // ハッシュを書き換えると共有トークン（#token=…）が消え、hashchange で再読み込みになる。
    event.preventDefault();
    setOpen(false);
    const target = document.getElementById(id);
    if (!target) return;
    target.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
    target.setAttribute("tabindex", "-1");
    target.focus({ preventScroll: true });
  };

  return (
    <header className="dn-header">
      <a className="dn-brand" href="../" aria-label="Tabi Plan トップへ">
        <span className="dn-brand-mark" aria-hidden="true">返</span>
        <span><strong>返す日</strong><small>PAYBACK NOTE</small></span>
      </a>
      <div className="dn-header-actions">
        <span className="dn-readonly">{accessLabel}</span>
        {sections.length > 0 && (
          <button
            ref={toggleRef}
            className="dn-menu-button"
            type="button"
            aria-expanded={open}
            aria-controls="dn-menu"
            aria-label={open ? "メニューを閉じる" : "メニューを開く"}
            onClick={() => setOpen((value) => !value)}
          >
            <span className="dn-menu-icon" aria-hidden="true"><i></i><i></i><i></i></span>
            <span className="dn-menu-label">メニュー</span>
          </button>
        )}
      </div>
      <nav ref={menuRef} className="dn-menu" id="dn-menu" aria-label="ページ内の目次" hidden={!open}>
        <ol>
          {sections.map((section) => (
            <li key={section.id}>
              <a href={`#${section.id}`} aria-current={current === section.id ? "location" : undefined} onClick={(event) => jump(event, section.id)}>
                {/* 番号の無い項目も空の番号欄を置き、見出しの頭をそろえる。 */}
                <span className="dn-menu-no">{section.no || ""}</span>
                {section.label}
              </a>
            </li>
          ))}
        </ol>
      </nav>
    </header>
  );
}
