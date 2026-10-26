import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

describe("Modal Accessibility (Modal.js)", () => {
  it("contains WAI-ARIA role='dialog' and aria-modal='true'", () => {
    const modalPath = path.resolve(process.cwd(), "src/shared/components/Modal.js");
    const content = fs.readFileSync(modalPath, "utf-8");

    expect(content).toContain('role="dialog"');
    expect(content).toContain('aria-modal="true"');
  });

  it("links modal title to aria-labelledby and sets id='modal-title'", () => {
    const modalPath = path.resolve(process.cwd(), "src/shared/components/Modal.js");
    const content = fs.readFileSync(modalPath, "utf-8");

    expect(content).toContain('aria-labelledby={title ? "modal-title" : undefined}');
    expect(content).toContain('id="modal-title"');
  });

  it("sets aria-hidden='true' on the overlay backdrop", () => {
    const modalPath = path.resolve(process.cwd(), "src/shared/components/Modal.js");
    const content = fs.readFileSync(modalPath, "utf-8");

    expect(content).toContain('aria-hidden="true"');
  });
});
