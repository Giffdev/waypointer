// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MapViewToggle } from "./map-view-toggle";

afterEach(cleanup);

describe("MapViewToggle", () => {
  it("supports pointer and arrow-key segmented selection", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(
      <MapViewToggle value="globe" onChange={onChange} />,
    );

    expect(screen.getByRole("button", { name: "3D globe" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Flat map" }));
    expect(onChange).toHaveBeenCalledWith("flat");

    rerender(<MapViewToggle value="flat" onChange={onChange} />);
    screen.getByRole("button", { name: "Flat map" }).focus();
    await user.keyboard("{ArrowLeft}");
    expect(onChange).toHaveBeenLastCalledWith("globe");
  });

  it.each([360, 1280])("keeps both choices available at %ipx", (width) => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    render(<MapViewToggle value="globe" onChange={() => {}} />);

    expect(screen.getByRole("button", { name: "3D globe" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Flat map" })).toBeVisible();
  });
});
