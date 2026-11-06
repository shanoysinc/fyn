import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makePort } from "../test/fixtures";
import { api, resetApi } from "../test/mockIpc";
import { matchesPort, PortsView, WELL_KNOWN } from "./PortsView";

vi.mock("../lib/ipc", async (orig) => (await import("../test/mockIpc")).mockIpcModule(await orig()));

beforeEach(() => resetApi());

const LIST = [
  makePort(),
  makePort({ port: 5173, pid: 99, name: "vite.exe" }),
  makePort({ port: 135, pid: 4, name: "svchost.exe", protected: true, addresses: ["0.0.0.0"] }),
];

describe("matchesPort", () => {
  const node = makePort();

  it("matches a port, an app name, or what usually runs there", () => {
    expect(matchesPort(node, "")).toBe(true);
    expect(matchesPort(node, "3000")).toBe(true);
    expect(matchesPort(node, ":30")).toBe(true);
    expect(matchesPort(node, "node")).toBe(true);
    expect(matchesPort(node, "dev")).toBe(true);
    expect(matchesPort(node, "5173")).toBe(false);
    expect(WELL_KNOWN[5173]).toBe("Vite");
  });
});

describe("Port Killer", () => {
  it("lists the app behind each port and leaves Windows processes alone", async () => {
    api.portsList.mockResolvedValue(LIST);
    render(<PortsView onBack={vi.fn()} />);
    expect(await screen.findByText("node.exe")).toBeInTheDocument();
    expect(screen.getByText("Dev server")).toBeInTheDocument();
    expect(screen.getByText("Vite")).toBeInTheDocument();
    expect(screen.getByText("System")).toBeInTheDocument();
    expect(screen.getByText("3 listening")).toBeInTheDocument();
  });

  it("filters by port", async () => {
    api.portsList.mockResolvedValue(LIST);
    const user = userEvent.setup();
    render(<PortsView onBack={vi.fn()} />);
    await screen.findByText("node.exe");
    await user.type(screen.getByPlaceholderText("Filter by port or app…"), "5173");
    expect(screen.queryByText("node.exe")).not.toBeInTheDocument();
    expect(screen.getByText("vite.exe")).toBeInTheDocument();
  });

  it("stops a process only after a second confirmation", async () => {
    api.portsList.mockResolvedValue(LIST);
    const user = userEvent.setup();
    render(<PortsView onBack={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: /Stop node.exe/ }));
    expect(api.portsKill).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /Confirm Stop/ }));
    expect(api.portsKill).toHaveBeenCalledWith(3000, 4120);
  });
});
