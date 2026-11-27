package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// Wire contract with the updater: this lives INSIDE the install's shared mount.
const unconfirmedName = ".haive-extension-unconfirmed"

var errUnconfirmed = errors.New("An unconfirmed host command blocks this install. Inspect host processes, status, the operation log and updater journal before removing the unconfirmed marker manually.")

type commandOutcome struct {
	cause error
	group int
}

func (e *commandOutcome) Error() string { return e.cause.Error() }
func (e *commandOutcome) Unwrap() error { return e.cause }

type unconfirmedRecord struct {
	OS        string `json:"os"`
	PGID      int    `json:"pgid"`
	Operation string `json:"operation"`
	Time      string `json:"time"`
}

func (b bridge) unconfirmedPath() string { return filepath.Join(b.dir, unconfirmedName) }

// Called inside the runner, before either lease's release defer can run.
func (b bridge) markUnconfirmed(action string, cause error) error {
	var outcome *commandOutcome
	group := 0
	if errors.As(cause, &outcome) {
		group = outcome.group
	}
	data, _ := json.Marshal(unconfirmedRecord{b.os, group, action, time.Now().UTC().Format(time.RFC3339Nano)})
	// Install may fail before it creates the directory. Retain a partial install
	// rather than putting the refusal outside the updater's shared mount.
	if err := os.MkdirAll(b.dir, 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(b.dir, ".unconfirmed-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	defer f.Close()
	if _, err = f.Write(append(data, '\n')); err != nil {
		return err
	}
	if err = f.Sync(); err != nil {
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	if err := os.Rename(f.Name(), b.unconfirmedPath()); err != nil {
		return err
	}
	return syncMarkerDirectory(b.dir)
}

// Status reports without clearing. Only a mutating Unix request can prove ESRCH
// and clear a same-OS pgid; malformed/unknown markers always refuse.
func (b bridge) checkUnconfirmed(clear bool) error {
	path := b.unconfirmedPath()
	data, err := readLockFile(path, stackLockMaxBytes)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if clear && err == nil {
		var record unconfirmedRecord
		if json.Unmarshal(data, &record) == nil && record.OS == b.os && commandGroupGone(record.PGID) {
			if err := os.Remove(path); err == nil || errors.Is(err, os.ErrNotExist) {
				return nil
			}
		}
	}
	return fmt.Errorf("%w Marker: %s", errUnconfirmed, path)
}
