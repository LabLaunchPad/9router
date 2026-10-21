## 2026-10-21 - Accessible Modal Dialog ARIA Attributes
**Learning:** Reusable root modal components (`Modal.js`) often lack explicit `role="dialog"`, `aria-modal="true"`, and `aria-labelledby` connections. Without these standard WAI-ARIA attributes, assistive technologies like screen readers fail to announce the pop-up title or identify the overlay as an isolated dialog context.
**Action:** Always ensure base Modal dialog components assign `role="dialog"`, `aria-modal="true"`, `aria-labelledby="modal-title"`, and set `id="modal-title"` on the header title element.
