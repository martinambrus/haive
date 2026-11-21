package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func lockPathOf(b bridge) string { return filepath.Join(b.dir, stackLockName) }

func randomHex(t *testing.T) string {
	t.Helper()
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(raw)
}

func rawRecord(token, holder string, seq int) []byte {
	return []byte(fmt.Sprintf(`{"v":1,"token":%q,"holder":%q,"startedAt":"2026-11-21T10:00:00.000Z","seq":%d}`+"\n", token, holder, seq))
}

// Simulates the holder's heartbeat at protocol level: rewrite in place with seq+1.
func beatRecord(t *testing.T, path string) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var record lockRecord
	if err := json.Unmarshal(data, &record); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, rawRecord(record.Token, record.Holder, record.Seq+1), 0644); err != nil {
		t.Fatal(err)
	}
}

func fastLock(b *bridge) {
	b.lockCfg = lockConfig{stale: 20 * time.Millisecond, poll: time.Millisecond}
}

type trace struct{ ls, compose, other int }

func wrapRun(b *bridge, onLs func(n int), onCompose func()) *trace {
	base := b.run
	tr := &trace{}
	b.run = func(ctx context.Context, exe string, args []string, dir string, log io.Writer) (string, error) {
		switch {
		case reflect.DeepEqual(args, []string{"container", "ls", "--no-trunc", "--format", "{{.ID}}"}):
			tr.ls++
			if onLs != nil {
				onLs(tr.ls)
			}
		case log != nil:
			tr.compose++
			if onCompose != nil {
				onCompose()
			}
		case reflect.DeepEqual(args, []string{"info", "--format", "{{.ID}}"}):
		default:
			tr.other++
		}
		return base(ctx, exe, args, dir, log)
	}
	return tr
}

func startReq() request {
	return request{Action: "start", Consent: consent, Engine: "desktop-engine"}
}

func stopReq() request { return request{Action: "stop", Engine: "desktop-engine"} }

func lockExists(b bridge) bool {
	_, err := os.Lstat(lockPathOf(b))
	return err == nil
}

func TestStackLockWindowHook(t *testing.T) {
	for _, req := range []request{startReq(), stopReq()} {
		t.Run(req.Action, func(t *testing.T) {
			b := fixture(t)
			path := lockPathOf(b)
			sawLockInCompose := false
			tr := wrapRun(&b, func(n int) {
				if n != 2 {
					return
				}
				f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0644)
				if err == nil {
					f.Close()
					t.Error("late updater created the lock at the final check")
					return
				}
				if !errors.Is(err, os.ErrExist) {
					t.Errorf("unexpected create error: %v", err)
				}
				data, _ := os.ReadFile(path)
				var record lockRecord
				if json.Unmarshal(data, &record) != nil || record.Holder != "extension" {
					t.Errorf("lock not held by the extension at the final check: %q", data)
				}
			}, func() { sawLockInCompose = lockExists(b) })
			if _, err := b.handle(context.Background(), req); err != nil {
				t.Fatal(err)
			}
			if tr.compose != 1 || tr.ls != 2 || !sawLockInCompose {
				t.Fatalf("compose=%d ls=%d sawLock=%v", tr.compose, tr.ls, sawLockInCompose)
			}
			if lockExists(b) {
				t.Fatal("lock leaked after handle")
			}
			f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0644)
			if err != nil {
				t.Fatalf("updater cannot take the lock after handle: %v", err)
			}
			f.Close()
		})
	}
}

func TestStackLockHeldByUpdaterRefuses(t *testing.T) {
	for _, req := range []request{startReq(), stopReq()} {
		t.Run(req.Action, func(t *testing.T) {
			b := fixture(t)
			fastLock(&b)
			path := lockPathOf(b)
			env := filepath.Join(b.dir, ".env")
			before, _ := os.ReadFile(env)
			record := rawRecord(randomHex(t), "updater", 1)
			if err := os.WriteFile(path, record, 0644); err != nil {
				t.Fatal(err)
			}
			b.sleep = func(time.Duration) { beatRecord(t, path) }
			tr := wrapRun(&b, nil, nil)
			_, err := b.handle(context.Background(), req)
			if err == nil || err.Error() != upgradeActiveMessage {
				t.Fatalf("want upgrade-active refusal, got %v", err)
			}
			after, _ := os.ReadFile(env)
			if tr.compose != 0 || tr.other != 0 || !bytes.Equal(before, after) {
				t.Fatalf("mutated: compose=%d other=%d", tr.compose, tr.other)
			}
			if !lockExists(b) {
				t.Fatal("updater's lock removed")
			}
		})
	}
}

func TestStackLockCrashedHolderClears(t *testing.T) {
	for _, req := range []request{startReq(), stopReq()} {
		t.Run(req.Action, func(t *testing.T) {
			b := fixture(t)
			b.lockCfg = lockConfig{stale: 5 * time.Millisecond, poll: time.Millisecond}
			b.sleep = func(time.Duration) {}
			if err := os.WriteFile(lockPathOf(b), rawRecord(randomHex(t), "updater", 7), 0644); err != nil {
				t.Fatal(err)
			}
			tr := wrapRun(&b, nil, nil)
			if _, err := b.handle(context.Background(), req); err != nil {
				t.Fatal(err)
			}
			if tr.compose != 1 || lockExists(b) {
				t.Fatalf("compose=%d lock=%v", tr.compose, lockExists(b))
			}
			tombs, _ := filepath.Glob(lockPathOf(b) + ".stale.*")
			if len(tombs) != 0 {
				t.Fatalf("tombstone left: %v", tombs)
			}
		})
	}
}

func TestStackLockStaleBoundary(t *testing.T) {
	b := fixture(t)
	b.lockCfg = lockConfig{stale: 5 * time.Millisecond, poll: time.Millisecond}
	path := lockPathOf(b)
	original := rawRecord(randomHex(t), "updater", 3)
	if err := os.WriteFile(path, original, 0644); err != nil {
		t.Fatal(err)
	}
	sleeps, atBreak := 0, -1
	b.sleep = func(time.Duration) {
		sleeps++
		now, err := os.ReadFile(path)
		if err != nil || !bytes.Equal(now, original) {
			t.Fatalf("lock broken after only %d sleeps", sleeps)
		}
		if tombs, _ := filepath.Glob(path + ".stale.*"); len(tombs) != 0 {
			t.Fatalf("tombstone after %d sleeps", sleeps)
		}
	}
	b.lockCfg.beforeBreak = func() { atBreak = sleeps }
	l, err := b.acquireStackLock(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer l.releaseLock()
	if sleeps != 5 || atBreak != 5 {
		t.Fatalf("sleeps=%d beforeBreak saw %d, want 5 (stale/poll)", sleeps, atBreak)
	}
}

func TestStackLockLiveHolderNeverBroken(t *testing.T) {
	b := fixture(t)
	b.lockCfg = lockConfig{stale: 20 * time.Millisecond, poll: time.Millisecond}
	path := lockPathOf(b)
	if err := os.WriteFile(path, rawRecord(randomHex(t), "updater", 1), 0644); err != nil {
		t.Fatal(err)
	}
	first, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	fake := time.Duration(0)
	b.sleep = func(d time.Duration) {
		fake += d
		if fake%(5*time.Millisecond) == 0 {
			beatRecord(t, path)
		}
	}
	for fake < 20*b.lockCfg.stale {
		l, err := b.acquireStackLock(context.Background())
		if err == nil {
			l.releaseLock()
			t.Fatal("live holder was displaced")
		}
		now, serr := os.Stat(path)
		if serr != nil || !os.SameFile(first, now) {
			t.Fatalf("live holder's lock replaced or restored after %v of fake time: %v", fake, serr)
		}
	}
}

func TestStackLockOldUpdaterWithoutLock(t *testing.T) {
	b := fixture(t)
	base := b.run
	b.run = func(ctx context.Context, exe string, args []string, dir string, log io.Writer) (string, error) {
		if lockExists(b) {
			t.Error("lock created although the first guard refused")
		}
		if args[0] == "container" && args[1] == "ls" {
			return strings.Repeat("a", 64) + "\n", nil
		}
		if args[0] == "container" && args[1] == "inspect" {
			return "true\n", nil
		}
		return base(ctx, exe, args, dir, log)
	}
	for _, req := range []request{startReq(), stopReq()} {
		_, err := b.handle(context.Background(), req)
		if err == nil || err.Error() != upgradeActiveMessage {
			t.Fatalf("want upgrade-active refusal, got %v", err)
		}
		if lockExists(b) {
			t.Fatal("lock file created")
		}
	}
}

func TestStackLockTwoWindows(t *testing.T) {
	b := fixture(t)
	second := b
	second.lockCfg = lockConfig{stale: 20 * time.Millisecond, poll: time.Millisecond}
	second.sleep = func(time.Duration) { beatRecord(t, lockPathOf(b)) }
	var handleErr, lockErr error
	inCompose := 0
	wrapRun(&b, nil, func() {
		inCompose++
		_, handleErr = second.handle(context.Background(), stopReq())
		_, lockErr = second.takeStackLock(context.Background())
	})
	if _, err := b.handle(context.Background(), startReq()); err != nil {
		t.Fatal(err)
	}
	if inCompose != 1 {
		t.Fatalf("compose ran %d times", inCompose)
	}
	if handleErr == nil || !strings.Contains(handleErr.Error(), "Another operation is active") {
		t.Fatalf("second window not refused by the sibling lock: %v", handleErr)
	}
	if lockErr == nil || lockErr.Error() != extensionBusyMessage {
		t.Fatalf("second window not refused by the shared lock: %v", lockErr)
	}
	release, err := second.takeStackLock(context.Background())
	if err != nil {
		t.Fatalf("shared lock not freed: %v", err)
	}
	release()
	if _, err := os.Stat(b.dir + ".extension-lock"); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("sibling lock leaked")
	}
}

func TestStackLockReleaseRetries(t *testing.T) {
	for _, tc := range []struct {
		os      string
		failFor int
		calls   int
		sleeps  int
		gone    bool
	}{
		{"windows", 3, 4, 3, true},
		{"windows", 99, 4, 3, false},
		{"linux", 1, 1, 0, false},
		{"darwin", 99, 1, 0, false},
	} {
		t.Run(fmt.Sprintf("%s-fail-%d", tc.os, tc.failFor), func(t *testing.T) {
			b := fixture(t)
			b.os = tc.os
			calls, sleeps := 0, 0
			b.sleep = func(d time.Duration) {
				sleeps++
				if d != 50*time.Millisecond {
					t.Errorf("pause %v", d)
				}
			}
			b.lockCfg.remove = func(path string) error {
				calls++
				if calls <= tc.failFor {
					return os.ErrPermission
				}
				return os.Remove(path)
			}
			l, err := b.acquireStackLock(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			l.releaseLock()
			if calls != tc.calls || sleeps != tc.sleeps || lockExists(b) != !tc.gone {
				t.Fatalf("calls=%d sleeps=%d exists=%v", calls, sleeps, lockExists(b))
			}
		})
	}
}

func TestStackLockReleasePauseIsConfigurable(t *testing.T) {
	b := fixture(t)
	b.os = "windows"
	var pauses []time.Duration
	b.sleep = func(d time.Duration) { pauses = append(pauses, d) }
	b.lockCfg.releasePause = 7 * time.Millisecond
	b.lockCfg.remove = func(string) error { return os.ErrPermission }
	l, err := b.acquireStackLock(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	l.releaseLock()
	if !reflect.DeepEqual(pauses, []time.Duration{7 * time.Millisecond, 7 * time.Millisecond, 7 * time.Millisecond}) {
		t.Fatalf("pauses %v, want three of 7ms", pauses)
	}
}

func TestStackLockBreakRenameFailureIsBusy(t *testing.T) {
	b := fixture(t)
	b.lockCfg = lockConfig{stale: 3 * time.Millisecond, poll: time.Millisecond}
	b.sleep = func(time.Duration) {}
	path := lockPathOf(b)
	original := rawRecord(randomHex(t), "updater", 1)
	os.WriteFile(path, original, 0644)
	b.rename = func(string, string) error { return os.ErrPermission }
	if _, err := b.acquireStackLock(context.Background()); err == nil {
		t.Fatal("acquired despite a failed break")
	}
	now, _ := os.ReadFile(path)
	if !bytes.Equal(now, original) {
		t.Fatal("lock forced")
	}
}

func TestStackLockRecordConformance(t *testing.T) {
	b := fixture(t)
	l, err := b.acquireStackLock(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(lockPathOf(b))
	if err != nil {
		t.Fatal(err)
	}
	pattern := regexp.MustCompile(`^\{"v":1,"token":"([0-9a-f]{32})","holder":"extension","startedAt":"([^"]+)","seq":1\}\n$`)
	m := pattern.FindSubmatch(data)
	if m == nil {
		t.Fatalf("record shape: %q", data)
	}
	if _, err := time.Parse("2006-01-02T15:04:05.000Z", string(m[2])); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		info, _ := os.Stat(lockPathOf(b))
		if info.Mode().Perm() != 0644 {
			t.Fatalf("mode %v", info.Mode().Perm())
		}
	}
	l.releaseLock()
	other, _ := b.acquireStackLock(context.Background())
	again, _ := os.ReadFile(lockPathOf(b))
	if bytes.Equal(pattern.FindSubmatch(again)[1], m[1]) {
		t.Fatal("token reused")
	}
	other.releaseLock()
}

func TestStackLockProtocolExampleIsLiveUpdater(t *testing.T) {
	b := fixture(t)
	fastLock(&b)
	example := `{"v":1,"token":"<32 lowercase hex>","holder":"updater","startedAt":"2026-11-21T10:00:00.000Z","seq":1}` + "\n"
	os.WriteFile(lockPathOf(b), []byte(example), 0644)
	b.sleep = func(time.Duration) { beatRecord(t, lockPathOf(b)) }
	_, err := b.takeStackLock(context.Background())
	if err == nil || err.Error() != upgradeActiveMessage {
		t.Fatalf("got %v", err)
	}
}

func TestStackLockUnparseableRecordsClear(t *testing.T) {
	for _, content := range []string{"", "garbage", `{"v":1,"tok`} {
		b := fixture(t)
		b.lockCfg = lockConfig{stale: 3 * time.Millisecond, poll: time.Millisecond}
		b.sleep = func(time.Duration) {}
		os.WriteFile(lockPathOf(b), []byte(content), 0644)
		l, err := b.acquireStackLock(context.Background())
		if err != nil {
			t.Fatalf("%q: %v", content, err)
		}
		l.releaseLock()
	}
}

func TestStackLockUnknownHolderMessageNamesPathNotRecord(t *testing.T) {
	b := fixture(t)
	fastLock(&b)
	secret := "evil-" + randomHex(t)
	os.WriteFile(lockPathOf(b), rawRecord(randomHex(t), secret, 1), 0644)
	b.sleep = func(time.Duration) { beatRecord(t, lockPathOf(b)) }
	_, err := b.takeStackLock(context.Background())
	if err == nil || strings.Contains(err.Error(), secret) || !strings.Contains(err.Error(), lockPathOf(b)) {
		t.Fatalf("got %v", err)
	}
}

func TestStackLockBeforeBreakSwapRestoresFreshRecord(t *testing.T) {
	b := fixture(t)
	b.lockCfg = lockConfig{stale: 3 * time.Millisecond, poll: time.Millisecond}
	b.sleep = func(time.Duration) {}
	path := lockPathOf(b)
	os.WriteFile(path, rawRecord(randomHex(t), "updater", 1), 0644)
	fresh := rawRecord(randomHex(t), "updater", 9)
	b.lockCfg.beforeBreak = func() {
		os.Remove(path)
		os.WriteFile(path, fresh, 0644)
	}
	if _, err := b.acquireStackLock(context.Background()); err == nil {
		t.Fatal("displaced a fresh holder")
	}
	now, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(now, fresh) {
		t.Fatalf("fresh record not restored: %q %v", now, err)
	}
	if tombs, _ := filepath.Glob(path + ".stale.*"); len(tombs) != 0 {
		t.Fatalf("tombstone left: %v", tombs)
	}
}

func TestStackLockReleaseLeavesForeignToken(t *testing.T) {
	b := fixture(t)
	l, err := b.acquireStackLock(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	foreign := rawRecord(randomHex(t), "updater", 4)
	os.WriteFile(lockPathOf(b), foreign, 0644)
	l.releaseLock()
	now, err := os.ReadFile(lockPathOf(b))
	if err != nil || !bytes.Equal(now, foreign) {
		t.Fatalf("foreign record touched: %q %v", now, err)
	}
}

func TestStackLockLostDetection(t *testing.T) {
	for _, mode := range []string{"foreign"} {
		t.Run(mode, func(t *testing.T) {
			b := fixture(t)
			b.lockCfg.beat = 2 * time.Millisecond
			l, err := b.acquireStackLock(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			os.WriteFile(lockPathOf(b), rawRecord(randomHex(t), "updater", 1), 0644)
			select {
			case <-l.done:
			case <-time.After(2 * time.Second):
				t.Fatal("heartbeat did not stop after the lock was lost")
			}
			if !l.isLost() {
				t.Fatal("loss not recorded")
			}
			before, _ := os.ReadFile(lockPathOf(b))
			l.releaseLock()
			after, _ := os.ReadFile(lockPathOf(b))
			if !bytes.Equal(before, after) {
				t.Fatal("lost lock touched by release")
			}
		})
	}
}

func TestStackLockHeartbeatRuns(t *testing.T) {
	b := fixture(t)
	b.lockCfg.beat = 2 * time.Millisecond
	l, err := b.acquireStackLock(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		data, _ := os.ReadFile(lockPathOf(b))
		var record lockRecord
		if json.Unmarshal(data, &record) == nil && record.Seq >= 3 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("heartbeat never reached seq 3: %q", data)
		}
		time.Sleep(time.Millisecond)
	}
	l.releaseLock()
	select {
	case <-l.done:
	default:
		t.Fatal("heartbeat still running after release")
	}
	if lockExists(b) {
		t.Fatal("lock not removed")
	}
}

func TestStackLockRoundsBoundary(t *testing.T) {
	for _, rounds := range []int{0, 2} {
		b := fixture(t)
		b.lockCfg = lockConfig{stale: 3 * time.Millisecond, poll: time.Millisecond, rounds: rounds}
		b.sleep = func(time.Duration) {}
		path := lockPathOf(b)
		os.WriteFile(path, rawRecord(randomHex(t), "updater", 1), 0644)
		renames := 0
		b.rename = func(from, to string) error {
			renames++
			if err := os.Rename(from, to); err != nil {
				return err
			}
			return os.WriteFile(path, rawRecord(randomHex(t), "updater", renames), 0644)
		}
		want := rounds
		if want == 0 {
			want = stackLockRounds
		}
		if _, err := b.acquireStackLock(context.Background()); err == nil {
			t.Fatal("acquired while a competitor re-created the lock every round")
		}
		if renames != want {
			t.Fatalf("rounds=%d: %d break attempts, want %d", rounds, renames, want)
		}
	}
}

func TestStackLockRefusesNonRegularEntry(t *testing.T) {
	for _, kind := range []string{"dir", "symlink"} {
		t.Run(kind, func(t *testing.T) {
			b := fixture(t)
			path := lockPathOf(b)
			if kind == "dir" {
				os.Mkdir(path, 0700)
			} else {
				target := filepath.Join(b.dir, "target")
				os.WriteFile(target, rawRecord(randomHex(t), "updater", 1), 0644)
				if err := os.Symlink(target, path); err != nil {
					t.Skip(err)
				}
			}
			sleeps, renames := 0, 0
			b.sleep = func(time.Duration) { sleeps++ }
			b.rename = func(string, string) error { renames++; return nil }
			_, err := b.acquireStackLock(context.Background())
			if err == nil || !strings.Contains(err.Error(), path) {
				t.Fatalf("got %v", err)
			}
			info, lerr := os.Lstat(path)
			if lerr != nil || info.Mode().IsRegular() || sleeps != 0 || renames != 0 {
				t.Fatalf("entry touched: %v sleeps=%d renames=%d", lerr, sleeps, renames)
			}
		})
	}
}

func TestStackLockInstallAndStatusNeverTakeIt(t *testing.T) {
	b := fixture(t)
	os.Remove(filepath.Join(b.dir, ".env"))
	base := b.run
	b.run = func(ctx context.Context, exe string, args []string, dir string, log io.Writer) (string, error) {
		if lockExists(b) {
			t.Errorf("lock present during %s %v", exe, args)
		}
		return base(ctx, exe, args, dir, log)
	}
	b.handle(context.Background(), request{Action: "install", Version: "latest", Consent: consent, Engine: "desktop-engine"})
	b.handle(context.Background(), request{Action: "status", Engine: "desktop-engine"})
	if lockExists(b) {
		t.Fatal("lock left")
	}
}

func TestStackLockNeverLeaksAfterHandle(t *testing.T) {
	for _, req := range []request{startReq(), stopReq()} {
		for _, mode := range []string{"compose-fails", "final-guard-refuses"} {
			t.Run(req.Action+"/"+mode, func(t *testing.T) {
				b := fixture(t)
				base := b.run
				b.run = func(ctx context.Context, exe string, args []string, dir string, log io.Writer) (string, error) {
					if mode == "compose-fails" && log != nil {
						return "", errors.New("private failure")
					}
					if mode == "final-guard-refuses" && lockExists(b) {
						if args[0] == "container" && args[1] == "ls" {
							return strings.Repeat("a", 64) + "\n", nil
						}
						if args[0] == "container" && args[1] == "inspect" {
							return "true\n", nil
						}
					}
					return base(ctx, exe, args, dir, log)
				}
				if _, err := b.handle(context.Background(), req); err == nil {
					t.Fatal("expected failure")
				}
				if lockExists(b) {
					t.Fatal("lock leaked")
				}
			})
		}
	}
}

func TestStackLockTornOwnRecord(t *testing.T) {
	b := fixture(t)
	b.lockCfg.beat = time.Hour
	failWrites := false
	b.lockCfg.write = func(f *os.File, data []byte) error {
		if failWrites {
			return errors.New("disk full")
		}
		_, err := f.Write(data)
		return err
	}
	l, err := b.acquireStackLock(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer l.releaseLock()
	failWrites = true
	if got := l.beat(); got != "error" {
		t.Fatalf("beat after failing write: %s", got)
	}
	if data, _ := os.ReadFile(lockPathOf(b)); len(data) != 0 {
		t.Fatalf("expected a torn empty record, got %q", data)
	}
	failWrites = false
	if got := l.beat(); got != "ok" || l.isLost() {
		t.Fatalf("own torn record not rewritten: %s lost=%v", got, l.isLost())
	}
	data, _ := os.ReadFile(lockPathOf(b))
	if token, _ := decodeLockRecord(data); token != l.token {
		t.Fatalf("record not ours: %q", data)
	}
	for _, torn := range []string{"", `{"v":1,"tok`} {
		os.WriteFile(lockPathOf(b), []byte(torn), 0644)
		if got := l.beat(); got != "lost" || !l.isLost() {
			t.Fatalf("torn record %q without a failure streak: %s", torn, got)
		}
		l.mu.Lock()
		l.lost = false
		l.mu.Unlock()
	}
}

func TestStackLockSecondReleaseWaitsForFirst(t *testing.T) {
	b := fixture(t)
	entered, proceed := make(chan struct{}), make(chan struct{})
	var once sync.Once
	b.lockCfg.remove = func(path string) error {
		once.Do(func() { close(entered) })
		<-proceed
		return os.Remove(path)
	}
	l, err := b.acquireStackLock(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	first, second := make(chan struct{}), make(chan struct{})
	go func() { l.releaseLock(); close(first) }()
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("release never reached removal")
	}
	go func() { l.releaseLock(); close(second) }()
	select {
	case <-second:
		t.Fatal("second release returned before the first finished")
	case <-time.After(100 * time.Millisecond):
	}
	close(proceed)
	for _, done := range []chan struct{}{first, second} {
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Fatal("release did not finish")
		}
	}
	if lockExists(b) {
		t.Fatal("lock remains")
	}
}

func TestStackLockPollBelowOneMillisecondCountsAsOne(t *testing.T) {
	for _, poll := range []time.Duration{-1, 500 * time.Microsecond} {
		b := fixture(t)
		b.lockCfg = lockConfig{stale: 5 * time.Millisecond, poll: poll}
		var sleeps []time.Duration
		b.sleep = func(d time.Duration) { sleeps = append(sleeps, d) }
		os.WriteFile(lockPathOf(b), rawRecord(randomHex(t), "updater", 1), 0644)
		l, err := b.acquireStackLock(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		l.releaseLock()
		if len(sleeps) != 5 {
			t.Fatalf("poll %v: %d sleeps, want 5", poll, len(sleeps))
		}
		for _, d := range sleeps {
			if d != time.Millisecond {
				t.Fatalf("sleep %v", d)
			}
		}
	}
}

func TestStackLockObservationHonorsContext(t *testing.T) {
	b := fixture(t)
	fastLock(&b)
	os.WriteFile(lockPathOf(b), rawRecord(randomHex(t), "updater", 1), 0644)
	ctx, cancel := context.WithCancel(context.Background())
	sleeps := 0
	b.sleep = func(time.Duration) {
		sleeps++
		cancel()
	}
	if _, err := b.acquireStackLock(ctx); err == nil {
		t.Fatal("cancelled observation acquired")
	}
	if sleeps != 1 || !lockExists(b) {
		t.Fatalf("sleeps=%d", sleeps)
	}
}

func TestStackLockDefaultsMatchWireContract(t *testing.T) {
	c := lockConfig{}.resolved()
	if c.beat != 5*time.Second || c.stale != 60*time.Second || c.poll != time.Second || c.rounds != 3 || c.maxBytes != 4096 || stackLockMaxBytes != 4096 || c.releasePause != 50*time.Millisecond || stackLockName != ".haive-stack-lock" {
		t.Fatalf("%+v", c)
	}
}

func TestStackLockReadIsCapped(t *testing.T) {
	path := filepath.Join(t.TempDir(), "lock")
	for _, size := range []int{16, 17} {
		if err := os.WriteFile(path, bytes.Repeat([]byte("a"), size), 0644); err != nil {
			t.Fatal(err)
		}
		got, err := readLockFile(path, 16)
		if err != nil || len(got) != size {
			t.Fatalf("size %d: read %d bytes, %v", size, len(got), err)
		}
	}
	os.Remove(path)
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(64 << 20); err != nil {
		t.Fatal(err)
	}
	f.Close()
	for _, max := range []int{16, stackLockMaxBytes} {
		if got, err := readLockFile(path, max); err != nil || len(got) != max+1 {
			t.Fatalf("sparse file with cap %d: read %d bytes, %v", max, len(got), err)
		}
	}
}

func TestStackLockOversizeFileIsStale(t *testing.T) {
	b := fixture(t)
	b.lockCfg = lockConfig{stale: 3 * time.Millisecond, poll: time.Millisecond, maxBytes: 16}
	b.sleep = func(time.Duration) {}
	os.WriteFile(lockPathOf(b), bytes.Repeat([]byte("a"), 100), 0644)
	l, err := b.acquireStackLock(context.Background())
	if err != nil {
		t.Fatalf("oversize unchanged file not broken: %v", err)
	}
	l.releaseLock()
}

func TestStackLockComparesOnlyTheCappedPrefix(t *testing.T) {
	for _, at := range []int{90, 3} {
		b := fixture(t)
		b.lockCfg = lockConfig{stale: 3 * time.Millisecond, poll: time.Millisecond, maxBytes: 16}
		path := lockPathOf(b)
		os.WriteFile(path, bytes.Repeat([]byte("a"), 100), 0644)
		b.sleep = func(time.Duration) {
			changed := bytes.Repeat([]byte("a"), 100)
			changed[at] = 'b'
			os.WriteFile(path, changed, 0644)
		}
		l, err := b.acquireStackLock(context.Background())
		if at == 90 && err != nil {
			t.Fatalf("a change past the cap counted as a beat: %v", err)
		}
		if at == 3 && err == nil {
			t.Fatal("a change inside the cap was not seen as a beat")
		}
		if l != nil {
			l.releaseLock()
		}
	}
}

func TestStackLockBeatRecreatesAbsentFile(t *testing.T) {
	b := fixture(t)
	b.lockCfg.beat = time.Hour
	l, err := b.acquireStackLock(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer l.releaseLock()
	os.Remove(lockPathOf(b))
	if got := l.beat(); got != "ok" || l.isLost() {
		t.Fatalf("absent file: %s lost=%v", got, l.isLost())
	}
	data, _ := os.ReadFile(lockPathOf(b))
	var record lockRecord
	if json.Unmarshal(data, &record) != nil || record.Token != l.token || record.Seq != 2 {
		t.Fatalf("record not re-created as ours with seq 2: %q", data)
	}
}

// A re-create that fails (EEXIST in production, a failing write here: both come back as one error) is a
// failed beat, never a loss; what the next beat reads decides.
func TestStackLockFailedRecreateIsAFailedBeat(t *testing.T) {
	for _, mode := range []string{"foreign", "own"} {
		t.Run(mode, func(t *testing.T) {
			b := fixture(t)
			b.lockCfg.beat = time.Hour
			failWrites := false
			b.lockCfg.write = func(f *os.File, data []byte) error {
				if failWrites {
					return errors.New("name taken")
				}
				_, err := f.Write(data)
				return err
			}
			l, err := b.acquireStackLock(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			defer l.releaseLock()
			os.Remove(lockPathOf(b))
			failWrites = true
			if got := l.beat(); got != "error" || l.isLost() {
				t.Fatalf("failed re-create: %s lost=%v", got, l.isLost())
			}
			failWrites = false
			if mode == "foreign" {
				os.WriteFile(lockPathOf(b), rawRecord(randomHex(t), "updater", 5), 0644)
				if got := l.beat(); got != "lost" || !l.isLost() {
					t.Fatalf("foreign record: %s", got)
				}
				return
			}
			os.WriteFile(lockPathOf(b), rawRecord(l.token, "extension", 1), 0644)
			if got := l.beat(); got != "ok" || l.isLost() {
				t.Fatalf("own restored record: %s lost=%v", got, l.isLost())
			}
		})
	}
}

func TestStackLockBeatAfterReleaseNeverRecreates(t *testing.T) {
	b := fixture(t)
	b.lockCfg.beat = time.Hour
	l, err := b.acquireStackLock(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	l.releaseLock()
	if lockExists(b) {
		t.Fatal("release left the lock")
	}
	if got := l.beat(); got != "lost" || lockExists(b) {
		t.Fatalf("beat after release: %s, file exists=%v", got, lockExists(b))
	}
}

func TestStackLockTombRemovalFailureAfterEqualReadIsNotBusy(t *testing.T) {
	b := fixture(t)
	b.lockCfg = lockConfig{stale: 3 * time.Millisecond, poll: time.Millisecond}
	b.sleep = func(time.Duration) {}
	b.lockCfg.remove = func(path string) error {
		if strings.Contains(path, ".stale.") {
			return os.ErrPermission
		}
		return os.Remove(path)
	}
	path := lockPathOf(b)
	os.WriteFile(path, rawRecord(randomHex(t), "updater", 1), 0644)
	l, err := b.acquireStackLock(context.Background())
	if err != nil {
		t.Fatalf("a successful break was reported busy: %v", err)
	}
	defer l.releaseLock()
	if tombs, _ := filepath.Glob(path + ".stale.*"); len(tombs) != 1 {
		t.Fatalf("expected the tomb left behind, got %v", tombs)
	}
}
