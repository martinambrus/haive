# Human active time

The task page records attention while a live task is parked for user input. The waiting step
is selected with `isAwaitingFormInput`, which requires both `waiting_form` and a non-null
`waitingStartedAt`. Submission clears the timestamp before the worker moves the status, so
that gap does not count. Terminal and dead tasks do not count.

`packages/web/src/lib/active-time/` owns the reusable clock, browser hook, attention lease and
visible-word estimate. The task-page wrapper provides the step row id as the destination and
content key, the stored `userActiveMs` as its base, and `postUserActive` as its sink. This is
attention estimation, not proof that someone read the text.

## Presence and allowances

`ActivityClock` uses monotonic timestamps. A sample counts only the overlap between its
interval and the current presence deadline; a late tick cannot count beyond that deadline.
Trusted input starts a new epoch. Input bursts retain unsampled pieces of elapsed time for
the next tick, without publishing display state or accessing storage on each input.

Reading allowance is visible words at 150 words per minute, clamped between 60 seconds and
5 minutes. The hook measures once after input settles for 2 seconds. The measurement is
anchored to that input epoch, accepted only once, and ignored if its epoch changed or presence
has already expired. A delayed measurement cannot revive an idle timer.

Pending work and editor iframe focus can extend a still-present epoch to 15 minutes. The
iframe window is measured from the input epoch, not from iframe entry. Entry cannot revive an
idle timer, repeated ticks do not renew it, and exit restores the epoch's reading deadline.
The task-page wrapper currently passes `pending: false`.

A content-key change may restart presence only if real input was within the preceding
15 minutes. Content changes never replace the remembered real-input timestamp. Polling with
an unchanged key does not renew presence.

There is no 5-second sleep or stall guard. Gaps, including sleep when the platform's monotonic
clock advances during suspend, count only through the epoch's allowance: at most 5 minutes for
reading, or 15 minutes with an extended mode. A new input after expiry does not count the
absence. Browser and platform event ordering and suspend-clock behavior require browser checks.

## Browser activity, sampling and delivery

Counting requires a visible, focused document. Trusted keydown, pointerdown, changed-coordinate
pointermove, wheel and touchmove renew presence. Scroll renews only during pointer dragging.
Capture listeners observe input even when a child stops propagation. Synthetic input and
programmatic element focus do not renew presence. A trusted window-focus return establishes
a fresh input epoch. Iframe focus is handled as a mode transition rather than repeated input.

Disabled consumers register no listeners and run no interval. Enabled consumers sample each
second. Capture input only marks the clock and reschedules measurement; it does not sample,
publish or touch the lease. Display state changes only when the sink or shown total changes,
so an idle timer does not repeatedly render its parent. Lease touches are bounded to one per
tick period, including activation and focus acquisition.

Blur, visibility loss, pagehide and destination changes finish and flush the old interval.
Unmount collects the final partial tick and flushes through the old sink without publishing
display state. A 60-second safety flush sends deltas in chunks no larger than 60,000 ms.
Deltas are discarded before dispatch; thrown or rejected requests are never retried because
an additive request may already have been accepted. The task API request uses keepalive.

## Attention lease

The profile-local key is `haive:active-time:lease`, with a 5-second TTL and a bounded, validated
owner record. Only a continuous holder counts a sampled interval; acquisition establishes a
baseline, so takeover does not backfill another tab's interval. Blur, hiding and cleanup
release an owned lease. A read-modify-write race can overlap around one sample.

Owner identity uses a local timestamp, sequence and random suffix, without `crypto.randomUUID`,
so plain HTTP LAN installations work. If accessing localStorage, reading it or writing it
throws, the lease fails open: a visible, focused tab counts independently. This deliberately
prefers per-tab attention to silently losing all human time when site data is blocked or full.
Storage availability is not an authorization boundary.

## Visible-word estimator

`visibleWords` returns only a number; it neither stores nor logs page text. It intersects the
viewport with inherited overflow clips, rejects hidden or empty-clip subtrees before spending
content budgets, and skips offscreen wrappers while retaining potentially visible positioned
descendants. Range rectangle areas prorate partly visible text, and hit testing excludes
covered text. Zero-sized wrappers may still have visible children.

Production budgets are 2,000 accepted nodes, 48,000 accepted text characters, 2,048 range
rectangles, and 2,048 characters per range chunk. A separate hard budget of 50,000 inspected
nodes also bounds rejected siblings; a rejected subtree is not traversed. All limits are
injectable for unit controls. Overflow or unavailable geometry returns null. The hook then
uses zero estimated words, giving the 60-second minimum reading allowance rather than an
unbounded or automatically larger allowance.

The estimate is approximate: range chunk boundaries may split a word, overflow clipping can
misjudge positioned descendants that escape an ancestor, and hit testing can exclude text
with pointer-events disabled. Real layout cost and overflow frequency need browser measurement;
jsdom geometry controls verify logic only. Measurement runs after settled input, never on the
one-second sampling interval.
