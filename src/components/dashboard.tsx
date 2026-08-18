"use client";

import { createPortal } from "react-dom";
import { useEffect, useRef } from "react";
import { Check, ShieldCheck, X } from "lucide-react";

export function ModalOnly({ type, close }: { type: "auth"; close: () => void }) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const appRoot = document.querySelector<HTMLElement>(".app-shell");
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    appRoot?.setAttribute("inert", "");
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close(); return; }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'));
      if (!focusable.length) { event.preventDefault(); return; }
      const first = focusable[0]; const last = focusable[focusable.length - 1]; const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialogRef.current.contains(active))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (active === last || !dialogRef.current.contains(active))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => { document.removeEventListener("keydown", handleKeyDown); appRoot?.removeAttribute("inert"); document.body.style.overflow = previousOverflow; previouslyFocused?.focus(); };
  }, [close]);
  const content = {
    auth: {
      title: "Authentication is intentionally not live",
      description:
        "Planned MVP authentication uses Auth.js with Google OAuth and securely hashed username/password credentials. This mockup does not collect credentials.",
    },
  }[type];
  return createPortal(<div className="modal-backdrop" role="presentation" onMouseDown={close}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" aria-describedby="modal-description" onMouseDown={(event) => event.stopPropagation()} ref={dialogRef}><button className="modal-close" onClick={close} aria-label="Close" ref={closeButtonRef}><X size={20} /></button><div className="icon-tile"><ShieldCheck size={22} /></div><p className="eyebrow">Honest prototype boundary</p><h2 id="modal-title">{content.title}</h2><p id="modal-description">{content.description}</p><div className="auth-preview"><button disabled>Continue with Google</button><button disabled>Continue with username</button></div><button className="primary-button full" onClick={close}><Check size={17} />Got it</button></section></div>, document.body);
}
