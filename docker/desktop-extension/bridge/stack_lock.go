package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Wire contract shared with the updater (packages/updater/src/stack-lock.ts):
// file name and timings must match it.
const stackLockName = ".haive-stack-lock"
const stackLockBeatMs = 5000
const stackLockStaleMs = 60000
const stackLockPollMs = 1000
const stackLockRounds = 3

const windowsLockReleaseTries = 4
const lockReleasePause = 50 * time.Millisecond

const upgradeActiveMessage = "An upgrade is running for this Haive Desktop install. Install, Start and Stop are refused to protect its database backup. Wait for the upgrade to finish, then refresh status. If the updater is hung, stop that updater container in Docker Desktop, then check the upgrade state before retrying."
const extensionBusyMessage = "Another Haive Desktop operation holds the install lock. Wait for it to finish, then refresh status. If it was interrupted, the lock clears itself about a minute after its last sign of life."

// Zero values select the wire-contract defaults; the fields exist for tests.
type lockConfig struct {
	beat, stale, poll time.Duration
	rounds            int
	releaseTries      int
	releasePause      time.Duration
	remove            func(string) error
	beforeBreak       func()
	write             func(*os.File, []byte) error
}

type lockRecord struct {
	V         int    `json:"v"`
	Token     string `json:"token"`
	Holder    string `json:"holder"`
	StartedAt string `json:"startedAt"`
	Seq       int    `json:"seq"`
}

func encodeLockRecord(token, startedAt string, seq int) []byte {
	data, _ := json.Marshal(lockRecord{V: 1, Token: token, Holder: "extension", StartedAt: startedAt, Seq: seq})
	return append(data, '\n')
}

// The holder name only selects a message; it is never shown.
func decodeLockRecord(data []byte) (token, holder string) {
	var fields map[string]any
	if json.Unmarshal(data, &fields) != nil {
		return "", ""
	}
	token, _ = fields["token"].(string)
	holder, _ = fields["holder"].(string)
	return token, holder
}

func (c lockConfig) resolved() lockConfig {
	if c.beat <= 0 {
		c.beat = stackLockBeatMs * time.Millisecond
	}
	if c.stale == 0 {
		c.stale = stackLockStaleMs * time.Millisecond
	}
	if c.poll == 0 {
		c.poll = stackLockPollMs * time.Millisecond
	}
	if c.poll < time.Millisecond {
		c.poll = time.Millisecond
	}
	if c.rounds == 0 {
		c.rounds = stackLockRounds
	}
	if c.releasePause <= 0 {
		c.releasePause = lockReleasePause
	}
	if c.remove == nil {
		c.remove = os.Remove
	}
	if c.write == nil {
		c.write = func(f *os.File, data []byte) error { _, err := f.Write(data); return err }
	}
	return c
}

// A non-regular entry is refused, never followed or deleted.
func readLockFile(path string) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, errLockNotRegular
	}
	f, err := os.OpenFile(path, os.O_RDONLY|noFollow, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(f)
}

var errLockNotRegular = errors.New("not a regular file")

func createLockFile(path string, data []byte, write func(*os.File, []byte) error) error {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY|noFollow, 0644)
	if err != nil {
		return err
	}
	err = f.Chmod(0644)
	if err == nil {
		err = write(f, data)
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		os.Remove(path)
	}
	return err
}

type stackLock struct {
	path      string
	token     string
	startedAt string
	cfg       lockConfig
	b         bridge

	mu      sync.Mutex
	seq     int
	lost    bool
	failing bool

	stop    chan struct{}
	done    chan struct{}
	release sync.Once
}

func (l *stackLock) isLost() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.lost
}

// A failed write can leave our own record empty or partial: while a failure
// streak is open that is not a loss. Without a streak it is.
func (l *stackLock) beat() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.lost {
		return "lost"
	}
	current, err := readLockFile(l.path)
	if errors.Is(err, fs.ErrNotExist) {
		l.lost = true
		return "lost"
	}
	if err != nil {
		l.failing = true
		return "error"
	}
	token, _ := decodeLockRecord(current)
	if token != l.token && !(l.failing && !json.Valid(current)) {
		l.lost = true
		return "lost"
	}
	f, err := os.OpenFile(l.path, os.O_WRONLY|os.O_TRUNC|noFollow, 0)
	if err == nil {
		err = l.cfg.write(f, encodeLockRecord(l.token, l.startedAt, l.seq+1))
		if closeErr := f.Close(); err == nil {
			err = closeErr
		}
	}
	if err != nil {
		l.failing = true
		return "error"
	}
	l.seq++
	l.failing = false
	return "ok"
}

func (l *stackLock) heartbeat() {
	defer close(l.done)
	ticker := time.NewTicker(l.cfg.beat)
	defer ticker.Stop()
	for {
		select {
		case <-l.stop:
			return
		case <-ticker.C:
			if l.beat() == "lost" {
				return
			}
		}
	}
}

// Every caller shares the one release in progress. A failed removal leaves a
// lock that stale recovery clears, and never fails the caller.
func (l *stackLock) releaseLock() {
	l.release.Do(func() {
		close(l.stop)
		<-l.done
		l.mu.Lock()
		defer l.mu.Unlock()
		if l.lost {
			return
		}
		tries := l.cfg.releaseTries
		if tries <= 0 {
			tries = 1
			if l.b.os == "windows" {
				tries = windowsLockReleaseTries
			}
		}
		sleep := l.b.sleep
		if sleep == nil {
			sleep = time.Sleep
		}
		for attempt := 1; attempt <= tries; attempt++ {
			if l.removeOwn() {
				return
			}
			if attempt < tries {
				sleep(l.cfg.releasePause)
			}
		}
	})
}

func (l *stackLock) removeOwn() bool {
	current, err := readLockFile(l.path)
	if errors.Is(err, fs.ErrNotExist) {
		return true
	}
	if err != nil {
		return false
	}
	if token, _ := decodeLockRecord(current); token != l.token {
		return true
	}
	err = l.cfg.remove(l.path)
	return err == nil || errors.Is(err, fs.ErrNotExist)
}

func lockUnavailable(path string) error {
	return errors.New("Cannot use the install lock " + path + ". Check this install's containers in Docker Desktop before removing it, then retry.")
}

func lockBusy(path, holder string) error {
	switch holder {
	case "updater":
		return errors.New(upgradeActiveMessage)
	case "extension":
		return errors.New(extensionBusyMessage)
	}
	return lockUnavailable(path)
}

// takeStackLock serialises Start and Stop with the updater for the whole call.
func (b bridge) takeStackLock(ctx context.Context) (func(), error) {
	l, err := b.acquireStackLock(ctx)
	if err != nil {
		return nil, err
	}
	return l.releaseLock, nil
}

func (b bridge) acquireStackLock(ctx context.Context) (*stackLock, error) {
	cfg := b.lockCfg.resolved()
	path := filepath.Join(b.dir, stackLockName)
	sleep := b.sleep
	if sleep == nil {
		sleep = time.Sleep
	}
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return nil, lockUnavailable(path)
	}
	token := hex.EncodeToString(raw)
	startedAt := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	busy := lockUnavailable(path)

	for round := 0; round < cfg.rounds; round++ {
		err := createLockFile(path, encodeLockRecord(token, startedAt, 1), cfg.write)
		if err == nil {
			l := &stackLock{path: path, token: token, startedAt: startedAt, cfg: cfg, b: b, seq: 1,
				stop: make(chan struct{}), done: make(chan struct{})}
			go l.heartbeat()
			return l, nil
		}
		if !errors.Is(err, fs.ErrExist) {
			return nil, lockUnavailable(path)
		}

		first, err := readLockFile(path)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, lockUnavailable(path)
		}
		_, holder := decodeLockRecord(first)
		busy = lockBusy(path, holder)

		verdict := "stale"
		for waited := time.Duration(0); waited < cfg.stale; {
			if ctx.Err() != nil {
				return nil, errors.New("The operation was cancelled while waiting for the install lock.")
			}
			sleep(cfg.poll)
			waited += cfg.poll
			now, err := readLockFile(path)
			if errors.Is(err, fs.ErrNotExist) {
				verdict = "free"
				break
			}
			if err != nil {
				return nil, lockUnavailable(path)
			}
			if !bytes.Equal(now, first) {
				verdict = "live"
				break
			}
		}
		switch verdict {
		case "free":
			continue
		case "live":
			return nil, busy
		}
		if !b.breakStale(path, first, cfg) {
			return nil, busy
		}
	}
	return nil, busy
}

// Tombstone by rename so exactly one breaker wins, then verify what was displaced.
func (b bridge) breakStale(path string, expected []byte, cfg lockConfig) bool {
	if cfg.beforeBreak != nil {
		cfg.beforeBreak()
	}
	rename := b.rename
	if rename == nil {
		rename = os.Rename
	}
	suffix := make([]byte, 4)
	if _, err := rand.Read(suffix); err != nil {
		return false
	}
	tomb := path + ".stale." + hex.EncodeToString(suffix)
	if err := rename(path, tomb); err != nil {
		return errors.Is(err, fs.ErrNotExist)
	}
	displaced, err := readLockFile(tomb)
	if err != nil {
		return false
	}
	if bytes.Equal(displaced, expected) {
		return cfg.remove(tomb) == nil
	}
	// A holder beat or re-acquired between our last read and the rename: give its lock back.
	createLockFile(path, displaced, cfg.write)
	cfg.remove(tomb)
	return false
}
