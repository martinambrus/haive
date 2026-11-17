package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"
	"text/template"
	"time"
)

func fixture(t *testing.T) bridge {
	t.Helper()
	dir := filepath.Join(t.TempDir(), installID)
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	for name, data := range map[string]string{
		".env":               "HAIVE_INSTALL_ID=" + installID + "\nCOMPOSE_PROJECT_NAME=" + installID + "\nHAIVE_VERSION=1.2.3\nHAIVE_WEB_PORT=3010\nHAIVE_API_PORT=3011\nHAIVE_MAILPIT_PORT=8025\n",
		"docker-compose.yml": "services: {}", "docker-compose.run.yml": "services: {}",
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
	}
	return bridge{dir: dir, os: "linux", portInUse: func(int) bool { return false }, health: func(string) bool { return true }, run: func(_ context.Context, _ string, args []string, _ string, _ io.Writer) (string, error) {
		if args[0] == "ps" || (args[0] == "container" && args[1] == "ls") {
			return "", nil
		}
		if reflect.DeepEqual(args, []string{"info", "--format", "{{.ID}}"}) {
			return "desktop-engine\n", nil
		}
		if strings.HasSuffix(strings.Join(args, " "), "config --format json") {
			return `{"services":{"api":{"container_name":"haive_desktop-api","image":"example/api:1.2.3"}},"volumes":{"postgres":{"name":"haive_desktop_postgres_data"}},"networks":{"default":{"name":"haive_desktop-network"}}}`, nil
		}
		return "{\"Service\":\"api\",\"State\":\"running\"}\n{\"Service\":\"web\",\"State\":\"running\"}", nil
	}}
}

func TestConsentAndVersionInputs(t *testing.T) {
	for _, action := range []string{"install", "start"} {
		r := request{Action: action, Version: "latest", Engine: "desktop-engine"}
		if validateRequest(r) == nil {
			t.Fatal("missing consent accepted")
		}
		r.Consent = consent
		if err := validateRequest(r); err != nil {
			t.Fatal(err)
		}
	}
	for _, version := range []string{"latest", "next", "0.2.0", "v1.2.3", "1.2.3-rc.1"} {
		if err := validateRequest(request{Action: "install", Version: version, Consent: consent, Engine: "engine"}); err != nil {
			t.Fatal(version, err)
		}
	}
	for _, version := range []string{"", "main", "--force", "1.2", "../../x", "$(touch x)", "1.2.3\n", "1.2.3/evil"} {
		if validateRequest(request{Action: "install", Version: version, Consent: consent, Engine: "engine"}) == nil {
			t.Fatal("unsafe version", version)
		}
	}
}

// Proves the bridge writes the embedded bytes unchanged and selects the right argv.
// It does not compare the embed with checkout install/: build-desktop-extension.sh
// supplies that identity by copying those files into the allowlisted build context.
func TestInstallerDelegation(t *testing.T) {
	for _, platform := range []string{"linux", "darwin", "windows"} {
		t.Run(platform, func(t *testing.T) {
			b := fixture(t)
			os.Remove(filepath.Join(b.dir, ".env"))
			b.os = platform
			var scriptPath string
			b.run = func(_ context.Context, exe string, args []string, _ string, _ io.Writer) (string, error) {
				index, name, expectedExe := 0, "install.sh", "sh"
				if platform == "windows" {
					index, name, expectedExe = 5, "install.ps1", "powershell.exe"
				}
				if exe != expectedExe {
					t.Fatalf("wrong interpreter %s", exe)
				}
				scriptPath = args[index]
				actual, err := os.ReadFile(scriptPath)
				if err != nil {
					t.Fatal(err)
				}
				original, _ := installers.ReadFile("install/" + name)
				if string(actual) != string(original) {
					t.Fatal("installer bytes changed")
				}
				expected := []string{"--version", "next", "--dir", b.dir, "--install-id", installID, "--no-start"}
				if platform == "windows" {
					expected = []string{"-Version", "next", "-Dir", b.dir, "-InstallId", installID, "-NoStart"}
				}
				if !reflect.DeepEqual(args[index+1:], expected) {
					t.Fatalf("wrong installer args: %q", args)
				}
				return "", nil
			}
			if err := b.install(context.Background(), "next", io.Discard); err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(scriptPath); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("installer scratch not removed")
			}
		})
	}
}

func TestExistingInstallNeverReinstalled(t *testing.T) {
	b := fixture(t)
	b.run = func(context.Context, string, []string, string, io.Writer) (string, error) {
		t.Fatal("installer invoked")
		return "", nil
	}
	if err := b.install(context.Background(), "2.0.0", io.Discard); err == nil {
		t.Fatal("reinstall accepted")
	}
}

func TestComposeUsesOnlyInstalledBundleAndOverlayPrecedence(t *testing.T) {
	b := fixture(t)
	args, err := b.composeArgs("up", "-d")
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "--env-file "+filepath.Join(b.dir, ".env")) || !strings.Contains(joined, "-p "+installID) {
		t.Fatal(args)
	}
	if strings.Contains(joined, "gpu") || strings.Contains(joined, "vulkan") || strings.Contains(joined, "dev.yml") {
		t.Fatal(args)
	}
	for _, name := range []string{"docker-compose.vulkan.yml", "docker-compose.gpu.yml"} {
		os.WriteFile(filepath.Join(b.dir, name), []byte("services: {}"), 0600)
		args, err = b.composeArgs("up", "-d")
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(strings.Join(args, " "), name) {
			t.Fatal("installed overlay omitted", args)
		}
	}
	if strings.Contains(strings.Join(args, " "), "vulkan") {
		t.Fatal("NVIDIA did not take precedence")
	}
	os.Remove(filepath.Join(b.dir, "docker-compose.run.yml"))
	if _, err := b.composeArgs("up"); err == nil {
		t.Fatal("incomplete bundle accepted")
	}
}

func TestLinkedBundleAndEnvironmentRefused(t *testing.T) {
	for _, name := range []string{".env", "docker-compose.yml", "docker-compose.gpu.yml"} {
		t.Run(name, func(t *testing.T) {
			b := fixture(t)
			os.Remove(filepath.Join(b.dir, name))
			if err := os.Symlink(filepath.Join(b.dir, "docker-compose.run.yml"), filepath.Join(b.dir, name)); err != nil {
				t.Fatal(err)
			}
			if _, err := b.inspect(context.Background()); err == nil {
				t.Fatal("linked install file accepted")
			}
		})
	}
}

func TestIdentityAndPinnedSettings(t *testing.T) {
	for _, replacement := range []struct{ from, to string }{
		{"HAIVE_INSTALL_ID=haive_desktop", "HAIVE_INSTALL_ID=haive"},
		{"COMPOSE_PROJECT_NAME=haive_desktop", "COMPOSE_PROJECT_NAME=haive"},
		{"HAIVE_VERSION=1.2.3", "HAIVE_VERSION=latest"},
		{"HAIVE_API_PORT=3011", "HAIVE_API_PORT=99999"},
	} {
		b := fixture(t)
		path := filepath.Join(b.dir, ".env")
		data, _ := os.ReadFile(path)
		os.WriteFile(path, []byte(strings.ReplaceAll(string(data), replacement.from, replacement.to)), 0600)
		if _, err := b.settings(); err == nil {
			t.Fatal("invalid settings accepted", replacement)
		}
	}
}

func TestStatusFormatsAndHealthGating(t *testing.T) {
	for _, tc := range []struct {
		name, output                     string
		probeOK, wantProbed, wantHealthy bool
	}{
		{"array", `[{"Service":"api","State":"running"},{"Service":"web","State":"running"}]`, true, true, true},
		{"ndjson", "{\"Service\":\"api\",\"State\":\"running\"}\n{\"Service\":\"web\",\"State\":\"running\"}\n", true, true, true},
		{"empty", "", true, false, false},
		{"empty array", `[]`, true, false, false},
		{"exited api", `{"Service":"api","State":"exited"}`, true, false, false},
		{"api only", `{"Service":"api","State":"running"}`, true, true, false},
		{"web only", `{"Service":"web","State":"running"}`, true, true, false},
		{"exited web", `[{"Service":"api","State":"running"},{"Service":"web","State":"exited"}]`, true, true, false},
		{"failed health", `[{"Service":"api","State":"running"},{"Service":"web","State":"running"}]`, false, true, false},
	} {
		b := fixture(t)
		base := b.run
		b.run = func(ctx context.Context, exe string, args []string, dir string, log io.Writer) (string, error) {
			if strings.HasSuffix(strings.Join(args, " "), "config --format json") {
				return base(ctx, exe, args, dir, log)
			}
			return tc.output, nil
		}
		probed := false
		b.health = func(url string) bool {
			probed = true
			if url != "http://localhost:3011/health" && url != "http://localhost:3010" {
				t.Fatal(url)
			}
			return tc.probeOK
		}
		s, err := b.inspect(context.Background())
		if err != nil {
			t.Fatal(tc.name, err)
		}
		if s.Healthy != tc.wantHealthy || probed != tc.wantProbed {
			t.Fatalf("%s: healthy=%v probed=%v; want healthy=%v probed=%v", tc.name, s.Healthy, probed, tc.wantHealthy, tc.wantProbed)
		}
		if s.AppURL != "http://localhost:3010" || s.Version != "1.2.3" {
			t.Fatal(s)
		}
		if _, err := json.Marshal(s); err != nil {
			t.Fatal(err)
		}
	}
}

func TestMutationFenceAndStopKeepsAllData(t *testing.T) {
	b := fixture(t)
	base := b.run
	var called []string
	b.run = func(ctx context.Context, exe string, args []string, dir string, log io.Writer) (string, error) {
		if log != nil {
			called = append(called, strings.Join(args, " "))
		}
		return base(ctx, exe, args, dir, log)
	}
	if _, err := b.handle(context.Background(), request{Action: "stop", Engine: "different-engine"}); err == nil || len(called) != 0 {
		t.Fatal("engine mismatch mutated")
	}
	if _, err := b.handle(context.Background(), request{Action: "start", Engine: "desktop-engine"}); err == nil || len(called) != 0 {
		t.Fatal("missing consent mutated")
	}
	os.Mkdir(b.dir+".extension-lock", 0700)
	if _, err := b.handle(context.Background(), request{Action: "stop", Engine: "desktop-engine"}); err == nil || len(called) != 0 {
		t.Fatal("parallel mutation allowed")
	}
	os.Remove(b.dir + ".extension-lock")
	if _, err := b.handle(context.Background(), request{Action: "stop", Engine: "desktop-engine"}); err != nil {
		t.Fatal(err)
	}
	if len(called) != 1 || !strings.HasSuffix(called[0], " stop") || strings.Contains(called[0], "down") || strings.Contains(called[0], "-v ") {
		t.Fatal(called)
	}
	if _, err := os.Stat(filepath.Join(b.dir, ".env")); err != nil {
		t.Fatal("stop lost settings")
	}
	if _, err := os.Stat(b.dir + ".extension-lock"); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("lock leaked")
	}
}

func TestStartDoesNotPullMovingRelease(t *testing.T) {
	b := fixture(t)
	base := b.run
	var called []string
	b.run = func(ctx context.Context, exe string, args []string, dir string, log io.Writer) (string, error) {
		if log != nil {
			called = args
		}
		return base(ctx, exe, args, dir, log)
	}
	if _, err := b.handle(context.Background(), request{Action: "start", Consent: consent, Engine: "desktop-engine"}); err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(strings.Join(called, " "), "up -d --no-build --wait --wait-timeout 360") {
		t.Fatal(called)
	}
	if strings.Contains(strings.Join(called, " "), "pull") {
		t.Fatal("start changes cached tag")
	}
}

func TestResolvedBundleRejectsLegacySharedResourcesAndSourceBuilds(t *testing.T) {
	base := `{"services":{"api":{"container_name":"haive_desktop-api","image":"example/api:1.2.3"}},"volumes":{"postgres":{"name":"haive_desktop_postgres_data"}},"networks":{"default":{"name":"haive_desktop-network"}}}`
	if err := isolatedBundle([]byte(base)); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{
		strings.Replace(base, "haive_desktop-api", "haive-api", 1),
		strings.Replace(base, "haive_desktop_postgres_data", "haive_postgres_data", 1),
		strings.Replace(base, "haive_desktop-network", "haive-network", 1),
		strings.Replace(base, `"image":"example/api:1.2.3"`, `"image":"example/api:1.2.3","build":{"context":"."}`, 1),
		`{"services":{}}`,
	} {
		if isolatedBundle([]byte(bad)) == nil {
			t.Fatal("unsafe legacy bundle accepted")
		}
	}
}

func TestInstallFailuresExplainRecovery(t *testing.T) {
	for _, kind := range []string{"installer", "legacy names", "source build", "compose version"} {
		t.Run(kind, func(t *testing.T) {
			b := fixture(t)
			envPath := filepath.Join(b.dir, ".env")
			env, err := os.ReadFile(envPath)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.Remove(envPath); err != nil {
				t.Fatal(err)
			}
			base := b.run
			b.run = func(ctx context.Context, exe string, args []string, dir string, log io.Writer) (string, error) {
				if exe == "sh" {
					if err := os.Mkdir(filepath.Join(b.dir, "snapshots"), 0700); err != nil {
						t.Fatal(err)
					}
					if kind == "installer" {
						return "", errors.New("private installer details")
					}
					return "", os.WriteFile(envPath, env, 0600)
				}
				if strings.HasSuffix(strings.Join(args, " "), "config --format json") {
					switch kind {
					case "compose version":
						return "", errors.New("private compose details")
					case "legacy names":
						return `{"services":{"api":{"container_name":"haive-api","image":"api:1.2.3"}}}`, nil
					case "source build":
						return `{"services":{"api":{"container_name":"haive_desktop-api","image":"api:1.2.3","build":{"context":"."}}}}`, nil
					}
				}
				return base(ctx, exe, args, dir, log)
			}
			s, err := b.handle(context.Background(), request{Action: "install", Version: "latest", Consent: consent, Engine: "desktop-engine"})
			if err == nil {
				t.Fatal("failed install accepted")
			}
			want := fmt.Sprintf("Remove the folder %q, then install again.", b.dir)
			if s.Directory != b.dir || !strings.Contains(err.Error(), want) || strings.Contains(err.Error(), "private installer details") || strings.Contains(err.Error(), "private compose details") {
				t.Fatalf("missing recovery advice or leaked details: %v, %v", s, err)
			}
			if _, err := os.Stat(filepath.Join(b.dir, "snapshots")); err != nil {
				t.Fatal("partial files were removed", err)
			}
		})
	}
}

func TestStopSkipsBundleValidationButStartRequiresIt(t *testing.T) {
	for _, kind := range []string{"unresolvable", "legacy"} {
		t.Run(kind, func(t *testing.T) {
			b := fixture(t)
			base := b.run
			configs, stops, starts := 0, 0, 0
			b.run = func(ctx context.Context, exe string, args []string, dir string, log io.Writer) (string, error) {
				if strings.HasSuffix(strings.Join(args, " "), "config --format json") {
					configs++
					if kind == "unresolvable" {
						return "", errors.New("cannot resolve model")
					}
					return `{"services":{}}`, nil
				}
				if log != nil {
					if args[len(args)-1] == "stop" {
						stops++
					} else {
						starts++
					}
				}
				return base(ctx, exe, args, dir, log)
			}
			if _, err := b.handle(context.Background(), request{Action: "stop", Engine: "desktop-engine"}); err != nil {
				t.Fatal(err)
			}
			if configs != 0 || stops != 1 {
				t.Fatalf("stop checked bundle: configs=%d stops=%d", configs, stops)
			}
			_, err := b.handle(context.Background(), request{Action: "start", Consent: consent, Engine: "desktop-engine"})
			if err == nil {
				t.Fatal("start skipped bundle check")
			}
			if strings.Contains(err.Error(), "Remove the folder") {
				t.Fatalf("start advised removing an established install: %v", err)
			}
			if configs != 1 || starts != 0 {
				t.Fatalf("start mutated invalid bundle: configs=%d starts=%d", configs, starts)
			}
		})
	}
}

// Re-exec the test binary so runCommand's actual child environment is observed.
// The helper returns presence booleans only, never ambient environment values.
func TestRunCommandFiltersEnvironment(t *testing.T) {
	keys := []string{"HAIVE_REPO", "Haive_Repo", "Compose_File", "POSTGRES_PASSWORD", "Postgres_User", "Config_Encryption_Key", "Jwt_Secret", "Host_Repo_Root", "Mailpit_Ui_Password", "PATH", "DOCKER_HOST", "DOCKER_CONTEXT", "LANG", "HDE_TEST_KEEP"}
	if os.Getenv("HDE_ENV_HELPER") == "1" {
		present := map[string]bool{}
		for _, key := range keys {
			_, present[key] = os.LookupEnv(key)
		}
		json.NewEncoder(os.Stdout).Encode(present)
		os.Exit(0)
	}
	t.Setenv("HDE_ENV_HELPER", "1")
	for _, key := range keys {
		if key == "PATH" {
			continue
		}
		value := make([]byte, 16)
		if _, err := rand.Read(value); err != nil {
			t.Fatal(err)
		}
		t.Setenv(key, fmt.Sprintf("%x", value))
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	out, err := runCommand(context.Background(), exe, []string{"-test.run=^TestRunCommandFiltersEnvironment$"}, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	var present map[string]bool
	if err := json.Unmarshal([]byte(out), &present); err != nil {
		t.Fatal(err)
	}
	for i, key := range keys {
		want := i >= 9
		if present[key] != want {
			t.Errorf("%s present=%v; want %v", key, present[key], want)
		}
	}
}

func TestDecodeRequestTakesQuoteFreeBase64url(t *testing.T) {
	raw := `{"action":"status","version":"latest","engine":"desktop-engine","consent":""}`
	r, err := decodeRequest([]string{base64.RawURLEncoding.EncodeToString([]byte(raw))})
	if err != nil || r.Action != "status" || r.Version != "latest" || r.Engine != "desktop-engine" {
		t.Fatalf("decoded %+v, %v", r, err)
	}
	for _, args := range [][]string{
		{raw},               // raw JSON is no longer accepted
		{`{action:status}`}, // what a Windows command line leaves of raw JSON
		{},
		{"a", "b"},
	} {
		if _, err := decodeRequest(args); err == nil {
			t.Fatalf("accepted %q", args)
		}
	}
}

func TestStartPortPrecheck(t *testing.T) {
	for _, tc := range []struct{ name, project, ports, want string }{
		{"web IPv4", "dev", `{"3000/tcp":[{"HostIp":"0.0.0.0","HostPort":"3010"}]}`, "3010"},
		{"api IPv6", "dev", `{"3001/tcp":[{"HostIp":"::","HostPort":"3011"}]}`, "3011"},
		{"unlabelled app", "", `{"80/tcp":[{"HostPort":"3010"}]}`, "3010"},
		{"own project", installID, `{"3000/tcp":[{"HostPort":"3010"}]}`, ""},
		{"unpublished", "dev", `{"3010/tcp":null}`, ""},
		{"container port only", "dev", `{"3010/tcp":[{"HostPort":"9999"}]}`, ""},
		{"UDP only", "dev", `{"80/udp":[{"HostPort":"3010"}]}`, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b := fixture(t)
			base := b.run
			starts, inspections := 0, 0
			b.run = func(ctx context.Context, exe string, args []string, dir string, log io.Writer) (string, error) {
				if args[0] == "ps" {
					return fmt.Sprintf(`{"ID":%q,"Project":%q}`, strings.Repeat("a", 64), tc.project), nil
				}
				if args[0] == "container" && args[1] == "inspect" {
					inspections++
					if !strings.Contains(strings.Join(args, " "), ".NetworkSettings.Ports") {
						t.Fatal(args)
					}
					return tc.ports, nil
				}
				if log != nil {
					starts++
				}
				return base(ctx, exe, args, dir, log)
			}
			_, err := b.handle(context.Background(), request{Action: "start", Consent: consent, Engine: "desktop-engine"})
			if err != nil || starts != 1 {
				t.Fatalf("start=%d err=%v", starts, err)
			}
			selected, err := b.settings()
			if err != nil {
				t.Fatal(err)
			}
			wantWeb, wantAPI := "3010", "3011"
			if tc.want == "3010" {
				wantWeb = "3012"
			}
			if tc.want == "3011" {
				wantAPI = "3012"
			}
			if selected["HAIVE_WEB_PORT"] != wantWeb || selected["HAIVE_API_PORT"] != wantAPI {
				t.Fatal("wrong port selection")
			}
			if inspections != 1 {
				t.Fatal("bindings not inspected")
			}

		})
	}
}

func TestPortPrecheckFailsClosedAndStopSkipsIt(t *testing.T) {
	for _, kind := range []string{"list failed", "list malformed", "inspect failed", "inspect malformed"} {
		t.Run(kind, func(t *testing.T) {
			b := fixture(t)
			base := b.run
			starts, listings := 0, 0
			b.run = func(ctx context.Context, exe string, args []string, dir string, log io.Writer) (string, error) {
				if args[0] == "ps" {
					listings++
					if kind == "list failed" {
						return "", errors.New("private daemon error")
					}
					if kind == "list malformed" {
						return "bad", nil
					}
					return fmt.Sprintf(`{"ID":%q,"Project":"other"}`, strings.Repeat("a", 64)), nil
				}
				if args[0] == "container" && args[1] == "inspect" {
					if kind == "inspect failed" {
						return "", errors.New("private inspect error")
					}
					return "bad", nil
				}
				if log != nil && args[len(args)-1] != "stop" {
					starts++
				}
				return base(ctx, exe, args, dir, log)
			}
			_, err := b.handle(context.Background(), request{Action: "start", Consent: consent, Engine: "desktop-engine"})
			if err == nil || !strings.Contains(err.Error(), "published ports") || strings.Contains(err.Error(), "private") || starts != 0 {
				t.Fatalf("%v starts=%d", err, starts)
			}
			if _, err := b.handle(context.Background(), request{Action: "stop", Engine: "desktop-engine"}); err != nil {
				t.Fatal(err)
			}
			if listings != 1 {
				t.Fatal("Stop ran port precheck")
			}
		})
	}
}

func TestStartFailureReasonMapping(t *testing.T) {
	for _, tc := range []struct{ name, service, status, detail, want string }{
		{"web allocation", "web", "created", "Bind for 0.0.0.0:3010 failed: port is already allocated", "Port 3010"},
		{"api allocation", "api", "created", "port is already allocated", "Port 3011"},
		{"generic", "api", "created", "private daemon details", "Compose failed"},
		{"stale error on running container", "web", "running", "port is already allocated", "Compose failed"},
		{"unrelated service", "redis", "created", "port is already allocated", "Compose failed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b := fixture(t)
			base := b.run
			b.run = func(ctx context.Context, exe string, args []string, dir string, log io.Writer) (string, error) {
				if args[0] == "ps" {
					return "", nil
				}
				if log != nil {
					return "", errors.New("private compose failure")
				}
				if strings.HasSuffix(strings.Join(args, " "), "ps --all --format json") {
					return fmt.Sprintf(`[{"ID":%q,"Service":%q,"State":%q,"Health":"","ExitCode":0}]`, strings.Repeat("b", 64), tc.service, tc.status), nil
				}
				if args[0] == "container" && args[1] == "inspect" {
					if !strings.Contains(strings.Join(args, " "), ".State") {
						t.Fatal(args)
					}
					return fmt.Sprintf(`{"Status":%q,"Error":%q}`, tc.status, tc.detail), nil
				}
				return base(ctx, exe, args, dir, log)
			}
			s, err := b.handle(context.Background(), request{Action: "start", Consent: consent, Engine: "desktop-engine"})
			if err == nil || !strings.Contains(err.Error(), tc.want) || !strings.Contains(err.Error(), b.dir+".extension.log") || strings.Contains(err.Error(), "private") || strings.Contains(err.Error(), "Remove the folder") {
				t.Fatalf("wrong reason: %v", err)
			}
			if !s.Installed || !strings.Contains(string(s.Services), tc.service) {
				t.Fatalf("lost failure status: %+v", s)
			}
		})
	}
}

func TestRepickPreservesEnvironmentBytes(t *testing.T) {
	for _, ending := range []string{"\n", "\r\n"} {
		t.Run(fmt.Sprintf("ending-%q", ending), func(t *testing.T) {
			b := fixture(t)
			path := filepath.Join(b.dir, ".env")
			data, _ := os.ReadFile(path)
			original := strings.ReplaceAll(string(data), "\n", ending) + "# Keep every other byte: café  " + ending + "OTHER='literal $value'"
			os.WriteFile(path, []byte(original), 0600)
			os.Chmod(path, 0640)
			base := b.run
			b.run = func(ctx context.Context, exe string, args []string, dir string, log io.Writer) (string, error) {
				if args[0] == "ps" {
					return fmt.Sprintf(`{"ID":%q,"Project":"other"}`, strings.Repeat("a", 64)), nil
				}
				if args[0] == "container" && args[1] == "inspect" {
					return `{"80/tcp":[{"HostPort":"3010"},{"HostPort":"3012"},{"HostPort":"8025"}]}`, nil
				}
				return base(ctx, exe, args, dir, log)
			}
			s, err := b.handle(context.Background(), request{Action: "start", Consent: consent, Engine: "desktop-engine"})
			if err != nil {
				t.Fatal(err)
			}
			actual, _ := os.ReadFile(path)
			want := strings.Replace(original, "HAIVE_WEB_PORT=3010", "HAIVE_WEB_PORT=3013", 1)
			want = strings.Replace(want, "HAIVE_MAILPIT_PORT=8025", "HAIVE_MAILPIT_PORT=8026", 1)
			if string(actual) != want {
				t.Fatal("environment bytes changed outside selected port values, or wrong ports")
			}
			if s.AppURL != "http://localhost:3013" {
				t.Fatal("stale app URL")
			}
			encoded, _ := json.Marshal(s)
			if !strings.Contains(string(encoded), "web moved to 3013 because 3010 is in use") {
				t.Fatal("missing port move status")
			}
			info, _ := os.Stat(path)
			if info.Mode().Perm() != 0640 {
				t.Fatal("environment mode changed")
			}
		})
	}
}

func TestStatusIsAllowlistedAndProbesWeb(t *testing.T) {
	b := fixture(t)
	base := b.run
	b.run = func(ctx context.Context, exe string, args []string, dir string, log io.Writer) (string, error) {
		if strings.HasSuffix(strings.Join(args, " "), "config --format json") {
			return base(ctx, exe, args, dir, log)
		}
		return `[{"ID":"private-id","Service":"api","State":"running","Health":"","ExitCode":0,"Labels":{"private":"value"},"Mounts":["/private/path"],"Publishers":[{"URL":"0.0.0.0","TargetPort":3001,"PublishedPort":3011,"Protocol":"tcp","Extra":"private"}]},{"Service":"web","State":"running","Health":"","ExitCode":0}]`, nil
	}
	b.health = func(url string) bool { return strings.HasSuffix(url, "/health") }
	s, err := b.inspect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(s)
	if strings.Contains(string(encoded), "private") || strings.Contains(string(encoded), "Labels") || strings.Contains(string(encoded), "Mounts") || strings.Contains(string(encoded), `"ID"`) {
		t.Fatal("full Compose status leaked")
	}
	if !strings.Contains(string(encoded), `"Health":"healthy"`) || !strings.Contains(string(encoded), `"Health":"unreachable"`) {
		t.Fatal("missing extension probe results")
	}
	if s.Healthy {
		t.Fatal("unreachable web marked healthy")
	}
	var rows []map[string]json.RawMessage
	if json.Unmarshal(s.Services, &rows) != nil || len(rows) != 2 {
		t.Fatal("unexpected service payload")
	}
	want := map[string]bool{"Service": true, "State": true, "Health": true, "ExitCode": true, "Publishers": true}
	for _, row := range rows {
		if len(row) != len(want) {
			t.Fatal("unexpected per-service fields")
		}
		for key := range row {
			if !want[key] {
				t.Fatal("unapproved per-service field")
			}
		}
	}

}

func TestPortRepickOwnBindingsIgnoreHostListenerButForeignWins(t *testing.T) {
	for _, foreign := range []bool{false, true} {
		b := fixture(t)
		base := b.run
		probedOwn := false
		b.portInUse = func(port int) bool {
			if port == 3010 {
				probedOwn = true
			}
			return true
		}
		b.run = func(ctx context.Context, exe string, args []string, dir string, log io.Writer) (string, error) {
			if args[0] == "ps" {
				out := fmt.Sprintf(`{"ID":%q,"Project":%q}`, strings.Repeat("a", 64), installID)
				if foreign {
					out += "\n" + fmt.Sprintf(`{"ID":%q,"Project":"other"}`, strings.Repeat("b", 64))
				}
				return out, nil
			}
			if args[0] == "container" && args[1] == "inspect" {
				ports := `{"80/tcp":[{"HostPort":"3010"},{"HostPort":"3011"},{"HostPort":"8025"}]}`
				if foreign {
					ports += "\n" + ports
				}
				return ports, nil
			}
			return base(ctx, exe, args, dir, log)
		}
		settings, _ := b.settings()
		notice, err := b.repickPorts(context.Background(), settings, 2)
		if foreign {
			if err == nil || !strings.Contains(err.Error(), "No free port at or after 3010 after at most 2 tries") || notice != "" || probedOwn {
				t.Fatalf("foreign binding did not refuse with bounded exhaustion: %v", err)
			}
		} else if err != nil || notice != "" || probedOwn {
			t.Fatal("own-project listener treated as conflict")
		}
	}
}

func TestPortRepickHostListenersExhaustionAndPortCeiling(t *testing.T) {
	if portTries != 50 {
		t.Fatal("production bound changed")
	}
	for _, exhaustion := range []bool{false, true} {
		b := fixture(t)
		before, _ := os.ReadFile(filepath.Join(b.dir, ".env"))
		checked := []int{}
		b.portInUse = func(port int) bool { checked = append(checked, port); return exhaustion || port == 3010 }
		settings, _ := b.settings()
		_, err := b.repickPorts(context.Background(), settings, 3)
		after, _ := os.ReadFile(filepath.Join(b.dir, ".env"))
		if exhaustion {
			if err == nil || !strings.Contains(err.Error(), "No free port") || string(after) != string(before) || len(checked) > 3 {
				t.Fatal("exhaustion mutated or failed to refuse")
			}
		} else if err != nil || settings["HAIVE_WEB_PORT"] != "3012" {
			t.Fatal("host listener conflict not re-picked")
		}
	}
	b := fixture(t)
	settings, _ := b.settings()
	settings["HAIVE_WEB_PORT"] = "65535"
	b.portInUse = func(port int) bool {
		if port > 65535 {
			t.Fatal("invalid port probed")
		}
		return true
	}
	if _, err := b.repickPorts(context.Background(), settings, portTries); err == nil {
		t.Fatal("port ceiling not refused")
	}
}

func TestExhaustionRefusesBeforeComposeOrEnvironmentWrite(t *testing.T) {
	b := fixture(t)
	before, _ := os.ReadFile(filepath.Join(b.dir, ".env"))
	base := b.run
	starts := 0
	b.run = func(ctx context.Context, exe string, args []string, dir string, log io.Writer) (string, error) {
		if log != nil {
			starts++
		}
		return base(ctx, exe, args, dir, log)
	}
	// A later service exhausting must not leave an earlier service's planned move.
	b.portInUse = func(port int) bool { return port != 3012 }
	_, err := b.handle(context.Background(), request{Action: "start", Consent: consent, Engine: "desktop-engine"})
	after, _ := os.ReadFile(filepath.Join(b.dir, ".env"))
	if err == nil || starts != 0 || string(before) != string(after) {
		t.Fatal("exhaustion changed install")
	}
}

func TestEnvironmentPortRewriteRefusesAmbiguousOrLinkedAssignments(t *testing.T) {
	for _, kind := range []string{"duplicate", "missing", "linked"} {
		b := fixture(t)
		path := filepath.Join(b.dir, ".env")
		original, _ := os.ReadFile(path)
		switch kind {
		case "duplicate":
			os.WriteFile(path, append(original, []byte("HAIVE_WEB_PORT=3010\n")...), 0600)
		case "missing":
			os.WriteFile(path, []byte(strings.ReplaceAll(string(original), "HAIVE_WEB_PORT=3010\n", "")), 0600)
		case "linked":
			target := filepath.Join(b.dir, "untouched")
			os.WriteFile(target, original, 0600)
			os.Remove(path)
			os.Symlink(target, path)
		}
		before, _ := os.ReadFile(path)
		if err := b.rewritePorts(map[string]string{"HAIVE_WEB_PORT": "3012"}); err == nil {
			t.Fatal("unsafe rewrite accepted")
		}
		after, _ := os.ReadFile(path)
		if string(before) != string(after) {
			t.Fatal("refusal changed bytes")
		}
	}
}

func TestRealHostListenerProbe(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	if !hostPortInUse(port) {
		t.Fatal("host listener missed")
	}
	listener.Close()
	if hostPortInUse(port) {
		t.Fatal("released port considered busy")
	}
}

func TestHTTPProbeTreatsAppRedirectAsReachableAndHealthRequires200(t *testing.T) {
	for _, code := range []int{200, 302, 404, 503} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Location", "http://unrelated.invalid/")
			w.WriteHeader(code)
		}))
		if probeHTTP(server.URL) != (code < 400) || probeHTTP(server.URL+"/health") != (code == 200) {
			t.Error("wrong probe result", code)
		}
		server.Close()
		if probeHTTP(server.URL) {
			t.Fatal("closed app reachable")
		}
	}
}

func TestStatusIncludesMissingActiveServicesButNotInactiveProfiles(t *testing.T) {
	b := fixture(t)
	base := b.run
	b.run = func(ctx context.Context, exe string, args []string, dir string, log io.Writer) (string, error) {
		if strings.HasSuffix(strings.Join(args, " "), "config --format json") {
			return `{"services":{"api":{},"web":{},"worker":{},"optional":{"profiles":["tools"]}}}`, nil
		}
		return base(ctx, exe, args, dir, log)
	}
	s, err := b.inspect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var services []serviceStatus
	json.Unmarshal(s.Services, &services)
	missingWorker := false
	for _, service := range services {
		if service.Service == "worker" && service.State == "missing" {
			missingWorker = true
		}
		if service.Service == "optional" {
			t.Fatal("inactive profile considered required")
		}
	}
	if !missingWorker {
		t.Fatal("missing active service hidden")
	}
}

func assertNoEnvironmentTemps(t *testing.T, dir string) {
	t.Helper()
	files, err := filepath.Glob(filepath.Join(dir, ".env.extension-*"))
	if err != nil || len(files) != 0 {
		t.Fatalf("temporary environment files remain: %v %v", files, err)
	}
}

func TestEnvironmentRenameRetriesWithoutChangingOriginal(t *testing.T) {
	for _, succeeds := range []bool{false, true} {
		t.Run(fmt.Sprintf("succeeds-%v", succeeds), func(t *testing.T) {
			b := fixture(t)
			b.os = "windows"
			path := filepath.Join(b.dir, ".env")
			original, _ := os.ReadFile(path)
			calls, sleeps := 0, 0
			b.sleep = func(delay time.Duration) {
				sleeps++
				if delay <= 0 || delay > 200*time.Millisecond {
					t.Fatal("retry sleep is not short")
				}
			}
			b.rename = func(from, to string) error {
				calls++
				current, _ := os.ReadFile(path)
				if !bytes.Equal(current, original) {
					t.Fatal("original changed between rename tries")
				}
				if succeeds && calls == 3 {
					return os.Rename(from, to)
				}
				return os.ErrPermission
			}
			err := b.rewritePorts(map[string]string{"HAIVE_WEB_PORT": "3012"})
			if succeeds {
				if err != nil || calls != 3 || sleeps != 2 {
					t.Fatalf("retry did not succeed: calls=%d sleeps=%d err=%v", calls, sleeps, err)
				}
			} else {
				current, _ := os.ReadFile(path)
				if err == nil || calls != 4 || sleeps != 3 || !bytes.Equal(current, original) {
					t.Fatalf("retry not bounded or changed original: calls=%d sleeps=%d err=%v", calls, sleeps, err)
				}
			}
			assertNoEnvironmentTemps(t, b.dir)
		})
	}
}

func TestEnvironmentRewriteRefusesChangedBytesAndCleansTemp(t *testing.T) {
	for _, duringRetry := range []bool{false, true} {
		b := fixture(t)
		b.os = "windows"
		path := filepath.Join(b.dir, ".env")
		original, _ := os.ReadFile(path)
		edited := append(bytes.Clone(original), []byte("# manual edit\n")...)
		reads, renames := 0, 0
		b.readEnv = func(name string) ([]byte, error) {
			reads++
			if reads == 2 && !duringRetry {
				os.WriteFile(path, edited, 0600)
			}
			return os.ReadFile(name)
		}
		b.rename = func(string, string) error { renames++; return os.ErrPermission }
		b.sleep = func(time.Duration) { os.WriteFile(path, edited, 0600) }
		err := b.rewritePorts(map[string]string{"HAIVE_WEB_PORT": "3012"})
		current, _ := os.ReadFile(path)
		wantRenames := 0
		if duringRetry {
			wantRenames = 1
		}
		if err == nil || !bytes.Equal(current, edited) || renames != wantRenames {
			t.Fatalf("concurrent edit not preserved: renames=%d err=%v", renames, err)
		}
		assertNoEnvironmentTemps(t, b.dir)
	}
}

func TestEnvironmentPortAssignmentLastWithoutNewline(t *testing.T) {
	for _, ending := range []string{"\n", "\r\n"} {
		b := fixture(t)
		path := filepath.Join(b.dir, ".env")
		original := "# Keep café" + ending + "OTHER='literal $value'" + ending + " \tHAIVE_WEB_PORT=3010 \t"
		if err := os.WriteFile(path, []byte(original), 0600); err != nil {
			t.Fatal(err)
		}
		if err := b.rewritePorts(map[string]string{"HAIVE_WEB_PORT": "3012"}); err != nil {
			t.Fatal(err)
		}
		current, _ := os.ReadFile(path)
		if string(current) != strings.Replace(original, "3010", "3012", 1) {
			t.Fatal("last assignment bytes changed")
		}
		assertNoEnvironmentTemps(t, b.dir)
	}
}

func TestIPv6UnavailableDoesNotConflictAfterIPv4Passes(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		busy bool
	}{
		{"unsupported", syscall.EAFNOSUPPORT, false},
		{"unavailable", &net.AddrError{Err: "family unavailable", Addr: "::"}, false},
		{"unexpected family error", errors.New("IPv6 unavailable"), false},
		{"bind conflict", addressInUse, true},
		{"access denied", os.ErrPermission, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			busy := hostPortInUseWithListen(3010, func(network, address string) (net.Listener, error) {
				calls++
				if network == "tcp4" {
					return &probeListener{}, nil
				}
				return nil, &net.OpError{Op: "listen", Net: network, Err: &os.SyscallError{Syscall: "bind", Err: tc.err}}
			})
			if busy != tc.busy || calls != 2 {
				t.Fatalf("busy=%v calls=%d", busy, calls)
			}
		})
	}
	if !hostPortInUseWithListen(3010, func(string, string) (net.Listener, error) { return nil, errors.New("IPv4 failed") }) {
		t.Fatal("IPv4 failure must refuse")
	}
}

type probeListener struct{}

func (*probeListener) Accept() (net.Conn, error) { return nil, errors.New("unused") }
func (*probeListener) Close() error              { return nil }
func (*probeListener) Addr() net.Addr            { return &net.TCPAddr{} }

func TestPublishedPortsInspectsAllRunningContainersTogether(t *testing.T) {
	b := fixture(t)
	inspections := 0
	ids := []string{strings.Repeat("a", 64), strings.Repeat("b", 64)}
	b.run = func(_ context.Context, _ string, args []string, _ string, _ io.Writer) (string, error) {
		if args[0] == "ps" {
			return fmt.Sprintf(`{"ID":%q,"Project":%q}`+"\n"+`{"ID":%q,"Project":"other"}`, ids[0], installID, ids[1]), nil
		}
		inspections++
		if args[0] != "container" || args[1] != "inspect" || !reflect.DeepEqual(args[len(args)-2:], ids) {
			t.Fatalf("not one inspect for both ids: %q", args)
		}
		return `{"80/tcp":[{"HostPort":"3010"}]}` + "\n" + `{"80/tcp":[{"HostPort":"3011"}]}`, nil
	}
	foreign, own, err := b.publishedPorts(context.Background())
	if err != nil || inspections != 1 || !own[3010] || !foreign[3011] || own[3011] || foreign[3010] {
		t.Fatalf("bindings lost or misattributed: own=%v foreign=%v inspections=%d err=%v", own, foreign, inspections, err)
	}
}

func TestStatusAndStopDoNotRequireMailpitPort(t *testing.T) {
	for _, value := range []string{"", "HAIVE_MAILPIT_PORT=invalid\n"} {
		b := fixture(t)
		path := filepath.Join(b.dir, ".env")
		original, _ := os.ReadFile(path)
		os.WriteFile(path, []byte(strings.Replace(string(original), "HAIVE_MAILPIT_PORT=8025\n", value, 1)), 0600)
		for _, action := range []string{"status", "stop"} {
			if _, err := b.handle(context.Background(), request{Action: action, Engine: "desktop-engine"}); err != nil {
				t.Fatalf("%s required mailpit port: %v", action, err)
			}
		}
	}
	b := fixture(t)
	path := filepath.Join(b.dir, ".env")
	original, _ := os.ReadFile(path)
	os.WriteFile(path, []byte(strings.Replace(string(original), "HAIVE_MAILPIT_PORT=8025\n", "", 1)), 0600)
	settings, err := b.settings()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = b.repickPorts(context.Background(), settings, portTries); err != nil || settings["HAIVE_MAILPIT_PORT"] != "8025" {
		t.Fatalf("missing Mailpit port did not default for Start: %v", err)
	}
}

// Exercise the Docker template against the same structural Config/State fields
// shipped by the updater image and both the API and generated host launchers.
func TestUpgradeFence(t *testing.T) {
	for _, tc := range []struct {
		name       string
		entrypoint []string
		env        []string
		running    bool
		failure    string
		refuse     bool
	}{
		{name: "API updater", entrypoint: []string{"node", "packages/updater/dist/cli.js"}, env: []string{"COMPOSE_PROJECT_NAME=" + installID, "HAIVE_INSTALL_ID=" + installID}, running: true, refuse: true},
		{name: "host helper updater", entrypoint: []string{"node", "packages/updater/dist/cli.js"}, env: []string{"HAIVE_INSTALL_ID=" + installID}, running: true, refuse: true},
		{name: "project identity", entrypoint: []string{"node", "packages/updater/dist/cli.js"}, env: []string{"COMPOSE_PROJECT_NAME=" + installID}, running: true, refuse: true},
		{name: "other install", entrypoint: []string{"node", "packages/updater/dist/cli.js"}, env: []string{"HAIVE_INSTALL_ID=other", "COMPOSE_PROJECT_NAME=other"}, running: true},
		{name: "prefix is another install", entrypoint: []string{"node", "packages/updater/dist/cli.js"}, env: []string{"HAIVE_INSTALL_ID=" + installID + "_other"}, running: true},
		{name: "own API", entrypoint: []string{"node", "packages/api/dist/index.js"}, env: []string{"HAIVE_INSTALL_ID=" + installID}, running: true},
		{name: "stopped updater", entrypoint: []string{"node", "packages/updater/dist/cli.js"}, env: []string{"HAIVE_INSTALL_ID=" + installID}, running: false},
		{name: "no entrypoint in own container", env: []string{"HAIVE_INSTALL_ID=" + installID}, running: true},
		{name: "different updater command", entrypoint: []string{"node", "packages/updater/dist/recover-admin-cli.js"}, env: []string{"HAIVE_INSTALL_ID=" + installID}, running: true},
		{name: "unscoped updater", entrypoint: []string{"node", "packages/updater/dist/cli.js"}, running: true},
		{name: "no containers"},
		{name: "listing error", failure: "list", refuse: true},
		{name: "invalid ID", failure: "id", refuse: true},
		{name: "inspection error", failure: "inspect", refuse: true},
		{name: "malformed inspection", failure: "json", refuse: true},
		{name: "missing inspection", failure: "missing", refuse: true},
		{name: "extra inspection", failure: "extra", refuse: true},
	} {
		for _, action := range []string{"start", "stop", "install"} {
			t.Run(tc.name+"/"+action, func(t *testing.T) {
				b := fixture(t)
				envPath := filepath.Join(b.dir, ".env")
				original, _ := os.ReadFile(envPath)
				if action == "install" {
					os.Remove(envPath)
				}
				base := b.run
				checks, mutations, compose := 0, 0, 0
				b.run = func(ctx context.Context, exe string, args []string, dir string, log io.Writer) (string, error) {
					if exe == "docker" && reflect.DeepEqual(args, []string{"container", "ls", "--no-trunc", "--format", "{{.ID}}"}) {
						checks++
						if tc.failure == "list" {
							return "", errors.New("private failure")
						}
						if tc.failure == "id" {
							return "invalid ID", nil
						}
						if tc.name == "no containers" {
							return "", nil
						}
						return strings.Repeat("a", 64) + "\n" + strings.Repeat("b", 64) + "\n", nil
					}
					if exe == "docker" && len(args) > 1 && args[0] == "container" && args[1] == "inspect" {
						if len(args) != 6 || args[2] != "--format" || args[4] != strings.Repeat("a", 64) || args[5] != strings.Repeat("b", 64) {
							t.Fatalf("not one batched inspection: %q", args)
						}
						if tc.failure == "inspect" {
							return "", errors.New("private inspection failure")
						}
						if tc.failure == "json" {
							return "garbage", nil
						}
						if tc.failure == "missing" {
							return "false\n", nil
						}
						if tc.failure == "extra" {
							return "false\nfalse\nfalse\n", nil
						}
						tmpl, err := template.New("inspect").Parse(args[3])
						if err != nil {
							t.Fatal(err)
						}
						data := map[string]any{
							"State":  map[string]any{"Running": tc.running},
							"Config": map[string]any{"Entrypoint": tc.entrypoint, "Env": append(tc.env, "CONFIG_ENCRYPTION_KEY=private-value")},
						}
						var out strings.Builder
						if err := tmpl.Execute(&out, data); err != nil {
							t.Fatal(err)
						}
						if strings.Contains(out.String(), "private-value") {
							t.Fatal("inspection leaked env")
						}
						return "false\n" + out.String() + "\n", nil
					}
					if exe == "docker" && args[0] == "compose" {
						compose++
					}
					if log != nil {
						mutations++
						if exe == "sh" {
							return "", os.WriteFile(envPath, original, 0600)
						}
					}
					return base(ctx, exe, args, dir, log)
				}
				_, err := b.handle(context.Background(), request{Action: action, Version: "latest", Consent: consent, Engine: "desktop-engine"})
				if tc.refuse {
					want := "Cannot check whether an upgrade is running"
					if tc.failure == "" {
						want = "An upgrade is running for this Haive Desktop install"
					}
					if err == nil || !strings.Contains(err.Error(), want) || strings.Contains(err.Error(), "private") {
						t.Fatalf("wanted safe upgrade refusal, got %v", err)
					}
					if compose != 0 || mutations != 0 {
						t.Fatalf("refusal reached compose=%d mutations=%d", compose, mutations)
					}
					after, readErr := os.ReadFile(envPath)
					if action == "install" {
						if !errors.Is(readErr, os.ErrNotExist) {
							t.Fatal("refused install wrote .env")
						}
					} else if string(after) != string(original) {
						t.Fatal("refusal changed .env")
					}
				} else if err != nil || mutations != 1 {
					t.Fatalf("absent updater changed behavior: mutations=%d err=%v", mutations, err)
				}
				if checks == 0 {
					t.Fatal("upgrade check was skipped")
				}
			})
		}
	}
}

func TestUpgradeRecheckedBeforeServiceMutation(t *testing.T) {
	for _, action := range []string{"start", "stop"} {
		t.Run(action, func(t *testing.T) {
			b := fixture(t)
			base := b.run
			checks, mutations := 0, 0
			b.run = func(ctx context.Context, exe string, args []string, dir string, log io.Writer) (string, error) {
				if reflect.DeepEqual(args, []string{"container", "ls", "--no-trunc", "--format", "{{.ID}}"}) {
					checks++
					if checks == 1 {
						return "", nil
					}
					return strings.Repeat("a", 64), nil
				}
				if args[0] == "container" && args[1] == "inspect" {
					return "true", nil
				}
				if log != nil {
					mutations++
				}
				return base(ctx, exe, args, dir, log)
			}
			_, err := b.handle(context.Background(), request{Action: action, Consent: consent, Engine: "desktop-engine"})
			if checks != 2 || mutations != 0 || err == nil || !strings.Contains(err.Error(), "An upgrade is running") {
				t.Fatalf("late updater was not fenced: checks=%d mutations=%d err=%v", checks, mutations, err)
			}
		})
	}
}
