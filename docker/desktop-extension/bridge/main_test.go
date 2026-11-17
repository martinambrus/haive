package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func fixture(t *testing.T) bridge {
	t.Helper()
	dir := filepath.Join(t.TempDir(), installID)
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	for name, data := range map[string]string{
		".env":               "HAIVE_INSTALL_ID=" + installID + "\nCOMPOSE_PROJECT_NAME=" + installID + "\nHAIVE_VERSION=1.2.3\nHAIVE_WEB_PORT=3010\nHAIVE_API_PORT=3011\n",
		"docker-compose.yml": "services: {}", "docker-compose.run.yml": "services: {}",
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
	}
	return bridge{dir: dir, os: "linux", health: func(string) bool { return true }, run: func(_ context.Context, _ string, args []string, _ string, _ io.Writer) (string, error) {
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
		{"web only", `{"Service":"web","State":"running"}`, true, false, false},
		{"exited web", `[{"Service":"api","State":"running"},{"Service":"web","State":"exited"}]`, true, true, false},
		{"failed health", `[{"Service":"api","State":"running"},{"Service":"web","State":"running"}]`, false, true, false},
	} {
		b := fixture(t)
		b.run = func(context.Context, string, []string, string, io.Writer) (string, error) { return tc.output, nil }
		probed := false
		b.health = func(url string) bool {
			probed = true
			if url != "http://localhost:3011/health" {
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
