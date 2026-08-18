"use client";

import { useState, type FormEvent, type ReactNode } from "react";

export function AuthForm({
  action,
  children,
  submitLabel,
  pendingLabel,
  disabled = false,
}: {
  action: string;
  children: ReactNode;
  submitLabel: string;
  pendingLabel: string;
  disabled?: boolean;
}) {
  const [submitting, setSubmitting] = useState(false);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    if (!event.currentTarget.checkValidity()) return;
    const password = event.currentTarget.elements.namedItem("password");
    const confirmation =
      event.currentTarget.elements.namedItem("confirmPassword");
    if (
      password instanceof HTMLInputElement &&
      confirmation instanceof HTMLInputElement &&
      password.value !== confirmation.value
    ) {
      confirmation.setCustomValidity("Passwords do not match.");
      confirmation.reportValidity();
      confirmation.focus();
      return;
    }
    setSubmitting(true);
  }

  return (
    <form
      action={action}
      method="post"
      className="auth-form"
      onSubmit={handleSubmit}
      onInput={(event) => {
        if (
          event.target instanceof HTMLInputElement &&
          (event.target.name === "password" ||
            event.target.name === "confirmPassword")
        ) {
          const confirmation =
            event.currentTarget.elements.namedItem("confirmPassword");
          if (confirmation instanceof HTMLInputElement) {
            confirmation.setCustomValidity("");
          }
        }
      }}
      aria-busy={submitting}
    >
      {children}
      <button
        className="auth-submit"
        type="submit"
        disabled={disabled || submitting}
        aria-describedby={disabled ? "auth-unavailable" : undefined}
      >
        {submitting && <span className="auth-spinner" aria-hidden="true" />}
        <span aria-live="polite">
          {submitting ? pendingLabel : submitLabel}
        </span>
      </button>
    </form>
  );
}
