// The host bridge delegates installation to the unmodified RUN-IT installers.
// It runs as the Desktop user, owns no second compose definition, and never upgrades.
package main

import (
	"context"
	"embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"syscall"
	"time"
)

// Copied from install/ by the build script; no generated or forked installer.
//
//go:embed install/install.sh install/install.ps1
var installers embed.FS

const installID = "haive_desktop"
const consent = "accept-host-root"

var versionPattern = regexp.MustCompile(`^(latest|next|v?[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?)$`)
var pinnedPattern = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$`)
var portPattern = regexp.MustCompile(`^[0-9]{1,5}$`)

type request struct {
	Action  string `json:"action"`
	Version string `json:"version"`
	Consent string `json:"consent"`
	Engine  string `json:"engine"`
}

type state struct {
	Installed bool            `json:"installed"`
	Directory string          `json:"directory"`
	Version   string          `json:"version,omitempty"`
	AppURL    string          `json:"appUrl,omitempty"`
	Healthy   bool            `json:"healthy"`
	Services  json.RawMessage `json:"services,omitempty"`
	Error     string          `json:"error,omitempty"`
}

type runner func(context.Context, string, []string, string, io.Writer) (string, error)

type bridge struct {
	dir    string
	os     string
	run    runner
	health func(string) bool
}

func validateRequest(r request) error {
	switch r.Action {
	case "status", "stop":
	case "install", "start":
		if r.Consent != consent {
			return errors.New("Accept the Docker socket disclosure before installing or starting Haive.")
		}
	default:
		return errors.New("Unknown action.")
	}
	if r.Action == "install" && !versionPattern.MatchString(r.Version) {
		return errors.New("Choose latest, next, or an exact release such as 0.2.0.")
	}
	if r.Engine == "" || len(r.Engine) > 128 || strings.ContainsAny(r.Engine, "\r\n\x00") {
		return errors.New("Docker Desktop engine identity is missing.")
	}
	return nil
}

func regular(path string) error {
	f, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !f.Mode().IsRegular() {
		return errors.New("Install files must be regular files, without symbolic links.")
	}
	return nil
}

// Read only the non-secret settings needed by the extension. Never source .env.
func (b bridge) settings() (map[string]string, error) {
	if err := regular(filepath.Join(b.dir, ".env")); err != nil {
		return nil, err
	}
	data, err := os.ReadFile(filepath.Join(b.dir, ".env"))
	if err != nil {
		return nil, err
	}
	m := map[string]string{}
	for _, line := range strings.Split(string(data), "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(line), "=")
		if ok {
			switch k {
			case "HAIVE_INSTALL_ID", "COMPOSE_PROJECT_NAME", "HAIVE_VERSION", "HAIVE_WEB_PORT", "HAIVE_API_PORT":
				m[k] = strings.Trim(v, "\r")
			}
		}
	}
	if m["HAIVE_INSTALL_ID"] != installID || m["COMPOSE_PROJECT_NAME"] != installID {
		return nil, errors.New("This directory belongs to another install; refusing to adopt it.")
	}
	if !pinnedPattern.MatchString(m["HAIVE_VERSION"]) {
		return nil, errors.New("The installed release must be pinned to an exact version.")
	}
	for _, key := range []string{"HAIVE_WEB_PORT", "HAIVE_API_PORT"} {
		var port int
		if !portPattern.MatchString(m[key]) {
			return nil, errors.New("Invalid installed port.")
		}
		fmt.Sscan(m[key], &port)
		if port < 1 || port > 65535 {
			return nil, errors.New("Invalid installed port.")
		}
	}
	return m, nil
}

func (b bridge) composeArgs(action ...string) ([]string, error) {
	a := []string{"compose", "--project-directory", b.dir, "--env-file", filepath.Join(b.dir, ".env"), "-p", installID}
	for i, name := range []string{"docker-compose.yml", "docker-compose.run.yml", "docker-compose.gpu.yml", "docker-compose.vulkan.yml"} {
		path := filepath.Join(b.dir, name)
		err := regular(path)
		if i >= 2 && errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, errors.New("The installed compose bundle is incomplete or linked. Restore its regular files before starting.")
		}
		a = append(a, "-f", path)
		// Match the updater's overlay precedence; never enable two GPU overlays.
		if i == 2 {
			break
		}
	}
	return append(a, action...), nil
}

// Old releases predate per-install names. Refuse their resolved bundle rather
// than let a Desktop install adopt a co-resident Haive's volumes or containers.
// This is a read-only Compose query; its output includes secrets and stays here.
func (b bridge) checkBundle(ctx context.Context) error {
	args, err := b.composeArgs("config", "--format", "json")
	if err != nil {
		return err
	}
	out, err := b.run(ctx, "docker", args, b.dir, nil)
	if err != nil {
		return errors.New("Cannot resolve the installed bundle. Docker Compose 2.24 or later is required.")
	}
	if err := isolatedBundle([]byte(out)); err != nil {
		return err
	}
	return nil
}

func isolatedBundle(data []byte) error {
	var model struct {
		Services map[string]struct {
			ContainerName string          `json:"container_name"`
			Build         json.RawMessage `json:"build"`
			Image         string          `json:"image"`
			Profiles      []string        `json:"profiles"`
		}
		Volumes  map[string]struct{ Name string }
		Networks map[string]struct{ Name string }
	}
	refusal := errors.New("This release bundle does not support isolated published installs. Choose a newer release; no containers were changed.")
	if json.Unmarshal(data, &model) != nil || len(model.Services) == 0 {
		return refusal
	}
	for _, service := range model.Services {
		if len(service.Profiles) != 0 {
			continue
		}
		if !strings.HasPrefix(service.ContainerName, installID+"-") || service.Image == "" || (len(service.Build) > 0 && string(service.Build) != "null") {
			return refusal
		}
	}
	for _, volume := range model.Volumes {
		if !strings.HasPrefix(volume.Name, installID+"_") {
			return refusal
		}
	}
	for _, network := range model.Networks {
		if !strings.HasPrefix(network.Name, installID+"-") {
			return refusal
		}
	}
	return nil
}

func (b bridge) inspect(ctx context.Context) (state, error) {
	s := state{Directory: b.dir}
	_, err := os.Lstat(filepath.Join(b.dir, ".env"))
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	m, err := b.settings()
	if err != nil {
		return s, err
	}
	args, err := b.composeArgs("ps", "--all", "--format", "json")
	if err != nil {
		return s, err
	}
	s.Installed, s.Version = true, m["HAIVE_VERSION"]
	s.AppURL = "http://localhost:" + m["HAIVE_WEB_PORT"]
	out, err := b.run(ctx, "docker", args, b.dir, nil)
	if err != nil {
		return s, errors.New("Cannot read this install's Compose status. Check Docker Desktop and the installed bundle.")
	}
	// Compose emits either an array or one JSON object per line, depending on version.
	var services []json.RawMessage
	out = strings.TrimSpace(out)
	if strings.HasPrefix(out, "[") {
		err = json.Unmarshal([]byte(out), &services)
	} else {
		for _, line := range strings.Split(out, "\n") {
			if strings.TrimSpace(line) != "" {
				if !json.Valid([]byte(line)) {
					err = errors.New("invalid JSON")
					break
				}
				services = append(services, json.RawMessage(line))
			}
		}
	}
	if err != nil {
		return s, errors.New("Compose returned unreadable status.")
	}
	s.Services, _ = json.Marshal(services)
	// Do not probe a localhost port unless this project's API container is running.
	webRunning := false
	for _, raw := range services {
		var service struct {
			Service string
			State   string
		}
		if json.Unmarshal(raw, &service) == nil && service.Service == "api" && service.State == "running" {
			s.Healthy = b.health("http://localhost:" + m["HAIVE_API_PORT"] + "/health")
		}
		if service.Service == "web" && service.State == "running" {
			webRunning = true
		}
	}
	s.Healthy = s.Healthy && webRunning
	return s, nil
}

func (b bridge) installRecovery(reason string) error {
	return fmt.Errorf("%s Remove the folder %q, then install again.", reason, b.dir)
}

func (b bridge) install(ctx context.Context, version string, log io.Writer) error {
	if _, err := os.Lstat(filepath.Join(b.dir, ".env")); !errors.Is(err, os.ErrNotExist) {
		return errors.New("An install already exists. Use Start or the app's Upgrade page; installation never upgrades.")
	}
	scratch, err := os.MkdirTemp("", "hde-installer-")
	if err != nil {
		return errors.New("Cannot prepare the bundled installer.")
	}
	defer os.RemoveAll(scratch)
	name, exe := "install.sh", "sh"
	args := []string{}
	if b.os == "windows" {
		name, exe = "install.ps1", "powershell.exe"
		args = []string{"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"}
	}
	data, err := installers.ReadFile("install/" + name)
	if err != nil {
		return err
	}
	path := filepath.Join(scratch, name)
	if err := os.WriteFile(path, data, 0600); err != nil {
		return err
	}
	args = append(args, path)
	if b.os == "windows" {
		args = append(args, "-Version", version, "-Dir", b.dir, "-InstallId", installID, "-NoStart")
	} else {
		args = append(args, "--version", version, "--dir", b.dir, "--install-id", installID, "--no-start")
	}
	_, err = b.run(ctx, exe, args, "", log)
	if err != nil {
		return b.installRecovery("The installer failed. See the private operation log and fix the reported prerequisite or release error.")
	}
	return nil
}

func (b bridge) handle(ctx context.Context, r request) (s state, err error) {
	s.Directory = b.dir
	if err = validateRequest(r); err != nil {
		return s, err
	}
	engine, err := b.run(ctx, "docker", []string{"info", "--format", "{{.ID}}"}, "", nil)
	if err != nil || strings.TrimSpace(engine) != r.Engine {
		return s, errors.New("The host Docker CLI must point to the same engine as Docker Desktop. Select its context, then retry.")
	}
	if r.Action == "status" {
		return b.inspect(ctx)
	}
	// Cross-process exclusion also protects against two open Desktop windows.
	lock := b.dir + ".extension-lock"
	if err := os.Mkdir(lock, 0700); err != nil {
		return s, errors.New("Another operation is active. If Desktop closed during an operation, check its containers before removing " + lock)
	}
	defer os.Remove(lock)
	logPath := b.dir + ".extension.log"
	if info, e := os.Lstat(logPath); e == nil && !info.Mode().IsRegular() {
		return s, errors.New("The operation log must be a regular file.")
	}
	log, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
	if err != nil {
		return s, errors.New("Cannot create the private operation log.")
	}
	defer log.Close()
	if err := log.Chmod(0600); err != nil {
		return s, err
	}
	if r.Action == "install" {
		err = b.install(ctx, r.Version, log)
		if err != nil {
			return s, err
		}
		// Only a fresh install may be told to remove its folder: on Start the folder
		// holds an established install's secrets and data.
		if err = b.checkBundle(ctx); err != nil {
			return s, b.installRecovery(err.Error())
		}
		return b.inspect(ctx)
	}
	if _, err = b.settings(); err != nil {
		return s, errors.New("No complete Haive Desktop install was found. Refresh status before continuing.")
	}
	action := []string{"stop"} // Keep containers, network and every data volume.
	if r.Action == "start" {
		if err = b.checkBundle(ctx); err != nil {
			return s, err
		}
		action = []string{"up", "-d", "--no-build", "--wait", "--wait-timeout", "360"}
	}
	args, err := b.composeArgs(action...)
	if err != nil {
		return s, err
	}
	if _, err = b.run(ctx, "docker", args, b.dir, log); err != nil {
		return s, errors.New("Compose failed. Open service logs in Docker Desktop, or read " + logPath + ", then retry.")
	}
	return b.inspect(ctx)
}

func runCommand(ctx context.Context, exe string, args []string, dir string, log io.Writer) (string, error) {
	cmd := exec.CommandContext(ctx, exe, args...)
	cmd.Dir = dir
	// Ambient Haive settings must not override the install's pinned .env, and a
	// registry token must never reach an unrelated child. Keep Docker context/PATH.
	for _, e := range os.Environ() {
		key, _, _ := strings.Cut(e, "=")
		key = strings.ToUpper(key) // Windows environment names are case-insensitive.
		if !strings.HasPrefix(key, "HAIVE_") && !strings.HasPrefix(key, "COMPOSE_") && key != "CONFIG_ENCRYPTION_KEY" && key != "JWT_SECRET" && !strings.HasPrefix(key, "POSTGRES_") && key != "HOST_REPO_ROOT" && key != "MAILPIT_UI_PASSWORD" {
			cmd.Env = append(cmd.Env, e)
		}
	}
	if log != nil {
		cmd.Stdout, cmd.Stderr = log, log
		return "", cmd.Run()
	}
	var out strings.Builder
	cmd.Stdout = &out
	// Errors are reported by operation, never with raw third-party output or .env.
	err := cmd.Run()
	return out.String(), err
}

// The request arrives as one base64url argument (no padding). Docker Desktop's
// host exec reaches Windows binaries through a command line that strips the
// double quotes of a raw JSON argument, so the payload uses quote-free
// characters on every platform.
func decodeRequest(args []string) (request, error) {
	var r request
	if len(args) != 1 {
		return r, errors.New("expected one argument")
	}
	raw, err := base64.RawURLEncoding.DecodeString(args[0])
	if err != nil {
		return r, err
	}
	return r, json.Unmarshal(raw, &r)
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, 30*time.Minute)
	defer cancel()
	r, err := decodeRequest(os.Args[1:])
	if err != nil {
		fmt.Println(`{"error":"Expected one JSON request."}`)
		os.Exit(1)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		fmt.Println(`{"error":"Cannot locate the host user home directory."}`)
		os.Exit(1)
	}
	b := bridge{dir: filepath.Join(home, installID), os: runtime.GOOS, run: runCommand, health: func(url string) bool {
		client := http.Client{Timeout: 3 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
		res, err := client.Get(url)
		if err != nil {
			return false
		}
		res.Body.Close()
		return res.StatusCode == 200
	}}
	s, err := b.handle(ctx, r)
	if err != nil {
		s.Error = err.Error()
	}
	json.NewEncoder(os.Stdout).Encode(s)
	if err != nil {
		os.Exit(1)
	}
}
