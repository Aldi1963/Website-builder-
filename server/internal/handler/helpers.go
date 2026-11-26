package handler

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/smtp"
	"time"
)

func randRead(b []byte) {
	rand.Read(b)
}

func randHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func sha256Hex(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

func jsonMarshal(v interface{}) ([]byte, error) {
	return json.Marshal(v)
}

func httpNewRequest(method, url string, body []byte) (*http.Request, error) {
	var r io.Reader
	if body != nil {
		r = bytes.NewReader(body)
	}
	return http.NewRequest(method, url, r)
}

func httpClient() *http.Client {
	return &http.Client{Timeout: 10 * time.Second}
}

func smtpPlainAuth(identity, username, password, host string) smtp.Auth {
	return smtp.PlainAuth(identity, username, password, host)
}

func smtpSend(addr string, auth smtp.Auth, from string, to []string, msg []byte) error {
	return smtp.SendMail(addr, auth, from, to, msg)
}
