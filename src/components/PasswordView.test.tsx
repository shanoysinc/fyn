import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, resetApi } from "../test/mockIpc";
import { PasswordView } from "./PasswordView";

vi.mock("../lib/ipc", async (orig) => (await import("../test/mockIpc")).mockIpcModule(await orig()));

beforeEach(() => {
  resetApi();
  localStorage.clear();
});

const secret = () => screen.getByTestId("password").textContent ?? "";

describe("Password generator", () => {
  it("copies a password privately, without putting it in clipboard history", async () => {
    const user = userEvent.setup();
    render(<PasswordView onBack={vi.fn()} />);
    await waitFor(() => expect(secret().length).toBeGreaterThanOrEqual(20));
    await user.click(screen.getByRole("button", { name: /Copy Password/ }));
    expect(api.copySecret).toHaveBeenCalledWith(secret(), true);
    expect(await screen.findByText(/clears in a minute/)).toBeInTheDocument();
  });

  it("builds a passphrase from the word list", async () => {
    const user = userEvent.setup();
    render(<PasswordView onBack={vi.fn()} />);
    await user.click(screen.getByRole("tab", { name: "Passphrase" }));
    await waitFor(() => expect(secret().split("-").length).toBeGreaterThanOrEqual(5));
    expect(secret()).toMatch(/^[A-Z]/);
  });
});
