package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func windowPathOf(b bridge) string { return b.dir + ".extension-lock" }

func windowEntries(t *testing.T, b bridge) []string {
	t.Helper()
	found, err := filepath.Glob(windowPathOf(b) + "*")
	if err != nil {
		t.Fatal(err)
	}
	return found
}

func isRegular(path string) bool {
	info, err := os.Lstat(path)
	return err == nil && info.Mode().IsRegular()
}

func windowRequests() []request {
	return []request{startReq(), stopReq(), {Action: "install", Version: "latest", Consent: consent, Engine: "desktop-engine"}}
}

// An install request needs no .env, so a test that runs one removes it first.
func prepare(t *testing.T, b bridge, r request) {
	t.Helper()
	if r.Action == "install" {
		if err := os.Remove(filepath.Join(b.dir, ".env")); err != nil {
			t.Fatal(err)
		}
	}
}

func installerWrites(t *testing.T, b *bridge, env []byte, onInstaller func()) {
	t.Helper()
	base := b.run
	b.run = func(ctx context.Context, exe string, args []string, dir string, log io.Writer) (string, error) {
		if exe == "sh" {
			if onInstaller != nil {
				onInstaller()
			}
			return "", os.WriteFile(filepath.Join(b.dir, ".env"), env, 0600)
		}
		return base(ctx, exe, args, dir, log)
	}
}

func TestWindowLockCrashedHolderClears(t *testing.T) {
	for _, r := range windowRequests() {
		t.Run(r.Action, func(t *testing.T) {
			b := fixture(t)
			env, _ := os.ReadFile(filepath.Join(b.dir, ".env"))
			prepare(t, b, r)
			if err := os.WriteFile(windowPathOf(b), rawRecord(randomHex(t), "extension", 7), 0644); err != nil {
				t.Fatal(err)
			}
			b.sleep = func(time.Duration) {}
			ran := 0
			if r.Action == "install" {
				installerWrites(t, &b, env, func() { ran++ })
			}
			tr := wrapRun(&b, nil, nil)
			if _, err := b.handle(context.Background(), r); err != nil {
				t.Fatalf("crashed holder not cleared: %v", err)
			}
			if r.Action == "install" && ran != 1 {
				t.Fatalf("installer ran %d times", ran)
			}
			if r.Action != "install" && tr.compose != 1 {
				t.Fatalf("compose ran %d times", tr.compose)
			}
			if left := windowEntries(t, b); len(left) != 0 {
				t.Fatalf("left behind: %v", left)
			}
		})
	}
}

func TestWindowLockLiveHolderRefuses(t *testing.T) {
	for _, r := range windowRequests() {
		t.Run(r.Action, func(t *testing.T) {
			b := fixture(t)
			prepare(t, b, r)
			path := windowPathOf(b)
			token := randomHex(t)
			if err := os.WriteFile(path, rawRecord(token, "extension", 7), 0644); err != nil {
				t.Fatal(err)
			}
			before, err := os.Stat(path)
			if err != nil {
				t.Fatal(err)
			}
			fastLock(&b)
			b.sleep = func(time.Duration) { beatRecord(t, path) }
			tr := wrapRun(&b, nil, nil)
			_, err = b.handle(context.Background(), r)
			if err == nil || err.Error() != extensionBusyMessage {
				t.Errorf("live holder not refused with the busy message: %v", err)
			}
			if tr.ls != 0 || tr.compose != 0 || tr.other != 0 {
				t.Errorf("work ran under a live holder: %+v", *tr)
			}
			after, statErr := os.Stat(path)
			if statErr != nil || !os.SameFile(before, after) {
				t.Fatalf("holder's file replaced: %v", statErr)
			}
			data, _ := os.ReadFile(path)
			if got, _ := decodeLockRecord(data); got != token {
				t.Errorf("holder's token changed: %q", data)
			}
			if left := windowEntries(t, b); len(left) != 1 {
				t.Errorf("entries: %v", left)
			}
		})
	}
}

// Hands out one timer per lease so a test can tick each independently.
type timerSet struct {
	mu      sync.Mutex
	chans   []chan time.Time
	created chan struct{}
}

func newTimerSet() *timerSet { return &timerSet{created: make(chan struct{}, 8)} }

func (s *timerSet) newTicker(time.Duration) (<-chan time.Time, func()) {
	ch := make(chan time.Time, 1)
	s.mu.Lock()
	s.chans = append(s.chans, ch)
	s.mu.Unlock()
	s.created <- struct{}{}
	return ch, func() {}
}

func (s *timerSet) tickAll() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, ch := range s.chans {
		select {
		case ch <- time.Time{}:
		default:
		}
	}
}

func TestWindowLockHeartbeatKeepsLeaseAlive(t *testing.T) {
	b := fixture(t)
	path := windowPathOf(b)
	second := b
	second.lockCfg = lockConfig{stale: 5 * time.Millisecond, poll: time.Millisecond}
	timers := newTimerSet()
	b.lockCfg.newTicker = timers.newTicker
	var armed atomic.Bool
	beats := make(chan struct{}, 16)
	write := b.lockCfg.resolved().write
	b.lockCfg.write = func(f *os.File, data []byte) error {
		err := write(f, data)
		if armed.Load() && f.Name() == path {
			select {
			case beats <- struct{}{}:
			default:
			}
		}
		return err
	}
	guard := func(what string, ch <-chan struct{}) {
		select {
		case <-ch:
		case <-time.After(5 * time.Second):
			t.Fatalf("timed out waiting for %s", what)
		}
	}
	pattern := regexp.MustCompile(`^\{"v":1,"token":"([0-9a-f]{32})","holder":"extension","startedAt":"([^"]+)","seq":1\}\n$`)
	var secondErr error
	var seqBefore, seqAfter int
	var sameFile bool
	wrapRun(&b, nil, func() {
		guard("the window lease timer", timers.created)
		guard("the stack lease timer", timers.created)
		if !isRegular(path) {
			t.Fatal("window lock is not a regular file")
		}
		data, _ := os.ReadFile(path)
		if !pattern.Match(data) {
			t.Fatalf("window record shape: %q", data)
		}
		beforeInfo, _ := os.Stat(path)
		armed.Store(true)
		seqBefore = recordSeq(t, path)
		once := false
		second.sleep = func(time.Duration) {
			if once {
				return
			}
			once = true
			timers.tickAll()
			guard("the window beat", beats)
		}
		_, secondErr = second.handle(context.Background(), stopReq())
		afterInfo, _ := os.Stat(path)
		sameFile = os.SameFile(beforeInfo, afterInfo)
		seqAfter = recordSeq(t, path)
	})
	if _, err := b.handle(context.Background(), startReq()); err != nil {
		t.Fatal(err)
	}
	if secondErr == nil || secondErr.Error() != extensionBusyMessage {
		t.Fatalf("second window not refused by the window lock: %v", secondErr)
	}
	if !sameFile {
		t.Error("window file replaced")
	}
	if seqAfter <= seqBefore {
		t.Errorf("window lease did not beat: seq %d then %d", seqBefore, seqAfter)
	}
}

func recordSeq(t *testing.T, path string) int {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var record lockRecord
	if err := json.Unmarshal(data, &record); err != nil {
		t.Fatalf("record %q: %v", data, err)
	}
	return record.Seq
}

func TestWindowLockLeavesNothingBehind(t *testing.T) {
	for _, mode := range []string{"start", "stop", "error", "panic"} {
		t.Run(mode, func(t *testing.T) {
			b := fixture(t)
			path := windowPathOf(b)
			base := b.run
			regular := false
			b.run = func(ctx context.Context, exe string, args []string, dir string, log io.Writer) (string, error) {
				if log != nil {
					regular = isRegular(path)
					switch mode {
					case "error":
						return "", errors.New("compose failed")
					case "panic":
						panic("compose panicked")
					}
				}
				return base(ctx, exe, args, dir, log)
			}
			r := startReq()
			if mode == "stop" {
				r = stopReq()
			}
			func() {
				defer func() {
					if v := recover(); v != nil && mode != "panic" {
						panic(v)
					}
				}()
				_, err := b.handle(context.Background(), r)
				if (mode == "start" || mode == "stop") && err != nil {
					t.Fatal(err)
				}
				if mode == "error" && err == nil {
					t.Fatal("compose error swallowed")
				}
			}()
			if !regular {
				t.Error("window lock was not a regular file inside compose")
			}
			if left := windowEntries(t, b); len(left) != 0 {
				t.Errorf("left behind: %v", left)
			}
		})
	}
}

func TestWindowLockLegacyFolder(t *testing.T) {
	for _, r := range windowRequests() {
		t.Run(r.Action, func(t *testing.T) {
			b := fixture(t)
			path := windowPathOf(b)
			if err := os.Mkdir(path, 0700); err != nil {
				t.Fatal(err)
			}
			b.sleep = func(time.Duration) { t.Error("waited on a legacy folder") }
			tr := wrapRun(&b, nil, nil)
			_, err := b.handle(context.Background(), r)
			if err == nil || !strings.Contains(err.Error(), path) || !strings.Contains(err.Error(), "delete that folder") {
				t.Errorf("legacy folder error: %v", err)
			}
			if tr.ls != 0 || tr.compose != 0 || tr.other != 0 {
				t.Errorf("work ran past a legacy folder: %+v", *tr)
			}
			entries, readErr := os.ReadDir(path)
			if readErr != nil || len(entries) != 0 {
				t.Fatalf("folder touched: %v %v", entries, readErr)
			}
			if left := windowEntries(t, b); len(left) != 1 {
				t.Errorf("entries: %v", left)
			}
			if err := os.Remove(path); err != nil {
				t.Fatal(err)
			}
			if _, err := b.handle(context.Background(), stopReq()); err != nil {
				t.Fatalf("stop after the folder was deleted: %v", err)
			}
			if left := windowEntries(t, b); len(left) != 0 {
				t.Errorf("left behind: %v", left)
			}
		})
	}
}

func TestWindowLockWindowsReleaseRetries(t *testing.T) {
	b := fixture(t)
	b.os = "windows"
	path := windowPathOf(b)
	failed := 0
	b.lockCfg.remove = func(p string) error {
		if p == path && failed < 3 {
			failed++
			return os.ErrPermission
		}
		return os.Remove(p)
	}
	var pauses []time.Duration
	b.sleep = func(d time.Duration) { pauses = append(pauses, d) }
	if _, err := b.handle(context.Background(), stopReq()); err != nil {
		t.Fatal(err)
	}
	if left := windowEntries(t, b); len(left) != 0 {
		t.Errorf("left behind: %v", left)
	}
	want := []time.Duration{50 * time.Millisecond, 50 * time.Millisecond, 50 * time.Millisecond}
	if !reflect.DeepEqual(pauses, want) {
		t.Errorf("pauses %v, want %v", pauses, want)
	}
}

func TestWindowLockFailedReleaseIsClearedByTheNextOperation(t *testing.T) {
	b := fixture(t)
	path := windowPathOf(b)
	b.lockCfg.remove = func(p string) error {
		if p == path {
			return os.ErrPermission
		}
		return os.Remove(p)
	}
	if _, err := b.handle(context.Background(), stopReq()); err != nil {
		t.Fatalf("a failed release failed the caller: %v", err)
	}
	if !isRegular(path) {
		t.Fatal("window file did not remain after the failed release")
	}
	b.lockCfg = lockConfig{}
	fastLock(&b)
	b.sleep = func(time.Duration) {}
	if _, err := b.handle(context.Background(), stopReq()); err != nil {
		t.Fatalf("next operation refused: %v", err)
	}
	if left := windowEntries(t, b); len(left) != 0 {
		t.Errorf("left behind: %v", left)
	}
}

func TestWindowLockInstallTakesItStatusDoesNot(t *testing.T) {
	b := fixture(t)
	path := windowPathOf(b)
	env, _ := os.ReadFile(filepath.Join(b.dir, ".env"))
	if err := os.Remove(filepath.Join(b.dir, ".env")); err != nil {
		t.Fatal(err)
	}
	installerSaw := false
	installerWrites(t, &b, env, func() {
		installerSaw = true
		if !isRegular(path) {
			t.Error("window lock is not a regular file during the installer")
		}
		if _, err := os.Lstat(lockPathOf(b)); err == nil {
			t.Error("stack lock held during the installer")
		}
	})
	if _, err := b.handle(context.Background(), request{Action: "install", Version: "latest", Consent: consent, Engine: "desktop-engine"}); err != nil {
		t.Fatal(err)
	}
	if !installerSaw {
		t.Fatal("installer did not run")
	}

	calls := 0
	base := b.run
	b.run = func(ctx context.Context, exe string, args []string, dir string, log io.Writer) (string, error) {
		if !reflect.DeepEqual(args, []string{"info", "--format", "{{.ID}}"}) {
			calls++
			if _, err := os.Lstat(path); err == nil {
				t.Error("window lock held during status")
			}
			if lockExists(b) {
				t.Error("stack lock held during status")
			}
		}
		return base(ctx, exe, args, dir, log)
	}
	if _, err := b.handle(context.Background(), request{Action: "status", Engine: "desktop-engine"}); err != nil {
		t.Fatal(err)
	}
	if calls == 0 {
		t.Fatal("status made no engine call to observe")
	}
}
