import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { Toggle } from "@/components/settings/Toggle";

describe("Toggle component", () => {
  it("renders with role=switch and reflects unchecked state", () => {
    const handleChange = vi.fn();
    render(<Toggle checked={false} onChange={handleChange} ariaLabel="Test Toggle" />);

    const button = screen.getByRole("switch", { name: "Test Toggle" });
    expect(button).toBeInTheDocument();
    expect(button).toHaveAttribute("aria-checked", "false");
    expect(button.className).toContain("bg-[var(--border)]");

    const thumb = button.querySelector("span");
    expect(thumb).toBeInTheDocument();
    expect(thumb?.className).toContain("translate-x-0");
    expect(thumb?.className).toContain("bg-[var(--background)]");

    fireEvent.click(button);
    expect(handleChange).toHaveBeenCalledWith(true);
  });

  it("reflects checked state with correct track and thumb classes", () => {
    const handleChange = vi.fn();
    render(<Toggle checked={true} onChange={handleChange} ariaLabel="Test Toggle" />);

    const button = screen.getByRole("switch", { name: "Test Toggle" });
    expect(button).toHaveAttribute("aria-checked", "true");
    expect(button.className).toContain("bg-[var(--foreground)]");

    const thumb = button.querySelector("span");
    expect(thumb?.className).toContain("translate-x-4");
    expect(thumb?.className).toContain("bg-[var(--background)]");

    fireEvent.click(button);
    expect(handleChange).toHaveBeenCalledWith(false);
  });

  it("does not call onChange when disabled", () => {
    const handleChange = vi.fn();
    render(<Toggle checked={false} disabled={true} onChange={handleChange} ariaLabel="Disabled Toggle" />);

    const button = screen.getByRole("switch", { name: "Disabled Toggle" });
    expect(button).toBeDisabled();
    expect(button.className).toContain("disabled:cursor-not-allowed");

    fireEvent.click(button);
    expect(handleChange).not.toHaveBeenCalled();
  });

  it("supports size=sm with proportional track and translation", () => {
    const handleChange = vi.fn();
    const { rerender } = render(<Toggle checked={false} size="sm" onChange={handleChange} ariaLabel="Small Toggle" />);

    let button = screen.getByRole("switch", { name: "Small Toggle" });
    expect(button.className).toContain("h-4 w-7");
    let thumb = button.querySelector("span");
    expect(thumb?.className).toContain("h-3 w-3");
    expect(thumb?.className).toContain("translate-x-0");

    rerender(<Toggle checked={true} size="sm" onChange={handleChange} ariaLabel="Small Toggle" />);
    button = screen.getByRole("switch", { name: "Small Toggle" });
    thumb = button.querySelector("span");
    expect(thumb?.className).toContain("translate-x-3");
  });
});
