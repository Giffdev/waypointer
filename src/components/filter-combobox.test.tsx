// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FilterCombobox } from "./filter-combobox";

const options = [
  { value: "Airbus A320", available: true },
  { value: "Cessna 172", available: true },
  { value: "Unavailable Jet", available: false },
];

afterEach(cleanup);

function Harness({ onChange = vi.fn() }: { onChange?: (value: string) => void }) {
  const [value, setValue] = useState("all");
  return (
    <FilterCombobox
      label="Aircraft type / model"
      ariaLabel="Filter flights by aircraft type or model"
      searchLabel="aircraft search"
      allLabel="All available aircraft"
      value={value}
      options={options}
      onChange={(nextValue) => {
        setValue(nextValue);
        onChange(nextValue);
      }}
    />
  );
}

function ControlledHarness({
  value,
  options: controlledOptions = options,
  onChange = vi.fn(),
}: {
  value: string;
  options?: typeof options;
  onChange?: (value: string) => void;
}) {
  return (
    <FilterCombobox
      label="Aircraft type / model"
      ariaLabel="Filter flights by aircraft type or model"
      searchLabel="aircraft search"
      allLabel="All available aircraft"
      value={value}
      options={controlledOptions}
      onChange={onChange}
    />
  );
}

describe("FilterCombobox", () => {
  it("searches safe option labels and selects with the keyboard", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const input = screen.getByRole("combobox", {
      name: "Filter flights by aircraft type or model",
    });

    await user.click(input);
    expect(input).toHaveAttribute("aria-expanded", "true");
    await user.clear(input);
    await user.type(input, "cess");
    expect(screen.getByRole("option", { name: "Cessna 172" })).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "Airbus A320" }),
    ).not.toBeInTheDocument();
    await user.keyboard("{Enter}");

    expect(onChange).toHaveBeenCalledWith("Cessna 172");
    expect(input).toHaveValue("Cessna 172");
    expect(input).toHaveAttribute("aria-expanded", "false");
  });

  it("reports no results, clears search, and rejects invalid free text", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <>
        <Harness onChange={onChange} />
        <button type="button">After filter</button>
      </>,
    );
    const input = screen.getByRole("combobox", {
      name: "Filter flights by aircraft type or model",
    });

    await user.click(input);
    await user.clear(input);
    await user.type(input, "private-secret");
    expect(screen.getByRole("status")).toHaveTextContent(
      "No options match “private-secret”",
    );
    await user.click(
      screen.getByRole("button", { name: "Clear aircraft search" }),
    );
    expect(input).toHaveValue("");
    expect(screen.getByRole("option", { name: "Airbus A320" })).toBeInTheDocument();

    await user.type(input, "not-an-option");
    await user.tab();
    await waitFor(() => expect(input).toHaveValue("All available aircraft"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not allow unavailable options to become URL filter values", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const input = screen.getByRole("combobox", {
      name: "Filter flights by aircraft type or model",
    });

    await user.click(input);
    const unavailable = screen.getByRole("option", {
      name: "Unavailable Jet · unavailable",
    });
    expect(unavailable).toHaveAttribute("aria-disabled", "true");
    await user.click(unavailable);
    expect(onChange).not.toHaveBeenCalled();
    expect(input).toHaveValue("All available aircraft");
  });

  it("follows controlled URL and back-forward state changes", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const props = {
      label: "Aircraft type / model",
      ariaLabel: "Filter flights by aircraft type or model",
      searchLabel: "aircraft search",
      allLabel: "All available aircraft",
      options,
      onChange,
    };
    const { rerender } = render(
      <FilterCombobox {...props} value="all" />,
    );
    const input = screen.getByRole("combobox", {
      name: "Filter flights by aircraft type or model",
    });
    expect(input).toHaveValue("All available aircraft");

    await user.click(input);
    await user.clear(input);
    await user.type(input, "Cessna 172");
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith("Cessna 172");

    rerender(<FilterCombobox {...props} value="Cessna 172" />);
    expect(input).toHaveValue("Cessna 172");

    rerender(<FilterCombobox {...props} value="all" />);
    expect(input).toHaveValue("All available aircraft");
  });

  it("resolves lowercase controlled values to the canonical selected option", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ControlledHarness value="cessna 172" onChange={onChange} />);
    const input = screen.getByRole("combobox", {
      name: "Filter flights by aircraft type or model",
    });

    expect(input).toHaveValue("Cessna 172");
    await user.click(input);
    const selected = screen.getByRole("option", { name: "Cessna 172" });
    expect(selected).toHaveAttribute("aria-selected", "true");
    expect(input).toHaveAttribute("aria-activedescendant", selected.id);

    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith("Cessna 172");
    expect(input).toHaveValue("Cessna 172");
  });

  it("preserves an unknown controlled value as selected and unavailable", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ControlledHarness value="Legacy Experimental" onChange={onChange} />);
    const input = screen.getByRole("combobox", {
      name: "Filter flights by aircraft type or model",
    });

    expect(input).toHaveValue("Legacy Experimental");
    await user.click(input);
    const selected = screen.getByRole("option", {
      name: "Legacy Experimental · unavailable",
    });
    expect(selected).toHaveAttribute("aria-selected", "true");
    expect(selected).not.toHaveAttribute("aria-disabled");
    expect(input).toHaveAttribute("aria-activedescendant", selected.id);

    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith("Legacy Experimental");
    expect(input).toHaveValue("Legacy Experimental");
  });

  it("opens from the full pointer target and clears a selected filter", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = render(
      <ControlledHarness value="Cessna 172" onChange={onChange} />,
    );
    const input = screen.getByRole("combobox", {
      name: "Filter flights by aircraft type or model",
    });

    await user.click(
      container.querySelector(".metadata-combobox-control > svg")!,
    );
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute("aria-expanded", "true");

    await user.click(
      screen.getByRole("button", {
        name: "Clear aircraft type / model filter",
      }),
    );
    expect(onChange).toHaveBeenCalledWith("all");
  });
});
