// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ModalOnly } from "./dashboard";

afterEach(cleanup);

function ModalHarness() {
  const [open, setOpen] = useState(false);
  return (
    <main className="app-shell">
      <button onClick={() => setOpen(true)}>Open dialog</button>
      {open && (
        <ModalOnly
          type="auth"
          close={() => setOpen(false)}
        />
      )}
    </main>
  );
}

describe("dashboard dialogs", () => {
  it("moves focus into the dialog and restores it to the invoking control", async () => {
    const user = userEvent.setup();
    render(<ModalHarness />);
    const trigger = screen.getByRole("button", { name: "Open dialog" });
    await user.click(trigger);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: /got it/i }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("closes on Escape and prevents interaction with the background", async () => {
    const user = userEvent.setup();
    const { container } = render(<ModalHarness />);
    await user.click(screen.getByRole("button", { name: "Open dialog" }));
    expect(container.querySelector(".app-shell")).toHaveAttribute("inert");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(container.querySelector(".app-shell")).not.toHaveAttribute("inert");
  });

  it("traps Tab focus within the active dialog", async () => {
    const user = userEvent.setup();
    render(<ModalHarness />);
    await user.click(screen.getByRole("button", { name: "Open dialog" }));
    const close = screen.getByRole("button", { name: "Close" });
    const gotIt = screen.getByRole("button", { name: /got it/i });
    gotIt.focus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(gotIt).toHaveFocus();
  });
});
