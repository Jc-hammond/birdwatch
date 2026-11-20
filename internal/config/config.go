package config

import (
	"flag"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
)

type Config struct {
	Host      string
	Port      int
	DB        string
	Password  string
	NoDemo    bool
	BackupDir string
	Domain    string
}

func env(name, fallback string) string {
	if value, ok := os.LookupEnv("BIRDWATCH_" + name); ok {
		return value
	}
	return fallback
}

func DatabasePath() string { return env("DB", "data/birdwatch.sqlite3") }

func Parse(args []string) (Config, error) {
	c := Config{Password: os.Getenv("BIRDWATCH_PASSWORD")}
	flags := flag.NewFlagSet("birdwatch", flag.ContinueOnError)
	flags.StringVar(&c.Domain, "domain", env("DOMAIN", ""), "serve HTTPS on ports 443 and 80 for this domain; accepts the certificate authority terms of service")
	flags.StringVar(&c.Host, "host", env("HOST", "127.0.0.1"), "address to listen on")
	port := flags.String("port", env("PORT", "8123"), "port to listen on")
	flags.StringVar(&c.DB, "db", DatabasePath(), "SQLite database path")
	flags.StringVar(&c.BackupDir, "backup-dir", env("BACKUP_DIR", ""), "directory for daily backups")
	flags.BoolVar(&c.NoDemo, "no-demo", false, "start without the sample project")
	if err := flags.Parse(args); err != nil {
		return c, err
	}
	if flags.NArg() != 0 {
		return c, fmt.Errorf("unexpected positional argument")
	}
	var err error
	c.Port, err = strconv.Atoi(*port)
	if err != nil || c.Port < 0 || c.Port > 65535 {
		return c, fmt.Errorf("port must be an integer between 0 and 65535")
	}
	if c.Domain != "" {
		if c.Password == "" {
			return c, fmt.Errorf("set BIRDWATCH_PASSWORD before using --domain")
		}
		c.Domain = strings.ToLower(strings.TrimSuffix(c.Domain, "."))
		if !validDomain(c.Domain) {
			return c, fmt.Errorf("domain must be one DNS hostname, such as analytics.example.com")
		}
	}
	// Bind a concrete loopback address even if the host resolver was customized.
	if c.Host == "localhost" {
		c.Host = "127.0.0.1"
	}
	if c.Password == "" && !net.ParseIP(c.Host).IsLoopback() {
		return c, fmt.Errorf("set BIRDWATCH_PASSWORD before binding to a non-loopback address")
	}
	return c, nil
}

func validDomain(name string) bool {
	if len(name) > 253 || !strings.Contains(name, ".") || net.ParseIP(name) != nil {
		return false
	}
	for _, label := range strings.Split(name, ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, ch := range label {
			if !(ch >= 'a' && ch <= 'z' || ch >= '0' && ch <= '9' || ch == '-') {
				return false
			}
		}
	}
	return true
}
