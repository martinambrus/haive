package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestUnconfirmedPreLeaseProbeKeepsMarker(t *testing.T) {
	b := fixture(t)
	b.groupGone = func(int) bool { return true }
	if err := b.markUnconfirmed("old", &commandOutcome{errCommandStopUnconfirmed, 100}); err != nil {
		t.Fatal(err)
	}
	original, err := os.ReadFile(b.unconfirmedPath())
	if err != nil {
		t.Fatal(err)
	}
	write := b.lockCfg.resolved().write
	b.lockCfg.write = func(f *os.File, data []byte) error {
		var record lockRecord
		if err := json.Unmarshal(data, &record); err != nil {
			return err
		}
		if f.Name() == windowPathOf(b) && record.Seq == 1 {
			current, err := os.ReadFile(b.unconfirmedPath())
			if err != nil || string(current) != string(original) {
				t.Error("pre-lease probe changed the marker before window acquisition")
			}
		}
		return write(f, data)
	}
	if _, err := b.handle(context.Background(), stopReq()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(b.unconfirmedPath()); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("protected check did not clear the old marker", err)
	}
}

func TestUnconfirmedInterleavedRequestsKeepNewMarker(t *testing.T) {
	b := fixture(t)
	const oldGroup, newGroup = 100, 200
	b.groupGone = func(group int) bool { return group == oldGroup }
	if err := b.markUnconfirmed("old", &commandOutcome{errCommandStopUnconfirmed, oldGroup}); err != nil {
		t.Fatal(err)
	}
	base := b.run
	mutations := 0
	b.run = func(ctx context.Context, exe string, args []string, dir string, log io.Writer) (string, error) {
		if log != nil {
			mutations++
			return "", &commandOutcome{errCommandStopUnconfirmed, newGroup}
		}
		return base(ctx, exe, args, dir, log)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	probed, resume := make(chan struct{}), make(chan struct{})
	a := b
	var once sync.Once
	a.groupGone = func(group int) bool {
		if group == oldGroup {
			once.Do(func() {
				close(probed)
				select {
				case <-resume:
				case <-ctx.Done():
				}
			})
		}
		return group == oldGroup
	}
	done := make(chan error, 1)
	go func() { _, err := a.handle(ctx, stopReq()); done <- err }()
	select {
	case <-probed:
	case <-ctx.Done():
		t.Fatal("request A did not probe the old marker")
	}
	// B clears the old record under its lease, runs the fake command, persists
	// a new unconfirmed group and releases both leases before A resumes.
	_, bErr := b.handle(ctx, stopReq())
	newMarker, readErr := os.ReadFile(b.unconfirmedPath())
	close(resume)
	aErr := <-done
	if !errors.Is(bErr, errCommandStopUnconfirmed) || readErr != nil {
		t.Fatalf("request B did not persist its refusal: %v (%v)", bErr, readErr)
	}
	if !errors.Is(aErr, errUnconfirmed) || mutations != 1 {
		t.Errorf("request A passed the new refusal: %v, mutations=%d", aErr, mutations)
	}
	after, err := os.ReadFile(b.unconfirmedPath())
	if err != nil || string(after) != string(newMarker) {
		t.Fatalf("request A replaced or removed request B's marker: %s (%v)", after, err)
	}
}

func TestUnconfirmedClearRechecksProbedRecord(t *testing.T) {
	b := fixture(t)
	if err := b.markUnconfirmed("old", &commandOutcome{errCommandStopUnconfirmed, 100}); err != nil {
		t.Fatal(err)
	}
	release, err := b.takeWindowLock(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	var replacement []byte
	b.groupGone = func(int) bool {
		// Even the same pgid can belong to a newer operation: compare the
		// complete record after the probe, immediately before removing it.
		if err := b.markUnconfirmed("new", &commandOutcome{errCommandStopUnconfirmed, 100}); err != nil {
			t.Fatal(err)
		}
		var err error
		replacement, err = os.ReadFile(b.unconfirmedPath())
		if err != nil {
			t.Fatal(err)
		}
		return true
	}
	if err := b.checkUnconfirmed(clearUnconfirmed); !errors.Is(err, errUnconfirmed) {
		t.Errorf("changed record was not refused: %v", err)
	}
	after, err := os.ReadFile(b.unconfirmedPath())
	if err != nil || string(after) != string(replacement) {
		t.Fatalf("stale probe removed the replacement record: %s (%v)", after, err)
	}
}

func TestUnconfirmedMarkerBeforeLeaseRelease(t *testing.T) {
	for _, failure := range []error{errCommandStopUnconfirmed, errCommandUncertain} {
		t.Run(failure.Error(), func(t *testing.T) {
			b := fixture(t)
			marker := filepath.Join(b.dir, ".haive-extension-unconfirmed")
			base := b.run
			calls, releases := 0, 0
			b.run = func(ctx context.Context, exe string, args []string, dir string, log io.Writer) (string, error) {
				if log != nil {
					io.WriteString(log, "preserved operation evidence\n")
					calls++
					return "", failure
				}
				return base(ctx, exe, args, dir, log)
			}
			b.lockCfg.remove = func(path string) error {
				if path == lockPathOf(b) || path == windowPathOf(b) {
					releases++
					data, err := os.ReadFile(marker)
					if err != nil || !strings.Contains(string(data), `"operation":"stop"`) {
						t.Errorf("marker missing before lease release: %s (%v)", data, err)
					}
					for _, lease := range []string{lockPathOf(b), windowPathOf(b)} {
						if releases == 1 {
							if _, err := os.Stat(lease); err != nil {
								t.Errorf("lease already released before marker: %v", err)
							}
						}
					}
				}
				return os.Remove(path)
			}
			if _, err := b.handle(context.Background(), stopReq()); !errors.Is(err, failure) {
				t.Fatalf("lost failure: %v", err)
			}
			if releases != 2 {
				t.Fatalf("released %d leases", releases)
			}
			before, _ := os.ReadFile(b.dir + ".extension.log")
			if _, err := b.handle(context.Background(), stopReq()); err == nil || !strings.Contains(err.Error(), "unconfirmed") {
				t.Errorf("next stop not refused: %v", err)
			}
			if calls != 1 {
				t.Errorf("mutating command called %d times", calls)
			}
			after, _ := os.ReadFile(b.dir + ".extension.log")
			if string(before) != string(after) {
				t.Error("refusal truncated operation log")
			}
			s, _ := b.handle(context.Background(), request{Action: "status", Engine: "desktop-engine"})
			if !strings.Contains(s.Error, "unconfirmed") {
				t.Error("status does not report marker")
			}
		})
	}
}

func TestUnconfirmedMarkerAllMutationsAndReadOnlyStatus(t *testing.T) {
	b := fixture(t)
	marker := filepath.Join(b.dir, ".haive-extension-unconfirmed")
	if err := os.WriteFile(marker, []byte("malformed"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, action := range []string{"install", "start", "stop"} {
		r := request{Action: action, Version: "latest", Consent: consent, Engine: "desktop-engine"}
		if _, err := b.handle(context.Background(), r); err == nil || !strings.Contains(err.Error(), "unconfirmed") {
			t.Fatalf("%s: %v", action, err)
		}
	}
	s, err := b.handle(context.Background(), request{Action: "status", Engine: "desktop-engine"})
	if err != nil || !strings.Contains(s.Error, "unconfirmed") {
		t.Fatalf("status: %+v (%v)", s, err)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatal("status changed marker", err)
	}
}

func TestUnconfirmedProbeCannotRetryIntoInstall(t *testing.T) {
	b := fixture(t)
	base := b.run
	mutations := 0
	b.run = func(ctx context.Context, exe string, args []string, dir string, log io.Writer) (string, error) {
		if log != nil {
			mutations++
			return "", nil
		}
		if args[0] == "container" {
			return "", errCommandUncertain
		}
		return base(ctx, exe, args, dir, log)
	}
	_, err := b.handle(context.Background(), request{Action: "install", Version: "latest", Consent: consent, Engine: "desktop-engine"})
	if !errors.Is(err, errCommandUncertain) || mutations != 0 {
		t.Fatalf("continued after uncertain probe: %v, mutations=%d", err, mutations)
	}
	if _, err := os.Stat(filepath.Join(b.dir, ".haive-extension-unconfirmed")); err != nil {
		t.Fatal(err)
	}
}

func TestUnconfirmedEngineProbePreservesMarker(t *testing.T) {
	for _, action := range []string{"stop", "status"} {
		t.Run(action, func(t *testing.T) {
			b := fixture(t)
			marker := filepath.Join(b.dir, ".haive-extension-unconfirmed")
			const evidence = "existing ambiguous mutation evidence"
			if err := os.WriteFile(marker, []byte(evidence), 0600); err != nil {
				t.Fatal(err)
			}
			b.run = func(context.Context, string, []string, string, io.Writer) (string, error) {
				return "", errCommandUncertain
			}
			s, err := b.handle(context.Background(), request{Action: action, Engine: "desktop-engine"})
			if err == nil {
				t.Fatal("failed engine probe succeeded")
			}
			data, _ := os.ReadFile(marker)
			if string(data) != evidence {
				t.Fatal("lease-free probe overwrote mutation evidence")
			}
			if action == "status" && (!strings.Contains(s.Error, "unconfirmed") || !strings.Contains(err.Error(), "unconfirmed")) {
				t.Fatalf("failed status hid marker: %+v (%v)", s, err)
			}
		})
	}
}
