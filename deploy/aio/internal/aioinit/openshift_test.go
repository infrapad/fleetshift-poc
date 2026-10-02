package aioinit_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/fleetshift/fleetshift-poc/deploy/aio/internal/aioinit"
)

func TestDexModesAndPersistedState(t *testing.T) {
	for _, tc := range []struct {
		mode, issuer, want string
		fail               bool
	}{
		{"", "", "demo", false},
		{"", "https://issuer.example", "external", false},
		{"openshift", "", "openshift", false},
		{"demo", "https://issuer.example", "", true},
		{"openshift", "https://issuer.example", "", true},
		{"typo", "", "", true},
	} {
		got, err := aioinit.ResolveDexMode(tc.mode, tc.issuer)
		if (err != nil) != tc.fail || got != tc.want {
			t.Fatalf("mode %q issuer %q: %q, %v", tc.mode, tc.issuer, got, err)
		}
	}
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "sandbox"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := aioinit.CheckAuthMode(root, "demo"); err != nil {
		t.Fatal(err)
	}
	if err := aioinit.CheckAuthMode(root, "openshift"); err == nil || !strings.Contains(err.Error(), "fresh separate") {
		t.Fatalf("switching demo state: %v", err)
	}
	fresh := t.TempDir()
	if err := os.MkdirAll(filepath.Join(fresh, "sandbox"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(fresh, "fleetshift.db"), []byte("old"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := aioinit.CheckAuthMode(fresh, "openshift"); err == nil {
		t.Fatal("old unmarked database accepted")
	}
	if err := os.Remove(filepath.Join(fresh, "fleetshift.db")); err != nil {
		t.Fatal(err)
	}
	if err := aioinit.CheckAuthMode(fresh, "openshift"); err != nil {
		t.Fatal(err)
	}
	if err := aioinit.CheckAuthMode(fresh, "openshift"); err != nil {
		t.Fatal(err)
	}
	if err := aioinit.CheckAuthMode(fresh, "demo"); err == nil {
		t.Fatal("switching back accepted")
	}
}
