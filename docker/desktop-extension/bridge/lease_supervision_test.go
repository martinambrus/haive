package main

import (
	"context"
	"errors"
	"io"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestLeaseFailureThresholdAndContinuedRenewal(t *testing.T) {
	b := fixture(t)
	ticks := fakeTicker(&b)
	var clock atomic.Int64
	b.lockCfg.now = func() time.Time { return time.Unix(0, clock.Load()) }
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	b.leaseFailed = cancel
	var fail atomic.Bool
	var writes atomic.Int32
	write := b.lockCfg.resolved().write
	b.lockCfg.write = func(f *os.File, data []byte) error {
		if fail.Load() {
			return errors.New("injected heartbeat failure")
		}
		err := write(f, data)
		writes.Add(1)
		return err
	}
	lease, err := b.acquireStackLock(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.releaseLock()
	<-ticks.period
	// The next unbuffered send proves the preceding beat and decision completed.
	tick := func() { ticks.ticks <- time.Time{}; ticks.ticks <- time.Time{} }
	fail.Store(true)
	clock.Store(int64(5 * time.Second))
	tick()
	if ctx.Err() != nil {
		t.Fatal("one transient failure cancelled the operation")
	}
	clock.Store(int64(30*time.Second - time.Nanosecond))
	tick()
	if ctx.Err() != nil {
		t.Fatal("cancelled before half the stale window")
	}
	clock.Store(int64(30 * time.Second))
	ticks.ticks <- time.Time{}
	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("sustained failure did not cancel at stale/2")
	}
	fail.Store(false)
	tick()
	if writes.Load() < 2 {
		t.Fatal("cancellation stopped renewal before release")
	}
}

func TestLeaseLostCancelsImmediately(t *testing.T) {
	b := fixture(t)
	ticks := fakeTicker(&b)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	b.leaseFailed = cancel
	lease, err := b.acquireStackLock(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.releaseLock()
	<-ticks.period
	if err := os.WriteFile(lease.path, rawRecord("another-holder", "updater", 1), 0644); err != nil {
		t.Fatal(err)
	}
	ticks.ticks <- time.Time{}
	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("proven loss did not cancel immediately")
	}
}

func TestLeaseLossCauseSurvivesOperationMapping(t *testing.T) {
	b := fixture(t)
	timers := newTimerSet()
	b.lockCfg.newTicker = timers.newTicker
	base := b.run
	b.run = func(ctx context.Context, exe string, args []string, dir string, log io.Writer) (string, error) {
		if log != nil {
			if err := os.WriteFile(lockPathOf(b), rawRecord("another-holder", "updater", 1), 0644); err != nil {
				return "", err
			}
			<-timers.created
			<-timers.created
			timers.tickAll()
			<-ctx.Done()
			return "", ctx.Err()
		}
		return base(ctx, exe, args, dir, log)
	}
	_, err := b.handle(context.Background(), stopReq())
	if !errors.Is(err, errLeaseLost) || !strings.Contains(err.Error(), "lease was lost") {
		t.Fatalf("lease cause hidden: %v", err)
	}
}

func TestLeaseBlockedIOStillCancels(t *testing.T) {
	b := fixture(t)
	ticks := fakeTicker(&b)
	safety := make(chan time.Time)
	safetyReady := make(chan struct{})
	b.lockCfg.newSafetyTicker = func(time.Duration) (<-chan time.Time, func()) {
		close(safetyReady)
		return safety, func() {}
	}
	var clock atomic.Int64
	b.lockCfg.now = func() time.Time { return time.Unix(0, clock.Load()) }
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	b.leaseFailed = cancel
	blocked, unblock := make(chan struct{}), make(chan struct{})
	var fail atomic.Bool
	write := b.lockCfg.resolved().write
	b.lockCfg.write = func(f *os.File, data []byte) error {
		if fail.Load() {
			close(blocked)
			<-unblock
		}
		return write(f, data)
	}
	lease, err := b.acquireStackLock(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.releaseLock()
	defer close(unblock)
	<-ticks.period
	<-safetyReady
	fail.Store(true)
	ticks.ticks <- time.Time{}
	<-blocked
	clock.Store(int64(30*time.Second - time.Nanosecond))
	safety <- time.Time{}
	safety <- time.Time{} // Previous check completed independently of the blocked I/O.
	if ctx.Err() != nil {
		t.Fatal("cancelled before stale/2")
	}
	clock.Store(int64(30 * time.Second))
	safety <- time.Time{}
	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("blocked beat suppressed stale/2 cancellation")
	}
}
