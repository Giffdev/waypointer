import Link from "next/link";
import type { ReactNode } from "react";

export function AuthShell({
  eyebrow,
  title,
  description,
  children,
  footer,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <main className="app-shell auth-page" id="main-content">
      <div className="auth-route-line" aria-hidden="true" />
      <section className="auth-layout" aria-labelledby="auth-title">
        <Link className="auth-brand" href="/" aria-label="Waypointer home">
          <span className="brand-mark" aria-hidden="true">✈</span>
          <span>Waypointer</span>
        </Link>
        <div className="auth-card">
          <header className="auth-header">
            <p className="eyebrow">{eyebrow}</p>
            <h1 id="auth-title">{title}</h1>
            <p>{description}</p>
          </header>
          <div className="auth-body">{children}</div>
          <footer className="auth-footer">{footer}</footer>
        </div>
        <p className="auth-privacy">
          Your flight history stays private to your account.
        </p>
      </section>
    </main>
  );
}
