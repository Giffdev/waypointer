// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { AuthForm } from "./auth-form";
import { PasswordField } from "./password-field";

afterEach(cleanup);

function RegistrationForm({ disabled = false }: { disabled?: boolean }) {
  return (
    <>
      <p id="auth-unavailable">Account creation is unavailable.</p>
      <AuthForm
        action="/api/auth/register"
        submitLabel="Create account"
        pendingLabel="Creating account…"
        disabled={disabled}
      >
        <label htmlFor="email">
          Email address
          <input id="email" name="email" type="email" required />
        </label>
        <PasswordField
          id="password"
          name="password"
          label="Password"
          autoComplete="new-password"
          minLength={12}
        />
        <PasswordField
          id="confirm-password"
          name="confirmPassword"
          label="Confirm password"
          autoComplete="new-password"
          minLength={12}
        />
      </AuthForm>
    </>
  );
}

describe("AuthForm", () => {
  it("announces a valid submission, disables repeats, and preserves the target action", async () => {
    const user = userEvent.setup();
    render(<RegistrationForm />);

    await user.type(
      screen.getByLabelText("Email address"),
      "synthetic.pilot@example.test",
    );
    await user.type(
      screen.getByLabelText("Password", { exact: true }),
      "synthetic passphrase",
    );
    await user.type(
      screen.getByLabelText("Confirm password", { exact: true }),
      "synthetic passphrase",
    );
    fireEvent.submit(
      screen.getByRole("button", { name: "Create account" }).closest("form")!,
    );

    const pendingButton = screen.getByRole("button", {
      name: "Creating account…",
    });
    expect(pendingButton.closest("form")).toHaveAttribute(
      "action",
      "/api/auth/register",
    );
    expect(pendingButton.closest("form")).toHaveAttribute("aria-busy", "true");
    expect(pendingButton).toBeDisabled();
  });

  it("focuses a mismatched confirmation without entering a loading state", async () => {
    const user = userEvent.setup();
    render(<RegistrationForm />);

    await user.type(
      screen.getByLabelText("Email address"),
      "synthetic.pilot@example.test",
    );
    await user.type(
      screen.getByLabelText("Password", { exact: true }),
      "synthetic passphrase",
    );
    await user.type(
      screen.getByLabelText("Confirm password", { exact: true }),
      "different passphrase",
    );
    fireEvent.submit(
      screen.getByRole("button", { name: "Create account" }).closest("form")!,
    );

    expect(document.activeElement).toBe(
      screen.getByLabelText("Confirm password", { exact: true }),
    );
    const submit = screen.getByRole("button", { name: "Create account" });
    expect(submit).toBeEnabled();
    expect(submit.closest("form")).toHaveAttribute("aria-busy", "false");
  });

  it("connects an unavailable submit button to its explanation", () => {
    render(<RegistrationForm disabled />);

    expect(screen.getByRole("button", { name: "Create account" }))
      .toHaveAttribute("aria-describedby", "auth-unavailable");
    expect(screen.getByText("Account creation is unavailable.")).toBeVisible();
  });
});

describe("PasswordField", () => {
  it("toggles visibility with an accessible pressed state and keeps focus", async () => {
    const user = userEvent.setup();
    render(
      <PasswordField
        id="password"
        name="password"
        label="Password"
        autoComplete="current-password"
      />,
    );

    const input = screen.getByLabelText("Password", { exact: true });
    const toggle = screen.getByRole("button", { name: "Show password" });
    expect(input).toHaveAttribute("type", "password");
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    await user.click(toggle);

    expect(input).toHaveAttribute("type", "text");
    const hide = screen.getByRole("button", { name: "Hide password" });
    expect(hide).toHaveAttribute("aria-pressed", "true");
    expect(document.activeElement).toBe(hide);
  });
});
