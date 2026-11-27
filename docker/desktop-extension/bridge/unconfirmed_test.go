package main

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

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
