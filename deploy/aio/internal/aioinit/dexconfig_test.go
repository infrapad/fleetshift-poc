package aioinit_test

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/fleetshift/fleetshift-poc/deploy/aio/internal/aioinit"
)

func TestInstallDexConfig(t *testing.T) {
	t.Parallel()
	body := installTestDexConfig(t, "error")
	for _, want := range []string{
		"issuer: https://fleetshift-sandbox.localhost:8085/idp",
		"http: 127.0.0.1:5556",
		"preferredUsername: \"dev-user\"",
		"id: fleetshift-ui",
		"id: fleetshift-cli",
		"id: fleetshift-signing",
		"https://fleetshift-sandbox.localhost:8085/app/auth/callback",
		"https://fleetshift-sandbox.localhost:8085/app/silent-renew.html",
		"level: \"error\"",
		"format: \"text\"",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("config missing %q\n%s", want, body)
		}
	}
	for _, bad := range []string{
		"tlsCert:",
		"tlsKey:",
		"allowedOrigins:",
		"fleetshift-ops",
		"fleetshift-dev",
	} {
		if strings.Contains(body, bad) {
			t.Fatalf("config unexpectedly contains %q\n%s", bad, body)
		}
	}
	if strings.Contains(body, "web:\n  https:") || strings.Contains(body, "web:\r\n  https:") {
		t.Fatalf("peer Dex must listen on HTTP, not HTTPS:\n%s", body)
	}
	if !strings.Contains(body, "$2") {
		t.Fatal("expected bcrypt hashes in config")
	}
}

func TestInstallDexConfig_OpenShift(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	input := filepath.Join(root, "connector.json")
	ca := filepath.Join(root, "cluster.crt")
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.CreateCertificate(rand.Reader, &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "test CA"}, IsCA: true, BasicConstraintsValid: true}, &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "test CA"}, IsCA: true, BasicConstraintsValid: true}, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert}), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(input, []byte(`{"apiURL":"https://api.example.test:6443","clientID":"system:serviceaccount:default:fleetshift-dex","clientSecret":"my-private-secret","caFile":"`+ca+`"}`), 0600); err != nil {
		t.Fatal(err)
	}
	connector, err := aioinit.LoadOpenShiftConnector(input)
	if err != nil {
		t.Fatal(err)
	}
	paths := aioinit.DexPaths{ConfigDir: filepath.Join(root, "dex"), ConfigPath: filepath.Join(root, "dex/config.yaml"), DBPath: filepath.Join(root, "dex/dex.db")}
	if err := aioinit.InstallDexConfig(aioinit.DexRenderInput{Issuer: aioinit.PeerDexIssuer, Endpoints: aioinit.FixedEndpoints, LogLevel: "error", OpenShift: connector}, paths, os.Getuid(), os.Getgid()); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(paths.ConfigPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"type: openshift", `issuer: "https://api.example.test:6443"`, `clientID: "system:serviceaccount:default:fleetshift-dex"`, `clientSecret: "my-private-secret"`, `redirectURI: "https://fleetshift-sandbox.localhost:8085/idp/callback"`, "rootCA: \"" + base64.StdEncoding.EncodeToString(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert})) + "\"", "id: fleetshift-ui"} {
		if !strings.Contains(string(body), want) {
			t.Fatalf("missing %q", want)
		}
	}
	for _, bad := range []string{"passwordConnector", "enablePasswordDB", "staticPasswords", "ops@fleetshift.local", "insecureCA"} {
		if strings.Contains(string(body), bad) {
			t.Fatalf("unexpected %q", bad)
		}
	}
	info, err := os.Stat(paths.ConfigPath)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("config permissions: %v %v", info, err)
	}
}

func TestLoadOpenShiftConnector_RejectsInvalidInput(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	for name, body := range map[string]string{
		"missing":   "",
		"no secret": `{"apiURL":"https://api.example.test:6443","clientID":"x","caFile":"/missing"}`,
		"http":      `{"apiURL":"http://api.example.test","clientID":"x","clientSecret":"secret","caFile":"/missing"}`,
		"extra":     `{"apiURL":"https://api.example.test","clientID":"x","clientSecret":"secret","caFile":"/missing","insecureCA":true}`,
	} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(root, name)
			if body != "" {
				if err := os.WriteFile(path, []byte(body), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := aioinit.LoadOpenShiftConnector(path); err == nil {
				t.Fatal("expected invalid input to fail")
			}
		})
	}
}

func TestInstallDexConfig_LogLevel(t *testing.T) {
	t.Parallel()
	for _, level := range []string{"debug", "warn"} {
		t.Run(level, func(t *testing.T) {
			t.Parallel()
			body := installTestDexConfig(t, level)
			want := `level: "` + level + `"`
			if !strings.Contains(body, want) {
				t.Fatalf("missing %q\n%s", want, body)
			}
			if strings.Contains(body, `level: "error"`) {
				t.Fatalf("%s LOG_LEVEL must not leave the error logger default:\n%s", level, body)
			}
		})
	}
}

func TestInstallDexConfig_ConfigDirIsFile(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	notDir := filepath.Join(root, "not-a-dir")
	if err := os.WriteFile(notDir, []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	err := aioinit.InstallDexConfig(aioinit.DexRenderInput{
		Issuer:    aioinit.PeerDexIssuer,
		Endpoints: aioinit.FixedEndpoints,
		LogLevel:  "error",
	}, aioinit.DexPaths{
		ConfigDir:  notDir,
		ConfigPath: filepath.Join(notDir, "config.yaml"),
		DBPath:     filepath.Join(notDir, "dex.db"),
	}, os.Getuid(), os.Getgid())
	if err == nil {
		t.Fatal("InstallDexConfig: expected error when ConfigDir is a file")
	}
}

func installTestDexConfig(t *testing.T, logLevel string) string {
	t.Helper()
	root := t.TempDir()
	paths := aioinit.DexPaths{
		ConfigDir:  filepath.Join(root, "dex"),
		ConfigPath: filepath.Join(root, "dex", "config.yaml"),
		DBPath:     filepath.Join(root, "dex", "dex.db"),
	}
	err := aioinit.InstallDexConfig(aioinit.DexRenderInput{
		Issuer:    aioinit.PeerDexIssuer,
		Endpoints: aioinit.FixedEndpoints,
		LogLevel:  logLevel,
	}, paths, os.Getuid(), os.Getgid())
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(paths.ConfigPath)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}
