package aioinit

import (
	"bytes"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"strings"
)

// OpenShiftConnector contains the validated host-side OAuth registration for
// peer Dex. It is never passed to fleetshift serve or public.env.
type OpenShiftConnector struct {
	APIURL       string `json:"apiURL"`
	ClientID     string `json:"clientID"`
	ClientSecret string `json:"clientSecret"`
	CAFile       string `json:"caFile"`
	RootCA       string `json:"-"`
}

// LoadOpenShiftConnector reads the private, read-only host mount. Never include
// its contents (or JSON decoder errors containing them) in returned errors.
func LoadOpenShiftConnector(path string) (*OpenShiftConnector, error) {
	if path == "" {
		return nil, fmt.Errorf("OpenShift Dex requires OPENSHIFT_DEX_CONFIG_FILE")
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("OpenShift Dex config mount is missing or unreadable")
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		return nil, fmt.Errorf("OpenShift Dex config must be a private regular file (mode 0600)")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("cannot read OpenShift Dex config mount")
	}
	var c OpenShiftConnector
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&c); err != nil {
		return nil, fmt.Errorf("invalid OpenShift Dex config JSON")
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return nil, fmt.Errorf("OpenShift Dex config contains extra or invalid JSON")
	}
	u, err := url.Parse(c.APIURL)
	if err != nil || u == nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || strings.HasSuffix(c.APIURL, "/") {
		return nil, fmt.Errorf("OpenShift Dex apiURL must be an HTTPS API origin without a path")
	}
	parts := strings.Split(c.ClientID, ":")
	if len(parts) != 4 || parts[0] != "system" || parts[1] != "serviceaccount" || parts[2] == "" || parts[3] == "" || strings.TrimSpace(c.ClientSecret) == "" || c.CAFile == "" || strings.ContainsAny(c.ClientID+c.ClientSecret, "\r\n") {
		return nil, fmt.Errorf("OpenShift Dex requires clientID, clientSecret and caFile")
	}
	ca, err := os.ReadFile(c.CAFile)
	if err != nil {
		return nil, fmt.Errorf("OpenShift Dex CA mount is missing or unreadable")
	}
	if !x509.NewCertPool().AppendCertsFromPEM(ca) {
		return nil, fmt.Errorf("OpenShift Dex CA must contain PEM certificates")
	}
	// Dex accepts base64 PEM as rootCA. Embed it in the Dex-only 0600 config
	// so the unprivileged Dex process need not traverse the private host mount.
	c.RootCA = base64.StdEncoding.EncodeToString(ca)
	return &c, nil
}

// ResolveDexMode separates demo, OpenShift-backed peer Dex, and external OIDC.
func ResolveDexMode(mode, issuer string) (string, error) {
	switch mode {
	case "":
		if strings.TrimSpace(issuer) != "" {
			return "external", nil
		}
		return "demo", nil
	case "demo":
		if strings.TrimSpace(issuer) != "" {
			return "", fmt.Errorf("OPENSHIFT_DEX_MODE=demo conflicts with OIDC_ISSUER_URL")
		}
		return "demo", nil
	case "openshift":
		if strings.TrimSpace(issuer) != "" {
			return "", fmt.Errorf("OPENSHIFT_DEX_MODE=openshift conflicts with OIDC_ISSUER_URL")
		}
		return "openshift", nil
	default:
		return "", fmt.Errorf("invalid OPENSHIFT_DEX_MODE (use openshift or omit it)")
	}
}

// CheckAuthMode prevents reuse of a persisted login state with a different
// identity source. In particular an old, unmarked AIO database is not fresh.
func CheckAuthMode(dataDir, mode string) error {
	marker := dataDir + "/sandbox/auth-mode"
	old, err := os.ReadFile(marker)
	if err == nil {
		if strings.TrimSpace(string(old)) != mode && (mode == "openshift" || strings.TrimSpace(string(old)) == "openshift") {
			return fmt.Errorf("AIO auth mode changed: use a fresh separate /data volume for OpenShift-backed login")
		}
		return nil
	}
	if !os.IsNotExist(err) {
		return fmt.Errorf("read AIO auth mode: %w", err)
	}
	if mode == "openshift" {
		for _, name := range []string{"fleetshift.db", "sandbox/dex/dex.db"} {
			if _, err := os.Stat(dataDir + "/" + name); err == nil {
				return fmt.Errorf("OpenShift-backed login requires a fresh separate /data volume")
			} else if !os.IsNotExist(err) {
				return err
			}
		}
	}
	return os.WriteFile(marker, []byte(mode+"\n"), 0644)
}
