package main

import (
	"context"
	"errors"
	"os"
	"sync/atomic"
	"testing"
	"time"
)

func TestLeaseFailureCancelsCommandButKeepsBeating(t *testing.T) {
	b := fixture(t)
	ticks := fakeTicker(&b)
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
	fail.Store(true)
	ticks.ticks <- time.Time{}
	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("failed beat did not cancel command")
	}
	fail.Store(false)
	ticks.ticks <- time.Time{}
	// Receiving the next tick proves the prior synchronous beat has finished.
	ticks.ticks <- time.Time{}
	if writes.Load() < 2 {
		t.Fatal("context cancellation stopped lease renewal before release")
	}
}
