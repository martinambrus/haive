---
name: haive-modals-close-on-escape
description: "Every modal in Haive's web UI must close on Escape — use the shared Dialog component rather than a hand-rolled overlay"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 34272203-2b48-471f-ba4b-237577519e5a
  modified: 2026-09-05T09:46:06.498Z
---

The user's standing rule, given 2026-09-05: **all modals should be closeable by pressing ESC**.
Applies to every modal in `packages/web`, not just the one under discussion — treat a new modal
without Escape handling as incomplete.

The mechanism already exists: `packages/web/src/components/dialog.tsx` owns the key handling,
the portal, the backdrop and a `data-haive-dialog` marker so page-level Escape handlers can
tell a dialog is on top. Reach for it rather than writing `fixed inset-0` by hand — a
hand-rolled overlay is exactly how `link-origin-dialog.tsx` ended up with no Escape at all.

When a modal genuinely cannot use the shared `Dialog` (e.g. `cli-auth-banner-modal.tsx`, which
runs a live WebSocket sign-in and must not close on a backdrop click), add the listener
directly and route it through the SAME close path the modal's own close button uses:

```tsx
useEffect(() => {
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation(); // closes synchronously; without this the page behind reacts too
    handleClose();
  };
  document.addEventListener('keydown', onKey);
  return () => document.removeEventListener('keydown', onKey);
}, [handleClose]);
```

**Why:** Escape is the universal dismiss gesture, and a modal that ignores it reads as stuck.
The `stopPropagation` is not incidental — React flushes the close synchronously on a discrete
event, so the portal is gone before a window-level handler looks for the marker, and one
Escape would close the dialog AND whatever was behind it.

**How to apply:** when adding or touching a modal, verify Escape closes it in the browser (per
[[chrome-mcp-browser-check-gotchas]]) and that the page behind is unaffected. Surveyed
2026-09-05: every other modal already handled it, via the shared `Dialog` (credential-modal,
usage-oauth-modal, code-preview-dialog) or its own listener (commit-diff-viewer,
screenshot-gallery, BrowserVncPanel, markdown-view).
